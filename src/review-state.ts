/**
 * What the review popup is doing right now, for external tools that edit the
 * vault (answered through Obsidian's CLI, see main.ts). Kept free of Obsidian
 * and Spaced Repetition internals so the logic stays plain and checkable.
 *
 * Every state is held as a counter/set rather than a single flag, so overlaps
 * (a write that outlived its popup while the next session is being prepared)
 * resolve by priority instead of one ending clobbering another.
 */

/** The question block the popup opened with (SR's questionText.original) and its note. */
export interface ActiveQuestion {
    path: string;
    text: string;
}

export type ReviewStateName = "idle" | "preparing" | "showing" | "writing";

export interface ReviewStateSnapshot {
    state: ReviewStateName;
    /** The question being written (writing) or shown (showing); null otherwise or when unknown. */
    path: string | null;
    original: string | null;
}

/** Holder for one begin…() call; `q` is null for preparing. */
interface Entry {
    q: ActiveQuestion | null;
}

export class ReviewStateTracker {
    private preparing = new Set<Entry>();
    private showing = new Set<Entry>();
    private writing = new Set<Entry>();

    /** From just before a session is opened until the popup is shown (or not). */
    beginPreparing(): () => void {
        return this.begin(this.preparing, null);
    }

    /** While a popup holds a session; `q` null = the card could not be identified. */
    beginShowing(q: ActiveQuestion | null): () => void {
        return this.begin(this.showing, q);
    }

    /** From the moment a rating is handed to SR until that write settles. */
    beginWrite(q: ActiveQuestion | null): () => void {
        return this.begin(this.writing, q);
    }

    /** Priority: writing > preparing > showing > idle. */
    snapshot(): ReviewStateSnapshot {
        if (this.writing.size > 0) return withQuestion("writing", latest(this.writing));
        if (this.preparing.size > 0) return { state: "preparing", path: null, original: null };
        if (this.showing.size > 0) return withQuestion("showing", latest(this.showing));
        return { state: "idle", path: null, original: null };
    }

    /** Returns an idempotent end function. */
    private begin(set: Set<Entry>, q: ActiveQuestion | null): () => void {
        const entry: Entry = { q };
        set.add(entry);
        return () => {
            set.delete(entry);
        };
    }
}

/** The most recently begun entry (Sets iterate in insertion order). */
function latest(set: Set<Entry>): Entry | null {
    let last: Entry | null = null;
    for (const e of set) last = e;
    return last;
}

function withQuestion(state: ReviewStateName, entry: Entry | null): ReviewStateSnapshot {
    const q = entry?.q ?? null;
    return { state, path: q?.path ?? null, original: q?.text ?? null };
}

export type CheckResult = { result: "safe" | "unsafe"; reason: string };

const safe = (reason: string): CheckResult => ({ result: "safe", reason });
const unsafe = (reason: string): CheckResult => ({ result: "unsafe", reason });

/** Non-overlapping occurrences of `needle` in `haystack` (needle must be non-empty). */
function countOccurrences(haystack: string, needle: string): number {
    let count = 0;
    let from = 0;
    for (;;) {
        const i = haystack.indexOf(needle, from);
        if (i < 0) return count;
        count++;
        from = i + needle.length;
    }
}

/**
 * Would replacing `oldText` with `newText` (once) in the note at `path` touch
 * the card the popup is reviewing? Anything that cannot be decided is unsafe.
 * `path` must already be normalized by the caller.
 */
export async function checkEdit(
    snap: ReviewStateSnapshot,
    path: string,
    readFile: () => Promise<string | null>,
    oldText: string,
    newText: string,
): Promise<CheckResult> {
    if (snap.state === "writing") return unsafe("a rating is being written");
    if (snap.state === "preparing") return unsafe("a review session is being prepared");
    if (snap.state === "idle") return safe("no review popup is open");
    if (snap.path === null || snap.original === null) return unsafe("the open card could not be identified");
    // Case-insensitive: on Windows "Cards.md" and "cards.md" are the same file, and
    // treating a different-case path as the same note only leads to the stricter check.
    if (path.toLowerCase() !== snap.path.toLowerCase()) return safe("different note from the open card");

    const content = await readFile();
    if (content === null) return unsafe("note not found");
    if (oldText.length === 0) return unsafe("old text is empty");
    const oldCount = countOccurrences(content, oldText);
    if (oldCount === 0) return unsafe("old text not found");
    if (oldCount > 1) return unsafe("old text is not unique");
    const original = snap.original;
    if (original.length === 0 || countOccurrences(content, original) !== 1) {
        return unsafe("card text not found exactly once in the note");
    }
    // indexOf + slice, not String.replace: "$&" etc. in newText must stay literal.
    const at = content.indexOf(oldText);
    const edited = content.slice(0, at) + newText + content.slice(at + oldText.length);
    if (countOccurrences(edited, original) !== 1) {
        return unsafe("the edit would change or duplicate the open card's text");
    }
    return safe("the open card's text stays intact");
}

/**
 * Obsidian's CLI hands flag values over without turning "\n" into a newline.
 * Reversible escapes: \\ → \, \n → LF, \t → TAB, \r → CR; any other "\x" is
 * kept as both characters (so a literal "\n" in card text is written "\\n").
 */
export function decodeCliText(raw: string): string {
    let out = "";
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c !== "\\" || i + 1 >= raw.length) {
            out += c;
            continue;
        }
        const next = raw[i + 1];
        if (next === "\\") out += "\\";
        else if (next === "n") out += "\n";
        else if (next === "t") out += "\t";
        else if (next === "r") out += "\r";
        else out += c + next;
        i++;
    }
    return out;
}
