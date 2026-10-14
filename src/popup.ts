import { App, Component, MarkdownRenderer, Notice } from "obsidian";
import { IntervalPreview, RateOutcome, RatingKey, ReviewResponse, ReviewResponseValue, ReviewSession } from "./sr-bridge";
import type { GlobalShortcutLike } from "./global-shortcut";
import type { ReviewStateTracker } from "./review-state";
import { t } from "./i18n";

// ---------------------------------------------------------------------------
// Structural types for the Electron pieces this plugin touches via
// @electron/remote. Every member is optional and guarded before use, because
// the remote bridge differs across Obsidian/Electron versions.
// ---------------------------------------------------------------------------

interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface WebContentsLike {
    executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
}

interface BrowserWindowLike {
    isDestroyed?: () => boolean;
    destroy?: () => void;
    loadURL?: (url: string) => Promise<void>;
    showInactive?: () => void;
    setAlwaysOnTop?: (flag: boolean, level?: string) => void;
    moveTop?: () => void;
    setBounds?: (bounds: Bounds) => void;
    getBounds?: () => Bounds;
    webContents?: WebContentsLike;
    isMinimized?: () => boolean;
    restore?: () => void;
    show?: () => void;
    focus?: () => void;
}

type BrowserWindowCtor = new (options: Record<string, unknown>) => BrowserWindowLike;

interface ElectronRemoteLike {
    BrowserWindow?: BrowserWindowCtor;
    screen?: {
        getPrimaryDisplay?: () => { workArea?: Bounds } | undefined;
    };
    /** In the main Obsidian renderer this is the main Obsidian window. */
    getCurrentWindow?: () => BrowserWindowLike | undefined;
    globalShortcut?: GlobalShortcutLike;
}

/** Shared with global-shortcut.ts, which touches the same @electron/remote bridge. */
export function getRemote(): ElectronRemoteLike | null {
    try {
        const requireFn = (window as Window & { require?: (module: string) => unknown }).require;
        if (typeof requireFn !== "function") return null;
        const remote = requireFn("@electron/remote");
        return remote ? (remote) : null;
    } catch {
        return null;
    }
}

/** One DOM snapshot of the popup, as replayed by the local page. */
export interface MirrorState {
    body: string;
    bodyClass: string;
    w: number;
    h: number;
    scroll: number;
}

/**
 * Receiver of the popup's display for the "show the popup on a local page"
 * feature. The popup only reports what it shows; it knows nothing about how
 * (or whether) the display is served.
 */
export interface MirrorSink {
    isEnabled(): boolean;
    /** `fitHeight`: the answer-side height, so a page scaling the popup to fit does not jump on reveal. */
    open(html: string, fitHeight: number): void;
    state(s: MirrorState): void;
    close(): void;
}

function isMirrorState(value: unknown): value is MirrorState {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.body === "string" &&
        typeof v.bodyClass === "string" &&
        typeof v.w === "number" &&
        typeof v.h === "number" &&
        typeof v.scroll === "number"
    );
}

/**
 * Appended to the popup's script only while mirroring is on: reports DOM
 * snapshots through a long poll (window.__nextMirror), coalesced to one per
 * MIRROR_THROTTLE_MS; a snapshot not yet collected is replaced by the newer one.
 */
const MIRROR_THROTTLE_MS = 30;
const MIRROR_SCRIPT = `(function () {
    var content = document.querySelector(".content");
    var pending = null;
    var timer = null;
    var waiters = [];
    function snapshot() {
        return {
            body: document.body.innerHTML,
            bodyClass: document.body.className,
            w: window.innerWidth,
            h: window.innerHeight,
            scroll: content ? content.scrollTop : 0
        };
    }
    function flush() {
        timer = null;
        var s = snapshot();
        if (waiters.length) waiters.shift()(s);
        else pending = s;
    }
    function queue() {
        if (timer === null) timer = setTimeout(flush, ${MIRROR_THROTTLE_MS});
    }
    window.__nextMirror = function () {
        if (pending) {
            var s = pending;
            pending = null;
            return Promise.resolve(s);
        }
        return new Promise(function (resolve) { waiters.push(resolve); });
    };
    new MutationObserver(queue).observe(document.body, {
        subtree: true, childList: true, attributes: true, characterData: true
    });
    window.addEventListener("resize", queue);
    if (content) content.addEventListener("scroll", queue, { passive: true });
    queue();
})();
`;

/**
 * Fixed window title (BrowserWindow option and the page's own <title>, so the
 * page cannot rename the window). External tools — window capture, automation
 * hooks — can find the popup by this exact title among Obsidian.exe's windows.
 */
export const POPUP_WINDOW_TITLE = "SR Popup Review";

/** Built-in size, used until the user configures one in the settings tab. */
export const DEFAULT_WIDTH = 400;
export const DEFAULT_HEIGHT_FRONT = 260;
export const DEFAULT_HEIGHT_REVEALED = 470;
/** Floor for both the configured size and dragging: below this a card stops being readable. */
export const MIN_WIDTH = 300;
export const MIN_HEIGHT = 180;
const MARGIN = 16;
/** loadURL can hang if the window's renderer dies mid-load — time-box it. */
const LOAD_TIMEOUT_MS = 15_000;
/** How long ensureAlive() waits for the popup to answer a trivial script call. */
const ALIVE_TIMEOUT_MS = 5_000;
/** A review write that has not settled by then is reported and the popup closed. */
const RATE_TIMEOUT_MS = 90_000;
/** After this long on "Saving…", the popup unlocks its close button (escape hatch). */
const SAVING_STUCK_MS = 60_000;
/**
 * Heartbeat: the plugin pings the popup every 30 s; if pings stop for 5 minutes
 * the popup closes itself. Prevents a popup from outliving Obsidian (a hung or
 * quit main window whose onunload never ran left zombie popups behind).
 * The send interval lives in the (throttleable) main window, so the dead
 * threshold is generous.
 * The main window's beforeunload hook (main.ts) is the primary path; this is
 * the last line of defence when that hook never ran (crash, hung renderer).
 */
const HEARTBEAT_SEND_MS = 30_000;
const HEARTBEAT_DEAD_MS = 5 * 60_000;
/**
 * After the popup asks the plugin to dismiss it, how long it waits before
 * closing itself. The plugin normally destroys the window within milliseconds
 * (the long poll is not a timer, so it is not throttled); the fallback fires
 * only when nobody answers — Obsidian's main window is gone or the plugin was
 * unloaded without reaching us. The close button must never depend on the
 * owner being alive.
 */
const DISMISS_SELF_CLOSE_MS = 1_000;

const ACTION_TO_RESPONSE: Record<string, ReviewResponseValue> = {
    again: ReviewResponse.Again,
    hard: ReviewResponse.Hard,
    good: ReviewResponse.Good,
    easy: ReviewResponse.Easy,
};

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Splits every paragraph that contains line breaks (`<p>a<br>b</p>`) into one
 * `.ln` block per line, so the popup can space lines apart and indent wrapped
 * continuations — otherwise a long line's wrap looks exactly like a new line.
 * Only direct `<br>` children of `<p>` are touched (lists, tables keep theirs).
 */
function splitLineBreaks(root: HTMLElement): void {
    for (const p of Array.from(root.querySelectorAll("p"))) {
        if (!Array.from(p.children).some((c) => c.tagName === "BR")) continue;
        const lines: Node[][] = [[]];
        for (const node of Array.from(p.childNodes)) {
            if (node.nodeName === "BR") lines.push([]);
            else lines[lines.length - 1].push(node);
        }
        p.empty();
        for (const nodes of lines) {
            // Drop the "\n" text node the renderer leaves after each <br>.
            const first = nodes[0];
            if (first?.nodeType === Node.TEXT_NODE) first.textContent = (first.textContent ?? "").replace(/^\n/, "");
            if (nodes.every((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() === "")) continue;
            const line = p.createSpan({ cls: "ln" });
            for (const n of nodes) line.appendChild(n);
        }
    }
}

const INTERVAL_UNIT_KEY: Record<IntervalPreview["unit"], string> = {
    minutes: "ivlMinutes",
    hours: "ivlHours",
    days: "ivlDays",
    months: "ivlMonths",
    years: "ivlYears",
};

function formatInterval(preview: IntervalPreview): string {
    return t(INTERVAL_UNIT_KEY[preview.unit], { n: preview.value });
}

/**
 * Frameless always-on-top popup at the bottom-right of the primary display.
 *
 * Communication is a LONG POLL, not a timer: the plugin awaits
 * executeJavaScript("window.__nextEvent()"), whose promise resolves the moment
 * the popup emits an event. Timers in the (usually minimized) main Obsidian
 * window are heavily throttled by Chromium, so anything latency-sensitive must
 * either live in the visible popup window (auto-close countdown, click feedback)
 * or be event-driven like this (rating -> write). Remote event subscription is
 * still avoided (fragile across Electron versions).
 */
export class PopupController {
    private win: BrowserWindowLike | null = null;
    private session: ReviewSession | null = null;
    private revealed = false;
    private wasShown = false;
    private heartbeatTimer: number | null = null;
    /**
     * Bumped on every show()/finish(). Async continuations (event loop, load,
     * liveness probe) compare their captured value against the current one and
     * abort when superseded, so a hung await can never act on a newer popup.
     */
    private generation = 0;
    /** Ends the "showing" record begun in show(); null when none is active. */
    private endShowing: (() => void) | null = null;

    constructor(
        private app: App,
        private owner: Component,
        /** Persistent diagnostics logger (also mirrors to the console). */
        private diag: (message: string) => void,
        /** Handles the popup's options menu: pause, or snooze for N minutes. */
        private onControl: (action: "pause" | "snooze", minutes?: number) => Promise<void>,
        /** Called when a popup that was actually shown ends (rated or dismissed). */
        private onSessionEnd: () => void,
        /** Reads the user's configured popup size; null members = built-in defaults. */
        private loadSizes: () => {
            width: number | null;
            heightFront: number | null;
            heightRevealed: number | null;
        },
        /** Optional receiver of the popup's display (local page); null = none. */
        private mirror: MirrorSink | null = null,
        /** Optional record of what the popup is doing, for external tools; null = none. */
        private reviewState: ReviewStateTracker | null = null,
    ) {}

    /** Ends this popup's "showing" record, if any. Idempotent. */
    private endShowingState(): void {
        this.endShowing?.();
        this.endShowing = null;
    }

    get isOpen(): boolean {
        try {
            return this.win !== null && this.win.isDestroyed?.() !== true;
        } catch {
            // A destroyed remote BrowserWindow throws "Object has been destroyed"
            // on ANY member access — treat that as closed.
            return false;
        }
    }

    async show(
        session: ReviewSession,
        autoCloseSeconds: number,
        showDeckName: boolean,
        /** Give the popup keyboard focus (global shortcut) instead of showing it inactive. */
        focus = false,
    ): Promise<boolean> {
        if (this.isOpen) return false;
        const remote = getRemote();
        const BrowserWindowClass = remote?.BrowserWindow;
        if (typeof BrowserWindowClass !== "function" || !remote?.screen) {
            console.error("[sr-popup-review] @electron/remote is not available");
            return false;
        }
        const gen = ++this.generation;
        this.session = session;
        this.endShowingState(); // defensive: never leave a previous record behind
        this.endShowing = this.reviewState?.beginShowing(session.question) ?? null;
        this.revealed = false;

        // Decided once per popup: the snapshot script is only in this popup's
        // HTML when mirroring was on at build time.
        const mirror = this.mirror?.isEnabled() ? this.mirror : null;
        const html = await this.buildHtml(session, showDeckName, autoCloseSeconds, mirror !== null);
        if (gen !== this.generation) return false;
        const sizes = this.resolveSizes();
        let win: BrowserWindowLike;
        try {
            win = new BrowserWindowClass({
                width: sizes.width,
                height: sizes.heightFront,
                frame: false,
                alwaysOnTop: true,
                skipTaskbar: true,
                resizable: true,
                minWidth: MIN_WIDTH,
                minHeight: MIN_HEIGHT,
                show: false,
                focusable: true,
                roundedCorners: true,
                title: POPUP_WINDOW_TITLE,
                webPreferences: { nodeIntegration: false, contextIsolation: true },
            });
        } catch (e) {
            console.error("[sr-popup-review] failed to create popup window", e);
            // No window and no finish(): end the record here, or the card would
            // read as "showing" until the next popup.
            this.endShowingState();
            return false;
        }
        this.win = win;
        this.place(remote, sizes.width, sizes.heightFront);
        const url = "data:text/html;charset=utf-8," + encodeURIComponent(html);
        const loadPromise =
            typeof win.loadURL === "function"
                ? win.loadURL(url).then(
                      () => true,
                      (e: unknown) => {
                          console.error("[sr-popup-review] failed to load popup content", e);
                          return false;
                      },
                  )
                : Promise.resolve(false);
        const loaded = await Promise.race([
            loadPromise,
            new Promise<boolean>((resolve) =>
                window.setTimeout(() => resolve(false), LOAD_TIMEOUT_MS),
            ),
        ]);
        if (gen !== this.generation) return false;
        if (!loaded || !this.isOpen) {
            this.diag("ERROR: popup content did not load in time");
            this.finish();
            return false;
        }
        try {
            if (focus) {
                win.show?.();
                win.focus?.();
            } else {
                win.showInactive?.();
            }
        } catch (e) {
            console.error("[sr-popup-review] failed to show popup", e);
            this.finish();
            return false;
        }
        try {
            // The default always-on-top band loses to overlay apps and borderless
            // fullscreen windows; raise to the highest band and push to its top.
            // (Exclusive-fullscreen games still cover it — an OS-level limitation.)
            win.setAlwaysOnTop?.(true, "screen-saver");
            win.moveTop?.();
        } catch {
            /* cosmetic */
        }
        if (this.heartbeatTimer !== null) {
            // Defensive: never leak a previous session's interval.
            window.clearInterval(this.heartbeatTimer);
        }
        this.wasShown = true;
        this.heartbeatTimer = window.setInterval(() => this.heartbeatTick(gen), HEARTBEAT_SEND_MS);
        void this.eventLoop(gen);
        if (mirror) {
            mirror.open(html, sizes.heightRevealed);
            void this.mirrorLoop(gen, mirror);
        }
        this.diag(
            `popup shown (deck: ${session.deckName ?? "-"}, due: ${session.dueCount}, new card: ${session.isNewCard}, at ${session.location ?? "unknown"})`,
        );
        return true;
    }

    /**
     * Heartbeat + reaper. Besides feeding the popup's self-destruct timer, this
     * detects a window that died without the event loop noticing (on some
     * Electron versions a pending executeJavaScript promise never settles when
     * the window closes itself) and buries the session. Without this, the dead
     * window blocked every future popup and its leaked timer threw
     * "Object has been destroyed" on every beat — observed in the wild as
     * hundreds of accumulated console errors.
     */
    private heartbeatTick(gen: number): void {
        if (gen !== this.generation) return;
        if (!this.isOpen) {
            this.diag("popup window vanished; cleaning up its session");
            this.finish();
            return;
        }
        this.execInPopup("window.__heartbeat && window.__heartbeat()").catch(() => {
            /* transient; the reaper or event loop will clean up */
        });
    }

    close(): void {
        this.finish();
    }

    /** Re-raises an open popup (e.g. when the user asks for one while it is
     * hidden behind other always-on-top windows). No-op when closed. */
    bringToFront(focus = false): void {
        if (!this.isOpen) return;
        try {
            this.win?.showInactive?.();
            this.win?.setAlwaysOnTop?.(true, "screen-saver");
            this.win?.moveTop?.();
            if (focus) this.win?.focus?.();
        } catch (e) {
            this.diag(`failed to raise popup: ${String(e)}`);
        }
    }

    /**
     * True if the popup window answers a trivial script call within a few
     * seconds. A window whose renderer died (system sleep, the OS reclaiming
     * the process) still reports isDestroyed() === false but never responds —
     * destroy it so it cannot block future popups forever.
     */
    async ensureAlive(): Promise<boolean> {
        if (!this.isOpen) return false;
        const gen = this.generation;
        let alive = false;
        try {
            alive = await Promise.race([
                this.execInPopup("1").then(() => true),
                new Promise<boolean>((resolve) =>
                    window.setTimeout(() => resolve(false), ALIVE_TIMEOUT_MS),
                ),
            ]);
        } catch {
            alive = false;
        }
        if (alive) return true;
        if (gen === this.generation && this.isOpen) {
            this.diag("popup window is unresponsive; destroying it");
            this.finish();
        }
        return false;
    }

    /** Runs a script in the popup window; rejects if the window is unavailable.
     * Never throws synchronously: member access on a destroyed remote window
     * throws "Object has been destroyed", which must not escape into timers. */
    private execInPopup(code: string): Promise<unknown> {
        try {
            const webContents = this.win?.webContents;
            if (!webContents || typeof webContents.executeJavaScript !== "function") {
                return Promise.reject(new Error("popup webContents unavailable"));
            }
            return webContents.executeJavaScript(code, true);
        } catch (e) {
            return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
    }

    /**
     * Raises the main Obsidian window (restoring it when minimized), mirroring
     * the Electron half of SR's own focusObsidianWindow(). The popup stays
     * always-on-top, so it remains visible above the raised window.
     */
    private focusMainWindow(): void {
        try {
            const main = getRemote()?.getCurrentWindow?.();
            if (!main) return;
            if (main.isMinimized?.() === true) main.restore?.();
            main.show?.();
            main.focus?.();
            main.moveTop?.();
        } catch (e) {
            console.error("[sr-popup-review] failed to focus the Obsidian window", e);
        }
    }

    /**
     * Long-poll loop: each iteration blocks until the popup emits an event
     * ("revealed", a rating action, or "close"). The executeJavaScript promise
     * rejects when the window is closed/destroyed, which also ends the loop.
     * `gen` guards every continuation: if this popup was superseded while an
     * await was pending, the stale loop exits without touching the new popup.
     */
    private async eventLoop(gen: number): Promise<void> {
        while (gen === this.generation && this.isOpen) {
            let event: unknown;
            try {
                event = await this.execInPopup("window.__nextEvent()");
            } catch {
                break; // window closed or content gone
            }
            if (gen !== this.generation) return;
            if (!this.isOpen) break;
            if (event === "revealed") {
                this.revealed = true;
                const remote = getRemote();
                // Keep a width the user dragged to; only the height grows to fit
                // the answer.
                const bounds = this.readBounds();
                const sizes = this.resolveSizes();
                if (remote) this.place(remote, bounds?.width ?? sizes.width, sizes.heightRevealed);
                continue;
            }
            if (event === "close") {
                this.diag("popup dismissed (nothing written)");
                break;
            }
            // The popup finished its confirmation flash (rated / paused / snoozed).
            if (event === "finished") break;
            if (event === "open-note") {
                this.diag("popup menu: open note requested");
                const session = this.session;
                let opened = false;
                try {
                    opened = session?.openNote ? await session.openNote() : false;
                } catch (e) {
                    console.error("[sr-popup-review] failed to open the card's note", e);
                }
                if (opened) {
                    this.focusMainWindow();
                    this.diag("note opened in Obsidian; popup stays open");
                } else {
                    this.diag("note could not be opened (file missing or source unknown)");
                }
                continue; // the popup stays open; the user rates afterwards
            }
            if (event === "pause" || (typeof event === "string" && event.startsWith("snooze:"))) {
                const minutes = event === "pause" ? undefined : Number(event.slice(7));
                this.diag(
                    event === "pause"
                        ? "popup menu: pause requested"
                        : `popup menu: snooze ${minutes ?? "?"} min requested`,
                );
                try {
                    await this.onControl(event === "pause" ? "pause" : "snooze", minutes);
                } catch (e) {
                    console.error("[sr-popup-review] failed to apply popup menu action", e);
                }
                this.markSessionEnd();
                // The popup shows its own confirmation, then emits "finished"
                // (or closes itself, rejecting the next __nextEvent() call).
                continue;
            }
            const response = ACTION_TO_RESPONSE[String(event)];
            const session = this.session;
            if (response === undefined || !session) break;
            this.diag(`rating received (${String(event)}); writing...`);
            const started = Date.now();
            const endWrite = this.reviewState?.beginWrite(session.question);
            const ratePromise = session.rate(response).then(
                (r): RateOutcome | "error" => r,
                (e: unknown) => {
                    console.error("[sr-popup-review] failed to save review", e);
                    return "error" as const;
                },
            );
            // Ends when the write itself settles, not when the popup gives up on
            // it (RATE_TIMEOUT_MS): a late write is still a write. ratePromise
            // never rejects (see above), so this always runs.
            void ratePromise.then(() => endWrite?.());
            const result = await Promise.race([
                ratePromise,
                new Promise<"timeout">((resolve) =>
                    window.setTimeout(() => resolve("timeout"), RATE_TIMEOUT_MS),
                ),
            ]);
            if (result === "error") {
                this.diag("ERROR: review write failed (see console for the exception)");
                new Notice(t("ratingFailed"));
                break;
            }
            if (result === "timeout") {
                this.diag(
                    `ERROR: review write did not settle within ${RATE_TIMEOUT_MS / 1000}s; popup closed — check the card's schedule comment`,
                );
                new Notice(t("ratingTimeout"));
                break;
            }
            const where = session.location ?? "unknown location";
            const elapsed = Date.now() - started;
            const notSaved = result.result === "notSaved";
            const resaved = result.result === "resaved";
            if (notSaved) {
                this.diag(
                    `ERROR: review (${String(event)}) NOT saved to ${where}: the card's text changed after the popup opened`,
                );
                if (result.retryFailure) this.diag(`retry: ${result.retryFailure}`);
                new Notice(t("ratingNotSaved"));
            } else if (resaved) {
                this.diag(
                    `review (${String(event)}) re-saved to ${result.location ?? "unknown location"} after the card was edited (was ${where}) in ${elapsed} ms`,
                );
            } else if (result.result === "saved") {
                this.diag(`review (${String(event)}) saved to ${where} in ${elapsed} ms`);
            } else {
                this.diag(
                    `review (${String(event)}) written to ${where} in ${elapsed} ms (not verified)`,
                );
            }
            this.markSessionEnd();
            if (gen !== this.generation) return;
            try {
                await this.execInPopup(
                    notSaved
                        ? "window.__showNotSaved && window.__showNotSaved()"
                        : resaved
                          ? `window.__showDone && window.__showDone(${JSON.stringify("✓ " + t("savedAfterEdit"))})`
                          : "window.__showDone && window.__showDone()",
                );
            } catch {
                /* window may already be gone; the review is saved either way */
            }
            // The popup shows the done flash, then emits "finished" (or closes
            // itself, rejecting the next __nextEvent() call).
        }
        if (gen === this.generation) this.finish();
    }

    /**
     * Long poll for the popup's DOM snapshots (same pattern as eventLoop),
     * forwarded to the mirror sink. Ends when the window goes away or the
     * popup is superseded.
     */
    private async mirrorLoop(gen: number, mirror: MirrorSink): Promise<void> {
        while (gen === this.generation && this.isOpen) {
            let snapshot: unknown;
            try {
                snapshot = await this.execInPopup("window.__nextMirror()");
            } catch {
                return; // window closed or content gone
            }
            if (gen !== this.generation) return;
            if (isMirrorState(snapshot)) mirror.state(snapshot);
        }
    }

    /**
     * Configured size with the built-in defaults filled in. Also guards against
     * a hand-edited data.json: a non-finite value would reach setBounds as NaN.
     */
    private resolveSizes(): { width: number; heightFront: number; heightRevealed: number } {
        const saved = this.loadSizes();
        const pick = (value: number | null, fallback: number, min: number): number =>
            typeof value === "number" && Number.isFinite(value)
                ? Math.max(min, Math.round(value))
                : fallback;
        return {
            width: pick(saved.width, DEFAULT_WIDTH, MIN_WIDTH),
            heightFront: pick(saved.heightFront, DEFAULT_HEIGHT_FRONT, MIN_HEIGHT),
            heightRevealed: pick(saved.heightRevealed, DEFAULT_HEIGHT_REVEALED, MIN_HEIGHT),
        };
    }

    /** Current window bounds, or null when the window is already gone. */
    private readBounds(): Bounds | null {
        try {
            return this.win?.getBounds?.() ?? null;
        } catch {
            // A destroyed remote BrowserWindow throws on ANY member access.
            return null;
        }
    }

    private place(remote: ElectronRemoteLike, width: number, height: number): void {
        try {
            const workArea = remote.screen?.getPrimaryDisplay?.()?.workArea;
            if (!workArea) return;
            // A size dragged on a larger display must not push the popup off a
            // smaller one (the anchor is the bottom-right corner).
            width = Math.min(width, workArea.width - MARGIN * 2);
            height = Math.min(height, workArea.height - MARGIN * 2);
            const win = this.win;
            if (typeof win?.setBounds !== "function") return;
            win.setBounds({
                x: Math.round(workArea.x + workArea.width - width - MARGIN),
                y: Math.round(workArea.y + workArea.height - height - MARGIN),
                width,
                height,
            });
        } catch (e) {
            console.error("[sr-popup-review] failed to position popup", e);
        }
    }

    /**
     * Reports the end of a visible session the moment the user's decision is
     * final (rating written, pause/snooze applied), not when the window is torn
     * down. The popup closes itself shortly after, but a self-closed window does
     * not always reject the pending long poll, so finish() only ran when the
     * reaper noticed — up to 30 s later. A scheduler tick inside that gap saw no
     * open popup and a stale lastShownAt, and when the popup had been open
     * longer than the interval it showed the next card seconds after the rating.
     * Idempotent: finish() will not report the same session again.
     */
    private markSessionEnd(): void {
        this.endShowingState();
        if (!this.wasShown) return;
        this.wasShown = false;
        this.onSessionEnd();
    }

    private finish(): void {
        this.generation++; // invalidate any in-flight event loop / load / probe
        if (this.heartbeatTimer !== null) {
            window.clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        const win = this.win;
        const endedVisibleSession = this.wasShown;
        this.wasShown = false;
        this.win = null;
        this.session = null;
        this.endShowingState();
        try {
            if (win && win.isDestroyed?.() !== true) win.destroy?.();
        } catch {
            /* already gone */
        }
        // Unconditional: a no-op when nothing is mirrored, and it must also
        // clear a popup that started mirroring before the feature was turned off.
        this.mirror?.close();
        // The popup interval is anchored to the END of a popup, not its start:
        // a popup that sat open past the interval must not be followed by the
        // next one within a minute of being rated/dismissed.
        if (endedVisibleSession) this.onSessionEnd();
    }

    private async renderMarkdown(markdown: string): Promise<string> {
        const el = createDiv();
        try {
            await MarkdownRenderer.render(this.app, markdown, el, "", this.owner);
            splitLineBreaks(el);
            return el.innerHTML;
        } catch (e) {
            console.error("[sr-popup-review] markdown render failed, using plain text", e);
            return '<pre style="white-space:pre-wrap">' + escapeHtml(markdown) + "</pre>";
        }
    }

    private async buildHtml(
        session: ReviewSession,
        showDeckName: boolean,
        autoCloseSeconds: number,
        /** Append the DOM-snapshot reporter (local page). Off = HTML unchanged. */
        withMirror: boolean,
    ): Promise<string> {
        const frontHtml = await this.renderMarkdown(session.front);
        const backHtml = await this.renderMarkdown(session.back);
        const dark = activeDocument.body.classList.contains("theme-dark");
        const headerParts: string[] = [];
        if (showDeckName && session.deckName) headerParts.push(escapeHtml(session.deckName));
        if (session.isNewCard) headerParts.push(escapeHtml(t("newCard")));
        const statsText =
            session.reviewedToday !== null
                ? t("headerStats", {
                      today: session.reviewedToday,
                      due: session.eligibleDue,
                      new: session.eligibleNew,
                  })
                : t("headerStatsNoToday", { due: session.eligibleDue, new: session.eligibleNew });
        const labels = session.buttonLabels;
        const autoCloseMs = Math.max(0, Math.round(autoCloseSeconds * 1000));
        // Offered only when the bridge could identify the card's source note.
        // No data-action: this item must not run the pause/snooze handler.
        const openNoteItem =
            session.openNote !== null
                ? `\n    <button id="openNoteBtn">${escapeHtml(t("menuOpenNote"))}</button>`
                : "";
        const intervals = session.intervals;
        // Two-line buttons only when SR could preview the intervals; otherwise
        // the buttons stay exactly as before.
        const ratingButton = (key: RatingKey, label: string): string => {
            const preview = intervals?.[key] ?? null;
            const text = escapeHtml(label);
            if (!intervals) return `<button class="action ${key}" data-action="${key}">${text}</button>`;
            const ivl = preview ? `(${escapeHtml(formatInterval(preview))})` : "";
            return `<button class="action ${key}" data-action="${key}"><span>${text}</span><span class="ivl">${ivl}</span></button>`;
        };

        return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${POPUP_WINDOW_TITLE}</title>
<style>
:root {
    --bg: #ffffff; --fg: #1f2328; --muted: #6a737d; --border: #d0d7de;
    --btn-bg: #f6f8fa; --btn-border: #d0d7de;
    --again: #d1242f; --hard: #bc4c00; --good: #1a7f37; --easy: #0969da;
}
body.dark {
    --bg: #1e1e1e; --fg: #dadada; --muted: #9e9e9e; --border: #3f3f3f;
    --btn-bg: #2a2a2a; --btn-border: #4a4a4a;
    --again: #f47067; --hard: #e0823d; --good: #57ab5a; --easy: #539bf5;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
[hidden] { display: none !important; }
html, body { height: 100%; }
body {
    background: var(--bg); color: var(--fg);
    font-family: -apple-system, "Segoe UI", "Yu Gothic UI", "Meiryo", "Malgun Gothic", sans-serif;
    font-size: 14px; line-height: 1.6;
    display: flex; flex-direction: column;
    border: 1px solid var(--border); overflow: hidden;
}
.header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 8px 12px; font-size: 12px; color: var(--muted);
    -webkit-app-region: drag; flex: none; user-select: none;
}
.hdr-main { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Shrinks (with an ellipsis) only once the deck name is gone, so ⋯ / ✕ always stay reachable. */
.hdr-stats { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; margin: 0 4px 0 8px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.hdr-buttons { flex: none; white-space: nowrap; }
.closebtn {
    -webkit-app-region: no-drag;
    background: none; border: none; color: var(--muted);
    font-size: 14px; cursor: pointer; padding: 2px 6px;
}
.closebtn:hover { color: var(--fg); }
.menu {
    position: fixed; top: 32px; right: 8px; z-index: 10;
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25); min-width: 180px;
    /* Five items no longer fit a popup shrunk to MIN_HEIGHT: scroll instead of clipping. */
    max-height: calc(100vh - 40px); overflow-x: hidden; overflow-y: auto;
}
.menu button {
    display: block; width: 100%; text-align: left; padding: 8px 12px;
    background: none; border: none; color: var(--fg);
    font-family: inherit; font-size: 13px; cursor: pointer;
}
.menu button:hover { background: var(--btn-bg); }
.content { flex: 1; overflow-y: auto; overflow-x: auto; padding: 2px 16px 10px; }
.content img { max-width: 100%; }
.content hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
/* Obsidian's renderer emits plain <table>s; without the app CSS they have no grid. */
.content table { border-collapse: collapse; margin: 8px 0; font-size: 13px; }
.content th, .content td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; vertical-align: top; }
.content th { background: var(--btn-bg); font-weight: 600; }
.q { font-size: 15px; }
/* One block per source line (see splitLineBreaks): a gap between lines and a
   hanging indent on wrapped continuations tell a line break from a wrap. */
.content .ln { display: block; padding-left: 1em; text-indent: -1em; }
.content .ln + .ln { margin-top: 0.4em; }
.footer { flex: none; padding: 10px 12px 12px; }
button.action {
    font-family: inherit; font-size: 13px; cursor: pointer;
    background: var(--btn-bg); color: var(--fg);
    border: 1px solid var(--btn-border); border-radius: 6px; padding: 8px 0;
}
button.action:hover:enabled { border-color: var(--fg); }
button.action:disabled { opacity: 0.45; cursor: default; }
button.action.chosen { opacity: 1; border-color: currentColor; box-shadow: 0 0 0 1px currentColor inset; }
#revealBtn { width: 100%; }
#ratings { display: flex; gap: 6px; }
#ratings .action { flex: 1; font-weight: 600; }
#ratings .again { color: var(--again); }
#ratings .hard { color: var(--hard); }
#ratings .good { color: var(--good); }
#ratings .easy { color: var(--easy); }
#ratings.two-line .action {
    display: flex; flex-direction: column; align-items: center;
    gap: 1px; padding: 5px 0 4px; line-height: 1.25;
}
#ratings.two-line .ivl { font-size: 11px; font-weight: 400; color: var(--muted); min-height: 14px; }
#saving { margin-top: 8px; font-size: 12px; color: var(--muted); text-align: center; }
.done {
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    background: var(--bg); font-size: 16px;
}
</style>
</head>
<body class="${dark ? "dark" : ""}">
<div class="header">
    <span class="hdr-main">${headerParts.join(" · ")}</span>
    <span class="hdr-stats">${escapeHtml(statsText)}</span>
    <span class="hdr-buttons">
        <button class="closebtn" id="menuBtn" title="${escapeHtml(t("menuTooltip"))}">⋯</button>
        <button class="closebtn" id="closeBtn" title="Esc">✕</button>
    </span>
</div>
<div id="menu" class="menu" hidden>${openNoteItem}
    <button data-action="pause">${escapeHtml(t("menuPause"))}</button>
    <button data-action="snooze:30">${escapeHtml(t("menuSnooze30"))}</button>
    <button data-action="snooze:60">${escapeHtml(t("menuSnooze60"))}</button>
    <button data-action="snooze:180">${escapeHtml(t("menuSnooze180"))}</button>
</div>
<div class="content">
    <div class="q">${frontHtml}</div>
    <div id="answer" hidden><hr>${backHtml}</div>
</div>
<div class="footer">
    <button class="action" id="revealBtn">▼ ${escapeHtml(t("showAnswer"))}</button>
    <div id="ratings"${intervals ? ' class="two-line"' : ""} hidden>
        ${ratingButton("again", labels.again)}
        ${ratingButton("hard", labels.hard)}
        ${ratingButton("good", labels.good)}
        ${ratingButton("easy", labels.easy)}
    </div>
    <div id="saving" hidden>${escapeHtml(t("saving"))}</div>
</div>
<div id="done" class="done" hidden>✓ ${escapeHtml(t("saved"))}</div>
<script>
(function () {
    // Event queue + long-poll endpoint for the plugin side.
    var events = [];
    var waiters = [];
    function emit(e) {
        if (waiters.length) waiters.shift()(e);
        else events.push(e);
    }
    window.__nextEvent = function () {
        if (events.length) return Promise.resolve(events.shift());
        return new Promise(function (resolve) { waiters.push(resolve); });
    };

    // Self-destruct when the plugin's heartbeat stops (Obsidian quit or hung):
    // a popup must never outlive its owner.
    var lastHeartbeat = Date.now();
    window.__heartbeat = function () { lastHeartbeat = Date.now(); };
    setInterval(function () {
        if (Date.now() - lastHeartbeat > ${HEARTBEAT_DEAD_MS}) window.close();
    }, 30000);

    var revealBtn = document.getElementById("revealBtn");
    var ratings = document.getElementById("ratings");
    var answer = document.getElementById("answer");
    var saving = document.getElementById("saving");

    // Auto-close lives here (this window is visible, so its timers are not
    // throttled, unlike the minimized main Obsidian window).
    var autoCloseMs = ${autoCloseMs};
    var autoCloseTimer = null;
    // Set once the user opens the note: they are reading it, so the popup must
    // never close under them (not even when "Show answer" re-arms the timer).
    var autoCloseDisabled = false;
    // Asks the plugin to close this window, then closes it ourselves if the
    // plugin does not answer (Obsidian gone): closing must never depend on
    // the owner being alive.
    function dismiss() {
        emit("close");
        setTimeout(function () { window.close(); }, ${DISMISS_SELF_CLOSE_MS});
    }
    // After a confirmation flash: tell the plugin first so it ends the session
    // at once (a pending __nextEvent() call does not always reject when the
    // window closes itself), then close ourselves if the plugin does not.
    function finishAfter(ms) {
        setTimeout(function () {
            emit("finished");
            setTimeout(function () { window.close(); }, ${DISMISS_SELF_CLOSE_MS});
        }, ms);
    }
    function armAutoClose() {
        if (!autoCloseMs || autoCloseDisabled) return;
        if (autoCloseTimer) clearTimeout(autoCloseTimer);
        autoCloseTimer = setTimeout(dismiss, autoCloseMs);
    }
    armAutoClose();

    var revealed = false;
    function reveal() {
        if (revealed) return;
        revealed = true;
        revealBtn.hidden = true;
        answer.hidden = false;
        ratings.hidden = false;
        armAutoClose();
        emit("revealed");
    }

    var byAction = {};
    var chosen = false;
    var savingStuck = false;
    var savingTimer = null;
    function choose(action) {
        if (chosen || !revealed) return;
        chosen = true;
        if (autoCloseTimer) clearTimeout(autoCloseTimer);
        Object.keys(byAction).forEach(function (k) { byAction[k].disabled = true; });
        if (byAction[action]) byAction[action].classList.add("chosen");
        saving.hidden = false;
        // Escape hatch: if the plugin never answers (hung write, blocked main
        // window), unlock closing so the popup cannot become a stuck ornament.
        savingTimer = setTimeout(function () {
            savingStuck = true;
            saving.textContent = ${JSON.stringify(t("savingStuck"))};
        }, ${SAVING_STUCK_MS});
        emit(action);
    }
    function requestClose() {
        if (savingStuck) { window.close(); return; }
        if (!chosen) dismiss();
    }

    revealBtn.addEventListener("click", reveal);
    document.getElementById("closeBtn").addEventListener("click", requestClose);

    // Options menu (open note / pause / snooze). The confirmation overlay and
    // self-close live here so they work even if the plugin side is throttled.
    var menu = document.getElementById("menu");
    var menuBtn = document.getElementById("menuBtn");
    menuBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
    });
    document.addEventListener("click", function (e) {
        if (!menu.hidden && !menu.contains(e.target) && e.target !== menuBtn) menu.hidden = true;
    });
    Array.prototype.forEach.call(menu.querySelectorAll("button[data-action]"), function (b) {
        b.addEventListener("click", function () {
            if (chosen) return;
            menu.hidden = true;
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
            var done = document.getElementById("done");
            done.textContent = "⏸ " + b.textContent;
            done.hidden = false;
            emit(b.getAttribute("data-action"));
            finishAfter(700);
        });
    });
    // "Open note" is the odd one out: no confirmation overlay, no self-close —
    // the popup stays up so the user can rate the card after reading the note.
    var openNoteBtn = document.getElementById("openNoteBtn");
    if (openNoteBtn) {
        openNoteBtn.addEventListener("click", function () {
            if (chosen) return;
            menu.hidden = true;
            // The user is now reading the note; never auto-close under them.
            autoCloseDisabled = true;
            if (autoCloseTimer) clearTimeout(autoCloseTimer);
            emit("open-note");
        });
    }
    Array.prototype.forEach.call(ratings.querySelectorAll(".action"), function (b) {
        byAction[b.getAttribute("data-action")] = b;
        b.addEventListener("click", function () { choose(b.getAttribute("data-action")); });
    });
    window.__showNotSaved = function () {
        if (savingTimer) clearTimeout(savingTimer);
        var done = document.getElementById("done");
        done.textContent = "⚠ " + ${JSON.stringify(t("popupNotSaved"))};
        done.style.color = "var(--again)";
        done.hidden = false;
        finishAfter(2500);
    };
    window.__showDone = function (text) {
        if (savingTimer) clearTimeout(savingTimer);
        var done = document.getElementById("done");
        if (typeof text === "string") done.textContent = text;
        done.hidden = false;
        // A custom message (saved to the edited card) is longer: give it time to be read.
        finishAfter(typeof text === "string" ? 1500 : 700);
    };
    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { requestClose(); return; }
        if (!revealed && (e.key === " " || e.key === "Enter")) {
            e.preventDefault();
            reveal();
            return;
        }
        var map = { "1": "again", "2": "hard", "3": "good", "4": "easy" };
        if (map[e.key]) choose(map[e.key]);
    });
})();
${withMirror ? MIRROR_SCRIPT : ""}</` + `script>
</body>
</html>`;
    }
}
