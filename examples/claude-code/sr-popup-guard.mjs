#!/usr/bin/env node
// Claude Code PreToolUse hook: keep edits to your flashcard notes from
// colliding with a card that is open in the SR Popup Review popup.
//
// Zero dependencies. Register it in .claude/settings.json (see the README,
// "Working with external tools"). It reads the hook payload from stdin, asks
// Obsidian's CLI (`sr-popup-review:check` / `:state`), and either lets the tool
// call through (prints nothing, exit 0) or denies it with a reason.
//
// Environment:
//   SRPR_VAULT_ROOT  Absolute path of the vault (required; without it the hook does nothing).
//   SRPR_VAULT_NAME  Vault name, passed as `vault=<name>` (optional; needed when several vaults are open).
//
// Fail-safe: if the CLI fails or answers something unparseable, the edit is
// denied (e.g. Obsidian is not running). Only .md files under SRPR_VAULT_ROOT
// are checked; everything else is allowed.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";

const REASON_BUSY =
    "The SR Popup Review popup is grading a card right now. Close the popup, then redo the same edit.";
const REASON_UNSURE =
    "Could not confirm that this edit is safe while the SR Popup Review popup may be open " +
    "(Obsidian not running, CLI disabled, or unreadable answer). Close the popup, then redo the same edit.";

function deny(reason) {
    process.stdout.write(
        JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: reason,
            },
        }),
    );
    process.exit(0);
}

function allow() {
    process.exit(0);
}

/** Escape a value for the CLI: \ -> \, LF -> \n, TAB -> \t, CR -> \r (CRLF is treated as LF first). */
function escapeCliValue(s) {
    return s
        .replace(/\r\n/g, "\n")
        .replace(/\\/g, "\\\\")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t")
        .replace(/\r/g, "\\r");
}

/** Run an Obsidian CLI command and parse its JSON answer; throws on any failure. */
function runCli(args) {
    const vaultName = process.env.SRPR_VAULT_NAME;
    const full = vaultName ? [`vault=${vaultName}`, ...args] : args;
    let out;
    // Test hook: lets a test stand in for Obsidian ("FAIL" simulates a failing command).
    if (process.env.SRPR_FAKE_CLI !== undefined) {
        if (process.env.SRPR_FAKE_CLI_LOG) appendFileSync(process.env.SRPR_FAKE_CLI_LOG, JSON.stringify(full) + "\n");
        if (process.env.SRPR_FAKE_CLI === "FAIL") throw new Error("fake CLI failure");
        out = process.env.SRPR_FAKE_CLI;
    } else {
        // No shell: arguments reach the CLI untouched. On Windows the .com
        // launcher is needed; plain "obsidian" resolves to the GUI executable.
        const bin = process.platform === "win32" ? "obsidian.com" : "obsidian";
        out = execFileSync(bin, full, { encoding: "utf8", timeout: 7000 });
    }
    // The CLI may print other lines around the JSON answer.
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("no JSON in CLI output");
    return JSON.parse(out.slice(start, end + 1));
}

let payload;
try {
    payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
    allow(); // Not a hook payload we understand: not our business.
}

const root = process.env.SRPR_VAULT_ROOT;
const tool = payload?.tool_name;
const input = payload?.tool_input ?? {};
if (!root || (tool !== "Edit" && tool !== "Write") || typeof input.file_path !== "string") allow();

const rel = path.relative(path.resolve(root), path.resolve(input.file_path));
if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel) || !rel.toLowerCase().endsWith(".md")) allow();
const notePath = rel.split(path.sep).join("/");

try {
    if (tool === "Edit" && input.replace_all !== true) {
        if (typeof input.old_string !== "string") allow();
        const args = [
            "sr-popup-review:check",
            `path=${notePath}`, // the plugin takes path as-is (only old/new are unescaped)
            `old=${escapeCliValue(input.old_string)}`,
            `new=${escapeCliValue(typeof input.new_string === "string" ? input.new_string : "")}`,
        ];
        const answer = runCli(args);
        if (answer.result === "safe") allow();
        deny(`${REASON_BUSY} (check said: ${String(answer.reason)})`);
    } else {
        // Write and replace_all Edit rewrite more than one spot: only the card state decides.
        const answer = runCli(["sr-popup-review:state"]);
        if (answer.state === "idle") allow();
        const sameNote = typeof answer.path === "string" && answer.path.toLowerCase() === notePath.toLowerCase();
        if (answer.state === "preparing" || answer.state === "writing" || sameNote) deny(REASON_BUSY);
        // A different note is open (an unidentified card has no path: treat as unsure).
        if (answer.state === "showing" && typeof answer.path === "string") allow();
        deny(REASON_UNSURE);
    }
} catch {
    deny(REASON_UNSURE);
}
