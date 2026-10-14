import { diffArrays } from "diff";
import { App, MarkdownView, TFile, moment } from "obsidian";
import type { ActiveQuestion } from "./review-state";

const SR_PLUGIN_ID = "obsidian-spaced-repetition";

// ---------------------------------------------------------------------------
// Structural types for the Spaced Repetition internals this plugin touches.
// They mirror obsidian-spaced-repetition v1.15.4. Every member is optional and
// probed before use, so an incompatible future SR version fails the probe
// instead of crashing or writing through an unknown code path.
// ---------------------------------------------------------------------------

interface AppWithPlugins extends App {
    plugins?: {
        enabledPlugins?: Set<string>;
        plugins?: Record<string, unknown>;
    };
}

interface SRSettingsLike {
    flashcardAgainText?: unknown;
    flashcardHardText?: unknown;
    flashcardGoodText?: unknown;
    flashcardEasyText?: unknown;
    showIntervalInReviewButtons?: unknown;
    /** "Start of day" ("HH:mm:ss", default "00:00:00"). */
    startOfDay?: unknown;
}

interface SRTopicPath {
    path?: unknown;
}

interface SRDeck {
    deckName?: unknown;
    subdecks?: unknown;
    /** Every scheduled card of this deck (including ones not yet due). */
    dueRepItems?: unknown;
    /** Every new (never reviewed) card of this deck. */
    newRepItems?: unknown;
    getTopicPath?: () => SRTopicPath | undefined;
    getDistinctRepItemCount?: (repItemType: number, includeSubdecks: boolean) => number;
}

interface SRQuestionText {
    obsidianBlockId?: unknown;
    /** The card's full text as SR believes it is in the note (replaced by the new text after a successful write). */
    original?: unknown;
}

/** SR's ISRFile (SrTFile wraps a TFile; `path` is the vault-relative path). */
interface SRNoteFile {
    path?: unknown;
}

interface SRNote {
    file?: SRNoteFile;
}

/** SR's ParsedQuestionInfo: the question's 0-based line range in its note (inclusive). */
interface SRParsedQuestionInfo {
    firstLineNum?: unknown;
    lastLineNum?: unknown;
}

interface SRQuestion {
    note?: SRNote;
    /** Getter over parsedQuestionInfo.firstLineNum — may throw. */
    lineNo?: unknown;
    questionText?: SRQuestionText;
    parsedQuestionInfo?: SRParsedQuestionInfo;
    /** The cards this question expands to (e.g. both directions of a bidirectional card). */
    cards?: unknown;
}

interface SRCard {
    front?: unknown;
    back?: unknown;
    hasSchedule?: unknown;
    question?: SRQuestion;
    scheduleInfo?: SRScheduleInfoLike | null;
}

/** SR's RepItemScheduleInfo (OSR or FSRS): interval in days; dueDateAsUnix is a getter. */
interface SRScheduleInfoLike {
    interval?: unknown;
    dueDateAsUnix?: unknown;
    algorithmType?: unknown;
    /** FSRS only: moment or null. */
    lastReview?: unknown;
}

interface SRSequencer {
    hasCurrentCard?: unknown;
    currentCard?: SRCard | null;
    currentDeck?: SRDeck | null;
    processReview?: (response: number) => Promise<void>;
    /** Drops the current card's whole question (all sibling cards) from the in-memory queue. */
    skipCurrentCard?: () => void;
    /** Drops only the current card from the in-memory queue (its siblings stay). */
    deleteCurrentCard?: () => void;
    /** Same API the SR modal uses when the user picks a deck from the deck list. */
    setCurrentDeck?: (topicPath: SRTopicPath) => void;
    /** Pure preview of the schedule a rating would produce (what SR's own buttons show). */
    determineCardSchedule?: (response: number, card: SRCard) => SRScheduleInfoLike | null | undefined;
}

interface SRReviewQueueLoader {
    loadReviewQueue?: () => Promise<SRSequencer>;
}

interface SRTabViewManager {
    openSRTabView?: (loader: SRReviewQueueLoader) => Promise<void>;
}

interface SRUIManager {
    openDeckContainer?: (reviewMode: number) => Promise<void>;
    openFlashcardModal?: (loader: SRReviewQueueLoader) => void;
    focusObsidianWindow?: () => void;
    getSRInFocusState?: () => boolean;
    tabViewManager?: SRTabViewManager;
}

interface SROsrCore {
    remainingDeckTree?: SRDeck;
    reviewableDeckTree?: SRDeck;
    /** Every card in the vault, rebuilt on each sync. */
    fullDeckTree?: SRDeck | null;
}

interface SRDataManager {
    sync?: () => Promise<void>;
    syncLock?: unknown;
    osrCore?: SROsrCore;
    data?: { settings?: SRSettingsLike };
}

/** The SR plugin instance. dataManager/uiManager are getters that THROW until
 * SR finishes its layout-ready initialization — access them inside try/catch. */
interface SRPluginLike {
    isInitialized?: unknown;
    manifest?: { version?: string };
    dataManager?: SRDataManager;
    uiManager?: SRUIManager;
}

// Enum values verified against obsidian-spaced-repetition v1.15.4 (bundled main.js).
export const ReviewResponse = {
    Easy: 0,
    Good: 1,
    Hard: 2,
    Again: 3,
} as const;
export type ReviewResponseValue = (typeof ReviewResponse)[keyof typeof ReviewResponse];

const REVIEW_MODE_REVIEW = 1;
const REP_ITEM_TYPE_NEW = 0;
const REP_ITEM_TYPE_DUE = 1;
/** Runaway guard for the deck-filter skip loop. */
const MAX_FILTER_SKIPS = 1000;

export interface DeckFilter {
    mode: "all" | "include";
    /** Deck paths like "flashcards/韓国語"; a rule matches the deck itself and all subdecks. */
    paths: string[];
}

/** Trims, strips a leading "#" and trailing "/", and drops empty lines. */
export function normalizeDeckPaths(lines: string[]): string[] {
    return lines
        .map((l) => l.trim().replace(/^#/, "").replace(/\/+$/, ""))
        .filter((l) => l.length > 0);
}

function deckAllowed(deckPath: string, filter: DeckFilter): boolean {
    // An empty target list means "no restriction" — otherwise switching the mode
    // would silently stop all popups until a deck is picked.
    if (filter.mode !== "include" || filter.paths.length === 0) return true;
    return filter.paths.some((p) => deckPath === p || deckPath.startsWith(p + "/"));
}

function asString(value: unknown, fallback: string): string {
    return typeof value === "string" ? value : fallback;
}

/** Port of SR's formatScheduleInterval() thresholds; null when the schedule is unusable. */
function previewFromSchedule(
    schedule: SRScheduleInfoLike | null | undefined,
    now: number,
): IntervalPreview | null {
    const interval = schedule?.interval;
    if (typeof interval !== "number" || !Number.isFinite(interval)) return null;
    const dueUnix = schedule?.dueDateAsUnix;
    if (interval >= 1 || typeof dueUnix !== "number") {
        const months = Math.round(interval / 3.04375) / 10;
        const years = Math.round(interval / 36.525) / 10;
        if (months < 1) return { unit: "days", value: interval };
        if (years < 1) return { unit: "months", value: months };
        return { unit: "years", value: years };
    }
    const totalMinutes = Math.max(1, Math.ceil(Math.max(0, dueUnix - now) / 60_000));
    if (totalMinutes < 60) return { unit: "minutes", value: totalMinutes };
    return { unit: "hours", value: Math.max(1, Math.ceil(totalMinutes / 60)) };
}

/** An inclusive, 0-based line range in a note. */
interface LineRange {
    first: number;
    last: number;
}

/**
 * Maps a line range of `oldText` onto `newText` with a line diff. Lines of the
 * range that survived unchanged give the new range (their min..max). When none
 * survived (every line of the card was edited), the nearest unchanged lines
 * before and after the range act as anchors and the lines strictly between them
 * become the new range. Returns null when the range cannot be placed (deleted).
 */
function mapLineRange(oldText: string, newText: string, range: LineRange): LineRange | null {
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");
    if (range.first < 0 || range.last < range.first || range.last >= oldLines.length) return null;
    const oldToNew = new Array<number>(oldLines.length).fill(-1);
    let o = 0;
    let n = 0;
    for (const part of diffArrays(oldLines, newLines)) {
        if (part.added) {
            n += part.count;
        } else if (part.removed) {
            o += part.count;
        } else {
            for (let i = 0; i < part.count; i++) oldToNew[o + i] = n + i;
            o += part.count;
            n += part.count;
        }
    }
    let lo = Number.POSITIVE_INFINITY;
    let hi = -1;
    for (let i = range.first; i <= range.last; i++) {
        const mapped = oldToNew[i];
        if (mapped < 0) continue;
        lo = Math.min(lo, mapped);
        hi = Math.max(hi, mapped);
    }
    if (hi >= 0) return { first: lo, last: hi };
    let before = -1;
    for (let i = range.first - 1; i >= 0; i--) {
        if (oldToNew[i] >= 0) {
            before = oldToNew[i];
            break;
        }
    }
    let after = newLines.length;
    for (let i = range.last + 1; i < oldLines.length; i++) {
        if (oldToNew[i] >= 0) {
            after = oldToNew[i];
            break;
        }
    }
    const first = before + 1;
    const last = after - 1;
    return first <= last ? { first, last } : null;
}

/** The question's line range from SR's parsedQuestionInfo, or null when unusable. */
function questionLineRange(question: SRQuestion | undefined): LineRange | null {
    const info = question?.parsedQuestionInfo;
    const first = info?.firstLineNum;
    const last = info?.lastLineNum;
    if (typeof first !== "number" || typeof last !== "number") return null;
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first) return null;
    return { first, last };
}

/**
 * What the popup remembers about its card when it opens, so a rating that SR
 * could not write (the card was edited meanwhile) can be re-targeted at the
 * edited card: the note text, the card's line range and its index among the
 * cards of its question.
 */
interface CardSnapshot {
    path: string;
    text: string;
    range: LineRange;
    cardIndex: number;
    /** The deck the card was drawn from (where the re-save looks for it). */
    topicPath: SRTopicPath | undefined;
}

/** Outcome of the automatic re-save after an edit. */
type ResaveOutcome = { ok: true; location: string } | { ok: false; reason: string };

/** Where a card came from, resolved from SR's internals while the session is built. */
interface NoteSource {
    path: string;
    line: number;
    blockId: string | null;
}

type CardKind = "due" | "new";

/**
 * Decides whether the next popup shows a new or a due card. With a fixed
 * `newRatio` (0..1) it applies only when both kinds are available; otherwise
 * (and when newRatio is null) the choice is proportional to the eligible counts.
 */
export function chooseCardKind(
    eligibleDue: number,
    eligibleNew: number,
    newRatio: number | null,
    random: () => number = Math.random,
): CardKind {
    if (newRatio !== null && eligibleDue > 0 && eligibleNew > 0) {
        return random() < newRatio ? "new" : "due";
    }
    return random() * (eligibleDue + eligibleNew) < eligibleNew ? "new" : "due";
}

/** Cards one deck itself holds (excluding subdecks), as counted by SR. */
interface DeckCounts {
    deck: SRDeck;
    due: number;
    fresh: number;
}

export type RatingKey = "again" | "hard" | "good" | "easy";

/**
 * Next-interval preview for one rating button, mirroring SR's
 * formatScheduleInterval(): intervals of a day or more are shown in days /
 * months / years, sub-day FSRS learning steps in minutes / hours.
 */
export interface IntervalPreview {
    unit: "minutes" | "hours" | "days" | "months" | "years";
    value: number;
}

/**
 * Outcome of a rating write. SR swallows a failed write (card text no longer
 * found in the note) without throwing, so the bridge verifies it afterwards:
 * "saved" = the note contains the new card text, "notSaved" = it does not,
 * "unknown" = could not be verified (treated as success by callers).
 * "resaved" = the first write missed because the card had been edited, and the
 * rating was then written (through SR again) to the edited card and verified.
 */
export type RateResult = "saved" | "resaved" | "notSaved" | "unknown";

export interface RateOutcome {
    result: RateResult;
    /** Diagnostics: "path:line" (1-based) the rating was written to; for "resaved" the edited card. */
    location: string | null;
    /** Diagnostics (English): why the automatic re-save was not possible ("notSaved" only). */
    retryFailure?: string;
}

export interface ReviewSession {
    /** Markdown of the question side (cloze deletions already masked by SR's parser). */
    front: string;
    /** Markdown of the answer side. */
    back: string;
    deckName: string | null;
    dueCount: number;
    newCount: number;
    /** Diagnostics: eligible due cards (D) and new cards after the cap (N') the draw was based on. */
    eligibleDue: number;
    eligibleNew: number;
    isNewCard: boolean;
    /** Cards reviewed today (popup and SR's own review view), from SR's schedules; null when unavailable. */
    reviewedToday: number | null;
    /** Button labels as configured in the SR plugin's settings. */
    buttonLabels: { again: string; hard: string; good: string; easy: string };
    /**
     * What each rating would schedule next, for the second line of the buttons.
     * null when SR's "show next review time" setting is off or the preview is
     * unavailable (incompatible internals) — the popup then draws single-line buttons.
     */
    intervals: Record<RatingKey, IntervalPreview | null> | null;
    /**
     * Writes the review through SR's own pipeline (identical to pressing a button in its modal).
     * If the write missed because the card was edited while the popup was open, the edited
     * card is located and the rating is written to it through SR once more ("resaved").
     */
    rate(response: ReviewResponseValue): Promise<RateOutcome>;
    /** Diagnostics: "path:line" (line 1-based) of the card in its note; null when unknown. */
    location: string | null;
    /** Opens the card's source note in Obsidian at the card's line (mirrors SR's own
     * "open note" action). null when the note could not be identified from SR's internals,
     * in which case the popup hides the menu item. Resolves false if the file no longer exists. */
    openNote: (() => Promise<boolean>) | null;
    /**
     * The card's question block as it read when the popup opened (SR's
     * questionText.original — SR swaps that string after a write, so this is a
     * copy) and its note's path. Used to tell external tools whether an edit
     * would touch the open card; null when either is unknown.
     */
    question: ActiveQuestion | null;
}

export type ProbeStatus = "ok" | "missing" | "notReady" | "incompatible";

export interface ProbeResult {
    status: ProbeStatus;
    /** Diagnostic detail (English only, shown in notices/settings). */
    reason?: string;
}

/**
 * The single point of contact with the Spaced Repetition plugin's internals.
 *
 * Everything here relies on unexported internals of SR (verified against v1.15.4),
 * so every access is defensive: if any expected member is missing, probe() fails
 * and the plugin never attempts to write scheduling data through an unknown path.
 */
export class SRBridge {
    constructor(private app: App) {}

    getSRPlugin(): SRPluginLike | null {
        const appPlugins = (this.app as AppWithPlugins).plugins;
        if (!appPlugins?.enabledPlugins?.has(SR_PLUGIN_ID)) return null;
        const instance = appPlugins.plugins?.[SR_PLUGIN_ID];
        return instance ? (instance) : null;
    }

    /**
     * SR's dataManager/uiManager getters THROW until the plugin finishes its
     * layout-ready initialization, so "not ready yet" (transient) must be kept
     * apart from "incompatible" (permanent, warn the user).
     */
    probe(): ProbeResult {
        const sr = this.getSRPlugin();
        if (!sr) return { status: "missing", reason: "Spaced Repetition plugin is not enabled" };
        if (typeof sr.isInitialized !== "boolean")
            return { status: "incompatible", reason: "isInitialized flag not found" };
        if (!sr.isInitialized)
            return { status: "notReady", reason: "Spaced Repetition is still initializing" };
        let dm: SRDataManager | undefined;
        let ui: SRUIManager | undefined;
        try {
            dm = sr.dataManager;
            ui = sr.uiManager;
        } catch {
            return { status: "notReady", reason: "managers not initialized yet" };
        }
        if (typeof dm?.sync !== "function")
            return { status: "incompatible", reason: "dataManager.sync not found" };
        if (typeof ui?.openDeckContainer !== "function")
            return { status: "incompatible", reason: "uiManager.openDeckContainer not found" };
        if (typeof ui?.openFlashcardModal !== "function")
            return { status: "incompatible", reason: "uiManager.openFlashcardModal not found" };
        if (typeof ui?.focusObsidianWindow !== "function")
            return { status: "incompatible", reason: "uiManager.focusObsidianWindow not found" };
        return { status: "ok" };
    }

    /** True while SR's own review UI is in focus (avoid double review sessions). */
    isSRReviewUIOpen(): boolean {
        try {
            return this.getSRPlugin()?.uiManager?.getSRInFocusState?.() === true;
        } catch {
            return false;
        }
    }

    /**
     * All deck paths currently known to SR (from its reviewable deck tree),
     * in tree order, e.g. ["flashcards", "flashcards/韓国語", ...].
     * Empty when SR is not ready — callers should fall back to manual input.
     */
    listDeckPaths(): string[] {
        const result: string[] = [];
        const walk = (deck: SRDeck, prefix: string): void => {
            const subdecks = deck.subdecks;
            if (!Array.isArray(subdecks)) return;
            for (const entry of subdecks as unknown[]) {
                const sub = entry as SRDeck;
                if (typeof sub?.deckName !== "string") continue;
                const path = prefix.length > 0 ? `${prefix}/${sub.deckName}` : sub.deckName;
                result.push(path);
                walk(sub, path);
            }
        };
        try {
            const root = this.getSRPlugin()?.dataManager?.osrCore?.reviewableDeckTree;
            if (root) walk(root, "");
        } catch {
            /* SR not initialized — return what we have */
        }
        return result;
    }

    /**
     * Capture method: temporarily stub the UI-opening and focus-stealing methods of
     * SR's UIManager, run its own openDeckContainer() pipeline (which syncs the
     * vault and builds a ReviewQueueLoader), and grab the loader it would have handed
     * to the review modal. No UI is shown, no focus is taken, and every stub is
     * restored in `finally`. The loader then builds a real FlashcardReviewSequencer.
     */
    private async acquireSequencer(sr: SRPluginLike): Promise<SRSequencer | null> {
        const dm = sr.dataManager;
        const ui = sr.uiManager;
        if (!dm || dm.syncLock === true) return null;
        if (!ui || typeof ui.openDeckContainer !== "function") return null;
        const tvm = ui.tabViewManager;
        // Holder object: TypeScript's control-flow analysis cannot see the
        // assignments made inside the stub closures below.
        const capture: { loader: SRReviewQueueLoader | null } = { loader: null };
        const origModal = ui.openFlashcardModal;
        const origFocus = ui.focusObsidianWindow;
        const origTab = tvm?.openSRTabView;
        ui.focusObsidianWindow = () => {
            /* suppressed while capturing */
        };
        ui.openFlashcardModal = (l: SRReviewQueueLoader) => {
            capture.loader = l;
        };
        if (tvm) {
            tvm.openSRTabView = (l: SRReviewQueueLoader) => {
                capture.loader = l;
                return Promise.resolve();
            };
        }
        try {
            await ui.openDeckContainer(REVIEW_MODE_REVIEW);
        } finally {
            ui.openFlashcardModal = origModal;
            ui.focusObsidianWindow = origFocus;
            if (tvm) tvm.openSRTabView = origTab;
        }
        const loader = capture.loader;
        if (!loader || typeof loader.loadReviewQueue !== "function") return null;
        return await loader.loadReviewQueue();
    }

    /**
     * Opens a one-card review session, or returns null when there is nothing to show
     * (no cards, SR busy, internals incompatible, or no card passes the deck filter).
     *
     * Due and new cards are mixed by the ratio of eligible cards: with D due cards
     * and N' = min(N, newCap) new cards (all passing the deck filter), a new card is
     * chosen with probability N' / (D + N'), otherwise a due card. `newCap` is the
     * remaining new-card allowance (0 = none, Infinity = unlimited).
     *
     * `newRatio` (0..1) fixes the new-card share instead whenever both kinds are
     * available; null keeps the proportional behavior above.
     */
    async openSession(
        newCap: number,
        filter: DeckFilter,
        randomizeDeckOrder: boolean,
        newRatio: number | null,
    ): Promise<ReviewSession | null> {
        const sr = this.getSRPlugin();
        if (!sr) return null;
        let sequencer: SRSequencer | null = null;
        try {
            sequencer = await this.acquireSequencer(sr);
        } catch (e) {
            console.error("[sr-popup-review] failed to acquire review sequencer", e);
            return null;
        }
        if (!sequencer || sequencer.hasCurrentCard !== true) return null;
        const processReview = sequencer.processReview;
        if (typeof processReview !== "function") return null;

        // Decide due vs new by the ratio of eligible cards (the tree is in sync
        // now). New cards are capped by the caller's remaining allowance (newCap).
        const entries = this.collectDeckCounts(sr, filter);
        if (!entries) return null;
        const eligibleDue = entries.reduce((sum, e) => sum + e.due, 0);
        const eligibleNew = Math.min(
            entries.reduce((sum, e) => sum + e.fresh, 0),
            Math.max(0, newCap),
        );
        if (eligibleDue + eligibleNew <= 0) return null;
        const reviewedToday = this.countReviewedToday(sr, filter);
        const kind: CardKind = chooseCardKind(eligibleDue, eligibleNew, newRatio);

        // SR's own deck order is sequential: the first deck in the tree supplies
        // every card until its due pile is empty, which starves later decks when
        // only one card is sampled per popup. Optionally re-position the sequencer
        // onto a deck chosen at random, weighted by the chosen kind's card count,
        // so every card of that kind in the vault has (approximately) equal probability.
        if (randomizeDeckOrder && typeof sequencer.setCurrentDeck === "function") {
            const chosen = this.pickRandomDeck(entries, kind);
            const topicPath =
                typeof chosen?.getTopicPath === "function" ? chosen.getTopicPath() : undefined;
            if (topicPath) {
                try {
                    sequencer.setCurrentDeck(topicPath);
                } catch (e) {
                    console.error(
                        "[sr-popup-review] failed to select a random deck; falling back to SR's deck order",
                        e,
                    );
                }
            }
        }

        // Walk the queue to the first card that passes the deck filter and is of the
        // chosen kind. skipCurrentCard() only mutates the in-memory queue — nothing
        // is written, and the next sync rebuilds the tree.
        let skips = 0;
        while (sequencer.hasCurrentCard === true) {
            const allowed = deckAllowed(this.currentDeckPath(sequencer), filter);
            const isNew = sequencer.currentCard?.hasSchedule !== true;
            if (allowed && (kind === "new" ? isNew : !isNew)) break;
            if (typeof sequencer.skipCurrentCard !== "function" || ++skips > MAX_FILTER_SKIPS)
                return null;
            sequencer.skipCurrentCard();
        }
        if (sequencer.hasCurrentCard !== true) return null;
        const card = sequencer.currentCard;
        if (!card || typeof card.front !== "string" || typeof card.back !== "string") return null;
        const isNewCard = card.hasSchedule !== true;
        // Resolved now, while the sequencer still points at this card: the popup
        // may ask for it much later. null = the menu item is not offered at all.
        const noteSource = this.resolveNoteSource(card);
        // Taken now, while the note still matches what SR parsed: lets a rating
        // that misses because of an edit be re-targeted at the edited card.
        const snapshot = await this.takeSnapshot(sequencer, card, noteSource);

        let dueCount = 0;
        let newCount = 0;
        try {
            const tree = sr.dataManager?.osrCore?.remainingDeckTree;
            if (typeof tree?.getDistinctRepItemCount === "function") {
                dueCount = tree.getDistinctRepItemCount(REP_ITEM_TYPE_DUE, true);
                newCount = tree.getDistinctRepItemCount(REP_ITEM_TYPE_NEW, true);
            }
        } catch {
            /* counts are cosmetic only */
        }

        const deckPath = this.currentDeckPath(sequencer);
        const deckName: string | null = deckPath.length > 0 ? deckPath : null;

        let srSettings: SRSettingsLike | undefined;
        try {
            srSettings = sr.dataManager?.data?.settings;
        } catch {
            /* labels fall back to defaults */
        }
        const buttonLabels = {
            again: asString(srSettings?.flashcardAgainText, "Again"),
            hard: asString(srSettings?.flashcardHardText, "Hard"),
            good: asString(srSettings?.flashcardGoodText, "Good"),
            easy: asString(srSettings?.flashcardEasyText, "Easy"),
        };
        const intervals = this.previewIntervals(sequencer, card, srSettings);

        const boundSequencer = sequencer;
        const location = noteSource ? `${noteSource.path}:${noteSource.line + 1}` : null;
        const question = this.activeQuestion(card, noteSource);
        return {
            front: card.front.trimStart(),
            back: card.back,
            deckName,
            dueCount,
            newCount,
            eligibleDue,
            eligibleNew,
            isNewCard,
            reviewedToday,
            buttonLabels,
            intervals,
            rate: async (response: ReviewResponseValue): Promise<RateOutcome> => {
                await processReview.call(boundSequencer, response);
                const result = await this.verifyWrite(card, noteSource?.path ?? null);
                if (result !== "notSaved") return { result, location };
                if (!snapshot) {
                    return {
                        result,
                        location,
                        retryFailure: "not attempted (no snapshot of the card from when the popup opened)",
                    };
                }
                const resave = await this.resaveAfterEdit(sr, snapshot, response);
                return resave.ok
                    ? { result: "resaved", location: resave.location }
                    : { result: "notSaved", location, retryFailure: resave.reason };
            },
            location,
            openNote: noteSource ? () => this.openNoteAt(noteSource) : null,
            question,
        };
    }

    /** The question block's text right now plus its note; null when either is unavailable. */
    private activeQuestion(card: SRCard, noteSource: NoteSource | null): ActiveQuestion | null {
        try {
            const path = noteSource?.path;
            const text = card.question?.questionText?.original;
            if (typeof path !== "string" || path === "") return null;
            if (typeof text !== "string" || text === "") return null;
            return { path, text };
        } catch {
            return null; // SR's getters may throw
        }
    }

    /**
     * After processReview, checks that the note on disk really contains the card
     * text SR now holds (SR replaces questionText.original with the freshly
     * stamped text only when the write found the old text). Never throws:
     * anything that cannot be checked yields "unknown".
     */
    private async verifyWrite(card: SRCard, path: string | null): Promise<RateResult> {
        try {
            const original = card.question?.questionText?.original;
            if (typeof original !== "string" || original.length === 0 || !path) return "unknown";
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return "unknown";
            const text = await this.app.vault.read(file);
            return text.includes(original) ? "saved" : "notSaved";
        } catch {
            return "unknown";
        }
    }

    /**
     * Records the card's note text, line range and index within its question.
     * Returns null (no automatic re-save later) when any of it is unavailable or
     * the note no longer contains the card text SR parsed (it changed between
     * SR's sync and this read, so the line range would not describe it).
     */
    private async takeSnapshot(
        sequencer: SRSequencer,
        card: SRCard,
        noteSource: NoteSource | null,
    ): Promise<CardSnapshot | null> {
        try {
            if (!noteSource) return null;
            const question = card.question;
            const range = questionLineRange(question);
            const cards = question?.cards;
            const original = question?.questionText?.original;
            if (!range || !Array.isArray(cards) || typeof original !== "string") return null;
            const cardIndex = (cards as unknown[]).indexOf(card);
            if (cardIndex < 0) return null;
            const file = this.app.vault.getAbstractFileByPath(noteSource.path);
            if (!(file instanceof TFile)) return null;
            const text = await this.app.vault.read(file);
            if (original.length === 0 || !text.includes(original)) return null;
            const deck = sequencer.currentDeck;
            const topicPath =
                typeof deck?.getTopicPath === "function" ? deck.getTopicPath() : undefined;
            return { path: noteSource.path, text, range, cardIndex, topicPath };
        } catch {
            return null;
        }
    }

    /**
     * The first write missed because the card was edited while the popup was
     * open. Locates the edited card and writes the same rating to it through
     * SR's own processReview once more — never by writing schedule text itself.
     * Anything uncertain (note gone, card deleted, ambiguous match, card not in
     * the queue) gives up with a reason instead of guessing.
     */
    private async resaveAfterEdit(
        sr: SRPluginLike,
        snapshot: CardSnapshot,
        response: ReviewResponseValue,
    ): Promise<ResaveOutcome> {
        try {
            const file = this.app.vault.getAbstractFileByPath(snapshot.path);
            if (!(file instanceof TFile)) return { ok: false, reason: "note not found (deleted or renamed)" };
            const current = await this.app.vault.read(file);
            const range = mapLineRange(snapshot.text, current, snapshot.range);
            if (!range) return { ok: false, reason: "card range deleted" };

            // Re-sync so SR parses the edited note, and take a fresh queue.
            const sequencer = await this.acquireSequencer(sr);
            if (!sequencer) {
                return { ok: false, reason: "Spaced Repetition is busy or returned no review queue" };
            }
            const processReview = sequencer.processReview;
            if (typeof processReview !== "function") {
                return { ok: false, reason: "processReview not found" };
            }

            // Decided on the whole vault's tree (not only on what the queue walk
            // happens to pass), so a second card in the range is never missed.
            const questions = this.findQuestionsInRange(sr, snapshot.path, range);
            if (!questions) return { ok: false, reason: "deck tree unavailable" };
            if (questions.length !== 1) {
                return { ok: false, reason: `${questions.length} matching questions` };
            }
            const question = questions[0];
            const cards = question.cards;
            const target =
                Array.isArray(cards) && snapshot.cardIndex < cards.length
                    ? ((cards as unknown[])[snapshot.cardIndex] as SRCard | null | undefined)
                    : undefined;
            if (!target) return { ok: false, reason: `card #${snapshot.cardIndex + 1} not found in the edited question` };

            // Bring the sequencer onto the target card, the same way openSession
            // walks the queue (in-memory only). Sibling cards of the target are
            // dropped one by one so the target itself stays in the queue.
            if (snapshot.topicPath && typeof sequencer.setCurrentDeck === "function") {
                try {
                    sequencer.setCurrentDeck(snapshot.topicPath);
                } catch {
                    // The deck itself is gone after the edit (e.g. its tag was changed).
                    return { ok: false, reason: "card's deck not found after the edit" };
                }
            }
            let skips = 0;
            while (sequencer.hasCurrentCard === true && sequencer.currentCard !== target) {
                const isSibling = sequencer.currentCard?.question === question;
                const drop = isSibling ? sequencer.deleteCurrentCard : sequencer.skipCurrentCard;
                if (typeof drop !== "function" || ++skips > MAX_FILTER_SKIPS) break;
                drop.call(sequencer);
            }
            if (sequencer.hasCurrentCard !== true || sequencer.currentCard !== target) {
                return { ok: false, reason: "card not found in queue" };
            }

            await processReview.call(sequencer, response);
            const verified = await this.verifyWrite(target, snapshot.path);
            if (verified !== "saved") return { ok: false, reason: `re-save verification: ${verified}` };
            const line = questionLineRange(question)?.first ?? range.first;
            return { ok: true, location: `${snapshot.path}:${line + 1}` };
        } catch (e) {
            console.error("[sr-popup-review] automatic re-save after an edit failed", e);
            return { ok: false, reason: "exception (see console)" };
        }
    }

    /**
     * Every distinct question of note `path` (from SR's full deck tree, so cards
     * not due are included) whose line range overlaps `range`. A question that
     * sits in several decks is counted once. null when the tree is unavailable.
     */
    private findQuestionsInRange(sr: SRPluginLike, path: string, range: LineRange): SRQuestion[] | null {
        const found = new Set<SRQuestion>();
        const visit = (items: unknown): void => {
            if (!Array.isArray(items)) return;
            for (const item of items as unknown[]) {
                const question = (item as SRCard | null)?.question;
                if (!question || found.has(question) || question.note?.file?.path !== path) continue;
                const r = questionLineRange(question);
                if (r && r.first <= range.last && r.last >= range.first) found.add(question);
            }
        };
        const walk = (deck: SRDeck): void => {
            visit(deck.newRepItems);
            visit(deck.dueRepItems);
            if (!Array.isArray(deck.subdecks)) return;
            for (const sub of deck.subdecks as unknown[]) {
                if (sub) walk(sub);
            }
        };
        try {
            const root = sr.dataManager?.osrCore?.fullDeckTree;
            if (!root) return null;
            walk(root);
        } catch {
            return null;
        }
        return [...found];
    }

    /**
     * Asks SR what each rating would schedule, exactly as its own review view
     * does before drawing the buttons (4 pure calculations, nothing written).
     * Honours SR's "show next review time in the review buttons" setting.
     * Returns null when the preview is unavailable so the popup falls back to
     * single-line buttons instead of showing an error.
     */
    private previewIntervals(
        sequencer: SRSequencer,
        card: SRCard,
        srSettings: SRSettingsLike | undefined,
    ): Record<RatingKey, IntervalPreview | null> | null {
        if (srSettings?.showIntervalInReviewButtons === false) return null;
        if (typeof sequencer.determineCardSchedule !== "function") return null;
        const now = Date.now();
        const preview = (response: ReviewResponseValue): IntervalPreview | null => {
            try {
                // Called as a method (not .call) so the typed return value survives lint.
                return previewFromSchedule(sequencer.determineCardSchedule?.(response, card), now);
            } catch {
                // dueDateAsUnix is a getter; an incompatible SR build may throw.
                return null;
            }
        };
        const result = {
            again: preview(ReviewResponse.Again),
            hard: preview(ReviewResponse.Hard),
            good: preview(ReviewResponse.Good),
            easy: preview(ReviewResponse.Easy),
        };
        return Object.values(result).some((p) => p !== null) ? result : null;
    }

    /**
     * The card's source note, line and block id, read from SR's internals
     * (Question.note.file.path / Question.lineNo / QuestionText.obsidianBlockId,
     * the same members SR's own "jump to card" action uses). Returns null when
     * anything is missing or a getter throws — the feature then stays hidden.
     */
    private resolveNoteSource(card: SRCard): NoteSource | null {
        try {
            const question = card.question;
            if (!question) return null;
            const path = question.note?.file?.path;
            if (typeof path !== "string" || path.length === 0) return null;
            const rawLine = question.lineNo;
            // SR itself uses Math.max(0, lineNo ?? 0).
            const line = typeof rawLine === "number" && rawLine >= 0 ? rawLine : 0;
            const rawBlockId = question.questionText?.obsidianBlockId;
            const blockId =
                typeof rawBlockId === "string" && rawBlockId.length > 0 ? rawBlockId : null;
            return { path, line, blockId };
        } catch {
            // Question.lineNo is a getter; an incompatible SR build may throw.
            return null;
        }
    }

    /**
     * Opens the note in the main Obsidian window, mirroring SR's own
     * _jumpToCurrentCard(). Public Obsidian API only — no SR internals here.
     * The TFile is looked up from the path at open time (rather than being held
     * from the sync), so a renamed or deleted note yields false instead of
     * reviving a stale file handle. Returns false when the note is gone.
     */
    private async openNoteAt(source: NoteSource): Promise<boolean> {
        const file = this.app.vault.getAbstractFileByPath(source.path);
        if (!(file instanceof TFile)) return false;
        const ws = this.app.workspace;
        if (source.blockId) {
            await ws.openLinkText(`${source.path}#${source.blockId}`, source.path, false);
            return true;
        }
        const existing = ws
            .getLeavesOfType("markdown")
            .find((l) => l.view instanceof MarkdownView && l.view.file?.path === source.path);
        const leaf = existing ?? ws.getLeaf("tab");
        await leaf.openFile(file, { eState: { line: source.line } });
        if (existing) ws.setActiveLeaf(existing);
        const view = leaf.view;
        if (view instanceof MarkdownView) {
            view.editor.setCursor({ line: source.line, ch: 0 });
            view.editor.scrollIntoView({
                from: { line: source.line, ch: 0 },
                to: { line: source.line, ch: 0 },
            });
        }
        return true;
    }

    /**
     * Counts the cards reviewed today across the whole vault (popup and SR's own
     * review view alike) from SR's schedule data, so no counter has to be stored.
     * FSRS keeps lastReview; SM-2-OSR does not, so it is reconstructed the way SR
     * itself does: dueDate - interval. Cards are de-duplicated by identity because
     * one card can sit in several decks. Returns null when the tree is unavailable.
     */
    private countReviewedToday(sr: SRPluginLike, filter: DeckFilter): number | null {
        const seen = new Set<unknown>();
        const walk = (deck: SRDeck, path: string): void => {
            if (deckAllowed(path, filter) && Array.isArray(deck.dueRepItems)) {
                for (const card of deck.dueRepItems as unknown[]) seen.add(card);
            }
            if (!Array.isArray(deck.subdecks)) return;
            for (const entry of deck.subdecks as unknown[]) {
                const sub = entry as SRDeck;
                if (typeof sub?.deckName !== "string") continue;
                walk(sub, path.length > 0 ? `${path}/${sub.deckName}` : sub.deckName);
            }
        };
        try {
            const root = sr.dataManager?.osrCore?.fullDeckTree;
            if (!root) return null;
            walk(root, "");
            let count = 0;
            for (const card of seen) {
                if (this.isReviewedToday((card as SRCard | null)?.scheduleInfo)) count++;
            }
            return count;
        } catch {
            return null;
        }
    }

    /**
     * SR's "today" (start of the current SR day) as a moment. SR 1.15.4 behaviour is
     * copied as-is, including its bug: the custom "Start of day" boundary only takes
     * effect when hour, minute AND second are all non-zero (upstream issue #1423).
     * It mirrors what SR actually records as the review date. If SR fixes this, fix
     * it here too. Falls back to the calendar day when the setting is unreadable.
     */
    srToday(): moment.Moment {
        return this.srDayOf(moment());
    }

    /** Start of the SR day that contains `at` (see srToday). */
    private srDayOf(at: moment.Moment): moment.Moment {
        const calendarDay = at.clone().startOf("day");
        let raw: unknown;
        try {
            raw = this.getSRPlugin()?.dataManager?.data?.settings?.startOfDay;
        } catch {
            return calendarDay;
        }
        if (typeof raw !== "string") return calendarDay;
        const m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})$/.exec(raw.trim());
        if (!m) return calendarDay;
        const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (h > 23 || min > 59 || s > 59) return calendarDay;
        // SR's own condition (&&, not ||): any zero component disables the boundary.
        if (h === 0 || min === 0 || s === 0) return calendarDay;
        const boundary = at.clone().hour(h).minute(min).second(s).millisecond(0);
        return at.isBefore(boundary) ? calendarDay.subtract(1, "day") : calendarDay;
    }

    /** True when `at` falls on the same SR day as now (SR days, not calendar days). */
    private isInSRToday(at: moment.Moment): boolean {
        return this.srDayOf(at).isSame(this.srToday(), "day");
    }

    private isReviewedToday(schedule: SRScheduleInfoLike | null | undefined): boolean {
        if (!schedule) return false;
        const last = schedule.lastReview as { valueOf?: () => unknown } | null | undefined;
        if (last && typeof last.valueOf === "function") {
            const ms = last.valueOf();
            // lastReview carries a time of day, so map it to its SR day first.
            if (typeof ms === "number" && Number.isFinite(ms)) return this.isInSRToday(moment(ms));
        }
        const { interval, dueDateAsUnix } = schedule;
        if (
            schedule.algorithmType === "SM-2-OSR" &&
            typeof interval === "number" &&
            Number.isFinite(interval) &&
            typeof dueDateAsUnix === "number" &&
            Number.isFinite(dueDateAsUnix)
        ) {
            // dueDate = SR's "today" + interval, i.e. a day start already: compare days directly.
            return moment(dueDateAsUnix).subtract(interval, "days").isSame(this.srToday(), "day");
        }
        return false;
    }

    /**
     * Walks the remaining deck tree and returns, for every deck that passes the
     * deck filter, the due / new cards that deck itself holds (subdecks are their
     * own entries, so nothing is double counted). Returns null when the tree or
     * its count API is unavailable or throws (fail safe: no card is offered).
     */
    private collectDeckCounts(sr: SRPluginLike, filter: DeckFilter): DeckCounts[] | null {
        const entries: DeckCounts[] = [];
        const collect = (deck: SRDeck, path: string): void => {
            if (typeof deck.getDistinctRepItemCount === "function" && deckAllowed(path, filter)) {
                const due = deck.getDistinctRepItemCount(REP_ITEM_TYPE_DUE, false);
                const fresh = deck.getDistinctRepItemCount(REP_ITEM_TYPE_NEW, false);
                if (due > 0 || fresh > 0) entries.push({ deck, due, fresh });
            }
            const subdecks = deck.subdecks;
            if (!Array.isArray(subdecks)) return;
            for (const entry of subdecks as unknown[]) {
                const sub = entry as SRDeck;
                if (typeof sub?.deckName !== "string") continue;
                collect(sub, path.length > 0 ? `${path}/${sub.deckName}` : sub.deckName);
            }
        };
        try {
            const root = sr.dataManager?.osrCore?.remainingDeckTree;
            if (!root) return null;
            collect(root, "");
        } catch {
            return null;
        }
        return entries;
    }

    /**
     * Picks a deck at random, weighted by the number of cards of `kind` each deck
     * itself holds. Returns null when no deck holds any.
     */
    private pickRandomDeck(entries: DeckCounts[], kind: CardKind): SRDeck | null {
        const weightOf = (e: DeckCounts): number => (kind === "new" ? e.fresh : e.due);
        const candidates = entries.filter((e) => weightOf(e) > 0);
        if (candidates.length === 0) return null;
        let r = Math.random() * candidates.reduce((sum, c) => sum + weightOf(c), 0);
        for (const candidate of candidates) {
            r -= weightOf(candidate);
            if (r < 0) return candidate.deck;
        }
        return candidates[candidates.length - 1].deck;
    }

    /** Full deck path of the current card, e.g. "flashcards/韓国語" ("" if unknown). */
    private currentDeckPath(sequencer: SRSequencer): string {
        try {
            const deck = sequencer.currentDeck;
            const topicPath =
                typeof deck?.getTopicPath === "function" ? deck.getTopicPath() : undefined;
            const path = topicPath?.path;
            if (Array.isArray(path)) {
                return (path as unknown[]).map((p) => String(p)).join("/");
            }
        } catch {
            /* fall through */
        }
        return "";
    }
}
