# Meter

An hourly earnings meter. Start a timer against a project, watch the money accrue in real time, and keep an honest ledger of every session.

Built as a single self-contained HTML file — no server, no install, no build step to run it. Open `dist/meter.html` and it works.

---

## Why it's built this way

Most of the design here exists to avoid a specific way of getting the numbers wrong.

**Elapsed time is derived, never accumulated.** The obvious implementation is `setInterval(() => seconds++, 1000)`. It's also wrong: browsers throttle background tabs to roughly one tick per minute, and a sleeping machine stops ticking entirely. Since you're working while the tab is backgrounded, that's every session. A session instead stores `startedAt` as an epoch integer and computes `now - startedAt` on read. The interval exists only to trigger a re-render — kill it and the stored data is still exact.

**Money is derived from time, and summed as integers.** Earnings are `elapsedMs / 3600000 * rate`, computed fresh, rounded once to minor units at the boundary. Nothing accumulates a running float, and no total is ever cached — deleting a session would immediately make a cached total lie.

**Rates are snapshotted onto sessions.** `project.currentRate` is the default for the *next* session. `session.rate` is what *that* session was worth. Changing your rate can't reach back into recorded work, including a session running right now. Using one field for both jobs is the bug this split prevents.

**A session is a list of segments, not a start/end pair.** Pause and resume append a new `{startedAt, endedAt}` interval, so the gap between them is never billed. Modelling this up front avoids migrating every record later.

**Time is an argument, never ambient.** No function in `src/domain` calls `Date.now()`. The caller passes `now`. That single constraint is what makes the entire rules layer testable without mocking a clock.

**Crash recovery bills the last heartbeat.** A running session writes a `lastTick` every 60 seconds. If the app reopens and finds a session that claims to be running but stopped checking in, it offers to close it at the last heartbeat rather than silently billing the eleven hours you were asleep.

**Idle time shares the state machine but never the total.** Time at the desk that wasn't worked is a session with `kind: 'idle'` — same segments, same pause/resume, same crash recovery. What keeps it out of your earnings is the accessor shape: `sessionsFor()` returns billed sessions only, and idle time has to be asked for by name. A caller that forgets about kind under-reports idle time, which is harmless, rather than inflating income, which is not. Starting either timer stops the other one, on any project, because one person can't bill two things at once.

**Deletes are soft.** Sessions get a `deletedAt` and drop out of totals, with an undo. Hard-deleting financial records with no undo is a decision you regret exactly once.

**Timestamps are UTC epoch integers; only display is localised.** Goal periods bucket in local time, because "this week" means the user's week — but the boundary is derived from a `Date` rather than wall-clock strings, so it stays correct across a DST transition.

---

## Layout

```
src/
  domain/        Pure rules. No React, no storage, no clock.
    time.js        elapsed, running vs paused vs stopped, staleness
    money.js       earnings in minor units, formatting
    sessions.js    start / pause / resume / stop / recover / delete, billed vs idle
    projects.js    create, edit, remove, validate
    goals.js       period boundaries, progress
  storage/
    store.js       the only module that knows where data lives
  ui/              React components; all logic imported from domain/
scripts/build.mjs  bundles everything into one HTML file
tests/             89 tests: unit on domain, integration on the built artifact
desktop/           optional Electron wrapper for a standalone .exe
tools/             Windows desktop-shortcut installer
```

The dependency rule is one-directional: `ui` imports `domain`, `domain` imports nothing. Swap React out and the rules layer is untouched. Swap `storage/store.js` for IndexedDB or an API and nothing above it changes.

---

## Getting started

```bash
npm install
npm run build      # produces dist/meter.html
npm test
```

| Script | What it does |
| --- | --- |
| `npm run build` | Bundle into a single `dist/meter.html` |
| `npm test` | Run all tests |
| `npm run coverage` | Tests with coverage thresholds enforced |
| `npm run lint` | ESLint |
| `npm run check` | Lint, test, and build — what CI runs |
| `npm run icons` | Regenerate the icon set from `scripts/make-icons.py` |
| `npm run desktop` | Package a standalone Windows `.exe` |

`npm run build` must run before `npm test`, because the integration suite drives the built file rather than the source.

---

## Running it

**Just open it.** `dist/meter.html` works by double-clicking. Everything is inlined — React, styles, icons.

**As a desktop app.** Run `tools/Setup Meter.bat` from a folder containing `meter.html` and `meter.ico`. It creates a Desktop shortcut that launches Edge or Chrome in `--app` mode with its own `--user-data-dir`, so you get a separate process, its own taskbar entry, and no browser chrome.

**As a real executable.** `npm run desktop` produces a standalone `Meter.exe` with no browser dependency. It also ships its own copy of Chromium — about 220 MB to run a 280 KB file. Worth it only if the target machine might not have a browser.

Note that Edge and Chrome grey out "Install as an app" for `file://` pages, since installation requires a secure origin. That's why the shortcut route exists.

---

## Testing

```
tests/time.test.js         elapsed time, clock jumps, staleness
tests/money.test.js        rounding, drift, formatting fallbacks
tests/sessions.test.js     the state machine and the rate-snapshot rule
tests/projects.test.js     creation, validation, cascading removal
tests/goals.test.js        period boundaries including DST
tests/app.integration.test.js   the built HTML, driven in jsdom
```

The unit tests are fast because the domain layer is pure. The integration tests are slower but catch what unit tests structurally can't: bundling mistakes, event wiring, and CSS that fails silently. One of them is a regression test for exactly that — project card text was rendering inline because the elements were `<span>`s, so `margin-top` was dropped without any error anywhere.

Cases worth knowing about:

- An 8-hour backgrounded tab still reports exactly 8 hours.
- A backwards clock jump clamps to zero rather than subtracting billable time.
- Starting a session closes any other open session on that project.
- A paused session stays the current session; a stopped one doesn't.
- Changing a project's rate leaves recorded and running sessions alone.
- An overnight crash bills 2 hours to the last heartbeat, not the 11-hour gap.
- Startup reads storage exactly once, and rendering never reads or writes it.
- Weeks start Monday at local midnight, including across a DST shift.
- Idle time never reaches an earnings total, a goal, or the cross-project headline.
- Starting idle stops the billed meter, so the same wall-clock hour is never counted twice.
- A session saved before idle tracking existed still counts as billed.

---

## Data

Everything lives in browser storage under `meter:v1`, as:

```js
Project  { id, name, currentRate, currency, createdAt, sessionGoal, overallGoal }
Session  { id, projectId, kind, rate, currency, createdAt, segments[], closedAt, deletedAt }
Segment  { startedAt, endedAt, lastTick }
```

`kind` is `'billed'` or `'idle'`. Sessions written before idle tracking existed have no `kind` at all, and that absence reads as billed — no migration needed, because nothing about the existing data changed meaning. The key is versioned so a real schema change can migrate rather than clobber.

Browser storage evaporates — a cleared cache takes your ledger with it. **Export a backup** from the projects screen periodically; it writes plain JSON that Restore reads back.

---

## Known gaps

- **No session editing.** You can't correct a session's times after the fact. Decide whether an edit is a mutation or an append-only correction before adding it — it changes the schema.
- **No billing increments.** Time is billed to the second. If you invoice in 15-minute blocks, the ledger and your invoice will disagree.
- **No cross-tab locking.** Two tabs are detected and warned about, but not prevented.
- **Idle time isn't in goals.** Deliberate — a money goal fed by unbilled time is meaningless. If it belongs in goals later, the right shape is a utilisation target, not a second money target.
- **Fonts load from Google Fonts.** First run with no internet falls back to system faces. Layout is unaffected.

## License

MIT
