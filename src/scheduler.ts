import { moment } from "obsidian";
import type SRPopupPlugin from "./main";
import type { DeckFilter } from "./sr-bridge";
import { isFullscreenAppActive } from "./fullscreen";
import { t } from "./i18n";
import { notify } from "./notify";

const TICK_MS = 60_000;
const STARTUP_DELAY_MS = 15_000;
/** SR indexes the vault on startup; on large vaults 15 s is not enough, so retry. */
const STARTUP_MAX_ATTEMPTS = 8;
/** A tick stuck longer than this (hung SR sync / popup creation) is abandoned. */
const TICK_WATCHDOG_MS = 5 * 60_000;
/**
 * Checking for due cards runs SR's full vault sync, which is expensive on large
 * vaults — after a "nothing due" result, don't sync again for this long.
 * (Due dates have day granularity, so the due set rarely changes within minutes.)
 */
const NOTHING_DUE_BACKOFF_MS = 15 * 60_000;

/**
 * auto    — the regular 1-minute tick; honors the popup interval and do-not-disturb.
 * startup — the check-on-startup tick; ignores the interval, honors do-not-disturb.
 * manual  — the "show popup now" command; ignores all gates and shows notices.
 */
export type TickMode = "auto" | "startup" | "manual";

export class Scheduler {
    private tickingSince: number | null = null;
    private tickToken = 0;
    private nothingDueUntil = 0;
    private warnedIncompatible = false;

    constructor(private plugin: SRPopupPlugin) {}

    start(): void {
        this.plugin.registerInterval(window.setInterval(() => void this.tick("auto"), TICK_MS));
        if (this.plugin.settings.checkOnStartup) {
            this.scheduleStartupCheck(1);
        }
    }

    /** When the last due-card check found nothing, no re-check happens before this time. */
    getNothingDueUntil(): number {
        return this.nothingDueUntil;
    }

    private newCardsShownToday(): number {
        const s = this.plugin.settings;
        return s.newCardsShownDate === this.todayKey() ? s.newCardsShownCount : 0;
    }

    /** "Today" as SR sees it (honours SR's Start of day); calendar day if SR is unavailable. */
    private todayKey(): string {
        return this.plugin.bridge.srToday().format("YYYY-MM-DD");
    }

    /** How many new cards may still be introduced today (Infinity = unlimited). */
    private newCardCap(): number {
        const s = this.plugin.settings;
        if (s.newCardsMode === "none") return 0;
        if (s.newCardsMode === "unlimited") return Infinity;
        return Math.max(0, s.newCardsPerDay - this.newCardsShownToday());
    }

    /** `focusPopup`: the global shortcut hands keyboard focus to the popup it opens or raises. */
    async tick(mode: TickMode, focusPopup = false): Promise<void> {
        if (this.tickingSince !== null) {
            if (Date.now() - this.tickingSince < TICK_WATCHDOG_MS) {
                this.plugin.diag.log(
                    `tick(${mode}): skipped — previous tick still running (${Math.round((Date.now() - this.tickingSince) / 1000)}s)`,
                );
                if (mode === "manual") notify(t("popupPreparing"));
                return;
            }
            // A previous tick never returned (hung SR sync or popup creation).
            // Abandon its lock so popups can resume instead of staying silent
            // until the next Obsidian restart.
            this.plugin.diag.log(
                `ERROR: a previous tick was stuck for over ${TICK_WATCHDOG_MS / 60_000} minutes; abandoning its lock`,
            );
        }
        const token = ++this.tickToken;
        this.tickingSince = Date.now();
        try {
            await this.doTick(mode, focusPopup);
        } finally {
            if (token === this.tickToken) this.tickingSince = null;
        }
    }

    private scheduleStartupCheck(attempt: number): void {
        window.setTimeout(() => void this.startupCheck(attempt), STARTUP_DELAY_MS);
    }

    private async startupCheck(attempt: number): Promise<void> {
        const probe = this.plugin.bridge.probe();
        if (probe.status === "notReady" && attempt < STARTUP_MAX_ATTEMPTS) {
            console.debug(
                `[sr-popup-review] startup check ${attempt}/${STARTUP_MAX_ATTEMPTS}: Spaced Repetition not ready yet, retrying in ${STARTUP_DELAY_MS / 1000}s`,
            );
            this.scheduleStartupCheck(attempt + 1);
            return;
        }
        await this.tick("startup");
    }

    private async doTick(mode: TickMode, focusPopup: boolean): Promise<void> {
        const s = this.plugin.settings;
        const log = (message: string): void => {
            this.plugin.diag.log(`tick(${mode}): ${message}`);
        };
        if (mode !== "manual" && s.paused) {
            log("paused by the user");
            return;
        }
        if (mode !== "manual" && Date.now() < s.snoozeUntil) {
            log(`snoozed until ${moment(s.snoozeUntil).format("HH:mm")}`);
            return;
        }
        if (this.plugin.popup.isOpen) {
            if (await this.plugin.popup.ensureAlive()) {
                if (mode === "manual") {
                    this.plugin.popup.bringToFront(focusPopup);
                    log("a popup is already open; brought it to front");
                } else {
                    log("a popup is already open");
                }
                return;
            }
            log("cleaned up an unresponsive popup window");
        }
        if (mode === "auto" && Date.now() - s.lastShownAt < s.intervalMinutes * 60_000) {
            log("interval not elapsed yet");
            return;
        }
        if (mode === "auto" && Date.now() < this.nothingDueUntil) {
            log("backing off after a recent nothing-due sync");
            return;
        }
        if (
            mode !== "manual" &&
            s.quietHoursEnabled &&
            isInQuietHours(new Date(), s.quietHoursStart, s.quietHoursEnd)
        ) {
            log("inside do-not-disturb hours");
            return;
        }
        if (mode !== "manual" && s.pauseDuringFullscreen && (await isFullscreenAppActive())) {
            // Postponed, not consumed: the next tick re-checks, so the popup
            // appears within a minute after fullscreen ends.
            log("a fullscreen app is active");
            return;
        }
        const probe = this.plugin.bridge.probe();
        if (probe.status !== "ok") {
            log(`integration unavailable (${probe.status}: ${probe.reason ?? "?"})`);
            if (mode === "manual") {
                if (probe.status === "missing") notify(t("srMissing"));
                else if (probe.status === "notReady") notify(t("srNotReady"));
                else notify(t("incompatible", { reason: probe.reason ?? "?" }));
            } else if (probe.status === "incompatible" && !this.warnedIncompatible) {
                // SR is installed but its internals don't match what we verified:
                // warn once and never write through an unknown path.
                // "missing"/"notReady" are normal transient states — stay silent.
                this.warnedIncompatible = true;
                notify(t("incompatible", { reason: probe.reason ?? "?" }));
            }
            return;
        }
        if (mode !== "manual" && this.plugin.bridge.isSRReviewUIOpen()) {
            log("SR's own review UI is in focus");
            return;
        }

        // Until the popup is up (or known not to come up), no card is fixed yet:
        // external tools asking whether an edit is safe are told to wait.
        const endPreparing = this.plugin.reviewState.beginPreparing();
        try {
            await this.openAndShow(mode, focusPopup, log);
        } finally {
            endPreparing();
        }
    }

    private async openAndShow(
        mode: TickMode,
        focusPopup: boolean,
        log: (message: string) => void,
    ): Promise<void> {
        const s = this.plugin.settings;
        const filter: DeckFilter = { mode: s.deckFilterMode, paths: s.deckFilterList };
        // Due and new cards are mixed by the ratio of their counts, or by the fixed
        // new-card share when that setting is on; new cards are capped by what is
        // left of today's allowance.
        const newShare =
            s.newCardRatioEnabled && s.newCardsMode !== "none" ? s.newCardRatio / 100 : null;
        const session = await this.plugin.bridge.openSession(
            this.newCardCap(),
            filter,
            s.randomizeDeckOrder,
            newShare,
        );
        const introducesNewCard = session?.isNewCard === true;
        if (session) {
            const eligible =
                `(eligible: due ${session.eligibleDue}, new ${session.eligibleNew}, reviewed today ${session.reviewedToday ?? "?"}` +
                (newShare !== null ? `) (new share ${s.newCardRatio}%)` : ")");
            if (introducesNewCard) {
                log(
                    `picked a new card ${eligible}` +
                        (s.newCardsMode === "limited"
                            ? ` — ${this.newCardsShownToday() + 1}/${s.newCardsPerDay} today`
                            : ""),
                );
            } else {
                log(`picked a due card ${eligible}`);
            }
        }
        if (!session) {
            log("no card matches (nothing due, no new-card budget left, or filtered out)");
            if (mode !== "manual") this.nothingDueUntil = Date.now() + NOTHING_DUE_BACKOFF_MS;
            else notify(t("nothingDue"));
            return;
        }
        this.nothingDueUntil = 0;
        if (introducesNewCard) {
            const today = this.todayKey();
            if (s.newCardsShownDate !== today) {
                s.newCardsShownDate = today;
                s.newCardsShownCount = 0;
            }
            s.newCardsShownCount++;
        }
        s.lastShownAt = Date.now();
        await this.plugin.saveSettings();
        const shown = await this.plugin.popup.show(
            session,
            s.autoCloseSeconds,
            s.showDeckName,
            focusPopup,
        );
        if (!shown) {
            log("popup window failed to open");
            if (mode === "manual") notify(t("popupFailed"));
        }
    }
}

/** Do-not-disturb check; supports ranges that cross midnight (e.g. 23:00–07:00). */
export function isInQuietHours(now: Date, start: string, end: string): boolean {
    const a = parseHhmm(start);
    const b = parseHhmm(end);
    if (a === null || b === null || a === b) return false;
    const cur = now.getHours() * 60 + now.getMinutes();
    return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

/** Next moment the do-not-disturb window ends (call only while inside the window). */
export function quietHoursEndDate(now: Date, end: string): Date | null {
    const min = parseHhmm(end);
    if (min === null) return null;
    const d = new Date(now);
    d.setHours(Math.floor(min / 60), min % 60, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d;
}

function parseHhmm(hhmm: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}
