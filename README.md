# Popup Review for Spaced Repetition

[日本語版 README はこちら / Japanese README](README.ja.md)

Review your [Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition) flashcards without opening Obsidian: a small always-on-top popup appears at regular intervals, shows one due card, and lets you reveal the answer and rate it (Again / Hard / Good / Easy) right in the popup.

Ratings are written through the Spaced Repetition plugin's **own review pipeline** (the same code path as its review modal), so your scheduling data stays fully consistent — no re-implementation of SM-2 or FSRS.

Tested with Spaced Repetition **v1.15.4**.

## How it works

1. A scheduler checks at your configured interval (default: every 2 hours) whether any cards are due.
2. If so, a frameless popup appears at the bottom-right of your primary display — **without stealing focus**. Obsidian can stay minimized.
3. Read the question, click **Show answer** (or press `Space`), then rate the card with the four buttons (or keys `1`–`4`).
4. The rating is saved through Spaced Repetition itself, and the popup closes. Closing the popup without rating writes nothing — the card simply stays due.

## Requirements

- Obsidian **desktop** (Windows / macOS / Linux; the popup uses an Electron window, so mobile is not supported)
- The [Spaced Repetition](https://github.com/st3v3nmw/obsidian-spaced-repetition) plugin, installed and enabled

## Installation

### From the community plugin browser (recommended)

1. Open *Settings → Community plugins → Browse*.
2. Search for **Popup Review** and install **Popup Review for Spaced Repetition**.
3. Enable it in *Settings → Community plugins*.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/uzusio/obsidian-sr-popup-review/releases).
2. Put them into `<your vault>/.obsidian/plugins/sr-popup-review/`.
3. Reload Obsidian and enable **Popup Review for Spaced Repetition**.

## Using the popup

| Interaction | Effect |
| --- | --- |
| Click **Show answer** / press `Space` or `Enter` | Reveals the answer in place |
| Click **Again / Hard / Good / Easy** / press `1`–`4` | Saves the rating and closes |
| Click **✕** / press `Esc` | Closes without saving anything |
| Click **⋯** (next to ✕) | Options menu: open the card's source note at its line (the popup stays open), pause until resumed, or snooze popups for 30 min / 1 h / 3 h |
| Drag the header | Moves the popup |

The rating buttons use the labels you configured in the Spaced Repetition plugin. When Spaced Repetition's "Show next review time in the review buttons" setting is on, each button also shows on a second line the interval that rating would schedule (e.g. `(3d)`). Card text is rendered as Markdown, and cloze deletions are masked exactly as in the normal review modal.

You can also open a popup at any time with the command **"Show review popup now"** (via the command palette).

You can also set a **global shortcut** (in settings) to show a popup with a key combination, even while Obsidian is in the background — Obsidian itself does not come to the foreground, and the popup takes keyboard focus so you can answer with the keyboard right away.

Turn on **Show the popup on a local page** (in settings) to mirror the popup, exactly as it appears, to a local web page (`http://127.0.0.1:27280/` by default). Open that URL in OBS as a browser source, in a browser window you share, or on another monitor — the page follows the popup live (showing the answer, rating, the menu, scrolling, resizing) and stays transparent while no popup is open. The popup is scaled to fill the page by width or height, whichever runs out first (anchored top-left), so in OBS you can add a **Browser** source with the URL at any size and simply resize it on the canvas.

To pause automatic popups, click the **bell icon in the status bar** (bottom right), use the **"Toggle popup pause"** command, or flip the toggle in settings — all three control the same switch. The manual show-popup-now command still works while paused.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Language | Obsidian's default | Interface language of this plugin (English / 日本語) |
| Pause popups | off | Temporarily stop automatic popups (also toggled by the status-bar bell icon and a command) |
| Global shortcut | not set | System-wide key combination that shows a popup even while Obsidian is in the background |
| Show the popup on a local page | off | Mirrors the popup to `http://127.0.0.1:<port>/` (OBS browser source, screen sharing). Port (default 27280) and a copy-URL button appear when on; the row shows whether the page is running or the port is in use |
| Popup interval (minutes) | 120 | How often a popup may appear (minimum 5) |
| Do not disturb | on, 01:00–09:00 | Toggle plus a time range with no popups; supports ranges across midnight |
| Auto-close (seconds) | 90 | Closes an untouched popup (nothing is written); 0 disables |
| New cards | Up to a daily limit (10/day) | Never-reviewed cards are mixed in with due cards in proportion to how many of each are available (with a daily limit, only today's remaining allowance counts): *don't introduce* / *up to a daily limit* / *unlimited* |
| Fixed share of new cards | off | When on, a new card is picked with the share set below whenever both new and due cards are left (instead of in proportion to how many of each are left). Shown unless new cards are off |
| Share of new cards | 67% | Slider (5–95%) shown when the fixed share is on: 67% ≈ 2 out of 3 popups. Once the daily limit is reached, only due cards are shown |
| Randomize deck order | on | Pick each popup card from a random deck (weighted by card count) so every card has a roughly equal chance; off follows Spaced Repetition's sequential deck order |
| Skip popups during fullscreen apps | on | Postpones popups while Windows reports a fullscreen app or presentation (games, slideshows, F11); the card appears within a minute after fullscreen ends. Windows only |
| Deck filter | All decks | *All decks* or *Only listed decks* |
| Deck list | — | Dual-list picker: move decks between *available* and *target* with the add/remove buttons (double-click works too); a target deck also covers its subdecks. Empty target list = all decks |
| Show deck name | on | Shows the deck path in the popup header |
| Check shortly after startup | off | Runs one check ~15 s after Obsidian starts |

The settings tab also shows whether the Spaced Repetition integration is working, and why not if it isn't.

"Today" (today's review count and the daily new-card limit) follows Spaced Repetition's **Start of day** setting. In SR 1.15.4 a bug makes that setting ignored unless hour, minute and second are all non-zero, so to switch days at 5 AM use something like `05:01:01`, then restart Obsidian.

## Working with external tools (Obsidian CLI)

If a script or AI tool edits your flashcard notes while a popup is open, Spaced Repetition may fail to find the card when you rate it. Two commands for Obsidian's command line interface (CLI) let such tools ask first. Enable the command line interface in Obsidian's settings to use them; Obsidian must be running.

`obsidian sr-popup-review:state` — what the popup is doing right now:

```json
{"state":"showing","path":"Cards/Spanish.md","original":"hola::hello\n<!--SR:!2026-10-08,3,250-->"}
```

`state` is `idle`, `preparing` (picking a card), `showing` (a card is open) or `writing` (a rating is being saved). `path` / `original` (the open card's whole question block) are set only while `showing` or `writing`.

`obsidian sr-popup-review:check path=<path> old=<text> new=<text>` — would replacing `old` with `new` (once) in that note disturb the open card?

```json
{"result":"safe","reason":"the open card's text stays intact"}
```

- Edits to other notes, or while no popup is open, are `safe`.
- In the open card's note, an edit is `safe` only when `old` appears exactly once and the card's question block is still there, unchanged and exactly once, after the edit.
- Whenever it cannot tell (a card is being picked or a rating is being saved, the note or text is not found, …) the answer is `unsafe`. Treat a failed command the same way.
- Pass `path` relative to the vault (an absolute path is `unsafe`).
- In `old` / `new`, write a newline as `\n`, a tab as `\t` and a backslash as `\\`. Omit `new` to check a deletion.

## Data safety

- Ratings go through `Spaced Repetition`'s own review sequencer — identical writes to pressing the buttons in its modal (scheduling comment, sibling burying, load balancing, FSRS/SM-2, all of it).
- This plugin depends on internals of the Spaced Repetition plugin, so it **probes every internal it needs before each use**. If a future Spaced Repetition version changes them, popup reviews are disabled with a notice — the plugin never writes through an unknown code path.
- Dismissing or auto-closing a popup writes nothing.
- **Network use**: only while *Show the popup on a local page* is on, the plugin listens on `127.0.0.1` (this computer only). Nothing is sent outside your computer. Other apps on the same computer can read the card currently shown and images inside your vault through that page.

## Known limitations

- Popups appear only while Obsidian is running (minimized is fine).
- The popup is a custom always-on-top window, not an OS notification: it does not appear in the notification center and ignores Focus Assist itself. Fullscreen apps and presentations are detected separately and skipped (see settings).
- Position is fixed to the bottom-right of the primary display for now.

## Changelog

### Unreleased

- **Obsidian CLI commands** `sr-popup-review:state` and `sr-popup-review:check`, so external tools that edit your notes can check whether an edit would disturb the card open in the popup (#9)

### 1.6.0 — 2026-10-10

- "Today" (today's review count and the daily new-card limit) now follows Spaced Repetition's "Start of day" setting
- New setting "Fixed share of new cards" with a "Share of new cards" slider, to introduce new cards at a set rate even while many due cards remain
- Fixed: the deck picker (the two lists of available and target decks) did not appear in the settings when "Only listed decks" was selected

### 1.5.0 — 2026-10-04

- **Global shortcut**: set a system-wide key combination in settings to show a popup even while Obsidian is in the background. Obsidian itself stays in the background, and the popup takes keyboard focus so you can answer right away (#7)
- **Show the popup on a local page**: mirror the popup, exactly as it appears, to a local web page for OBS (browser source), screen sharing, or another browser window. The popup is scaled to fill the page by width or height (#8)
- **New cards are mixed in with due cards** in proportion to how many of each are available (within the daily limit). Previously new cards appeared only once nothing was due, so a due backlog could stop them entirely
- The popup header shows how many cards you reviewed today (including reviews in Spaced Repetition itself), alongside the remaining due and new cards
- Multi-line cards are easier to read: each line of a card gets a little space before the next, and long lines that wrap are indented, so a wrap no longer looks like a new line
- The popup window has a fixed title, "SR Popup Review", so window-capture and automation tools can find it
- When Obsidian is not focused, the result of a manual request (e.g. "no cards to review right now") is also shown as an OS notification
- Fixed: when a card's text was edited while its popup was open, Spaced Repetition silently skipped saving the rating but the popup reported it as saved. The popup now verifies the save; if the card was edited, it finds the edited card and saves the rating to it automatically (through Spaced Repetition), and only tells you when the card cannot be identified
- Fixed: after rating, pausing or snoozing, the plugin could take up to 30 seconds to notice the popup had closed

### 1.4.0 — 2026-09-26

- Status-bar button to show a review popup right away

### 1.3.0 — 2026-09-24

- Rating buttons show the next review interval on a second line, like Spaced Repetition's "Show next review time" (#6)

### 1.2.1 — 2026-09-24

- Fixed: the popup stayed open after quitting Obsidian and could not be closed with ✕ / Esc (#5)

### 1.2.0 — 2026-09-23

- "Open note" in the popup's ⋯ menu (#3)
- Tables in cards are drawn with borders
- Fixed: rating a popup that was left open longer than the interval immediately triggered the next popup (#4)

### 1.1.0 — 2026-09-15

- Resize the popup by dragging its edges; the default size can be set in settings (#1)
- Settings tab rebuilt on Obsidian's declarative settings (searchable); fixed the integration status and schedule lines not updating (#2)

### 1.0.5 — 2026-08-17

- Options menu in the popup header (pause / snooze)
- New-card introduction became an explicit setting: don't introduce / up to a daily limit / unlimited
- The popup interval now counts from when a popup ends, not when it starts

### 1.0.4 — 2026-08-14

- New cards are introduced daily within a limit, instead of never appearing
- Persistent diagnostics log; the settings tab shows when the next popup can appear

### 1.0.3 — 2026-08-10

- Popups are skipped while a fullscreen app or presentation is active (Windows)

### 1.0.2 — 2026-07-21

- Option to randomize the deck order when picking a popup card
- More robust handling of popup windows that were destroyed unexpectedly

### 1.0.1 — 2026-07-16

- Fixes from the community plugin review

### 1.0.0 — 2026-07-14

- First public release

## Development

```bash
npm install
npm run dev    # one-shot build into ../sr-popup-test-vault (see esbuild.config.mjs)
npm run watch  # same, but watch mode
npm run build  # typecheck + production build to repo root
```

Development builds are emitted directly into a **dedicated test vault** (`C:/work/sr-popup-test-vault`). Never point dev builds at a real vault — this plugin writes to SR scheduling data.

## License

MIT
