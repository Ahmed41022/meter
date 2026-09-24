# Meter

An hourly earnings meter. Start a timer against a project, watch the money accrue in real time, and keep an honest ledger of every session. An **Overview** tab reports any day, week or month across every project at once.

Built as a single self-contained HTML file — no server, no install, no build step to run it. Open `dist/meter.html` and it works.

---

## Why it's built this way

Most of the design here exists to avoid a specific way of getting the numbers wrong.

**Elapsed time is derived, never accumulated.** The obvious implementation is `setInterval(() => seconds++, 1000)`. It's also wrong: browsers throttle background tabs to roughly one tick per minute, and a sleeping machine stops ticking entirely. Since you're working while the tab is backgrounded, that's every session. A session instead stores `startedAt` as an epoch integer and computes `now - startedAt` on read. The interval exists only to trigger a re-render — kill it and the stored data is still exact.

**Money is derived from time, and summed as integers.** Earnings are `elapsedMs / 3600000 * rate`, computed fresh, rounded once to minor units at the boundary. Nothing accumulates a running float, and no total is ever cached — deleting a session would immediately make a cached total lie.

**Rates are snapshotted onto sessions, and a task can override them.** `project.currentRate` is the default for the *next* session; `session.rate` is what that session recorded. Changing your project rate can't reach back into recorded work. But that snapshot is a *projection* of what you'll be paid, and the real figure is often settled later — at submission, or when the client says so. So a task can carry a rate, and every session filed under it is valued at that rate instead.

The split that makes this safe: **hours are a measurement, rate is a parameter.** `segments` record what you actually worked and stay immutable. The task rate lives on the task, never overwriting `session.rate`, so the original snapshot survives as an audit trail and clearing the override restores it.

**A session is a list of segments, not a start/end pair.** Pause and resume append a new `{startedAt, endedAt}` interval, so the gap between them is never billed. Modelling this up front avoids migrating every record later.

**Time is an argument, never ambient.** No function in `src/domain` calls `Date.now()`. The caller passes `now`. That single constraint is what makes the entire rules layer testable without mocking a clock.

**Crash recovery bills the last heartbeat.** A running session writes a `lastTick` every 60 seconds. If the app reopens and finds a session that claims to be running but stopped checking in, it offers to close it at the last heartbeat rather than silently billing the eleven hours you were asleep.

**Idle time shares the state machine but never the total.** Time at the desk that wasn't worked is a session with `kind: 'idle'` — same segments, same pause/resume, same crash recovery. What keeps it out of your earnings is the accessor shape: `sessionsFor()` returns billed sessions only, and idle time has to be asked for by name. A caller that forgets about kind under-reports idle time, which is harmless, rather than inflating income, which is not. Starting either timer stops the other one, on any project, because one person can't bill two things at once.

**Tasks are records, not strings on a session.** A free-text label splits on a typo — "1234" and "1234 " become two rows with the earnings divided between them, silently. So a task is a record on the project and a session holds its id, matched trimmed and case-insensitively. Starting the meter asks which task first, as an explicit existing-or-new choice, because that is the moment a duplicate would be created.

**A finished session can be corrected, and the original is kept.** Immutability was there to stop records drifting by accident. But a session you forgot to stop is already wrong, and a wrong figure you can't fix is worse than one you can. What deserves protecting isn't that the number never moves — it's that you can always see what the meter actually recorded. So a correction writes the new window into `segments` and stashes the as-recorded ones under `original`, which only the *first* correction fills: edit twice and `original` still holds the measurement, not your previous guess. Reverting restores it exactly.

Corrections preserve pause structure rather than collapsing a session into one start→end block. Collapsing a session with a four-hour break would silently bill the break — so the editor previews the resulting duration, which is rarely just end minus start.

**Re-filing is separate from correcting.** `taskId` is a label on the record rather than part of it, so moving a session between tasks changes which bucket the same hours report under. That needs no `original` and leaves segments, rate, kind and closedAt untouched — there are tests asserting exactly that.

**Deleting a task unfiles its sessions rather than orphaning them.** The hours stay recorded and reappear under "No task", and the delete is undoable.

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
    projects.js    create, edit, remove, validate, on/off the clock
    goals.js       period boundaries, progress
    tasks.js       task records, label matching, per-task totals, re-filing
    performance.js day / week / month windows, overlap splitting, trends
    objectives.js  what you mean to do, estimates, today's focus
  storage/
    store.js       the only module that knows where data lives
  ui/              React components; all logic imported from domain/
    words.js       work vs off-clock wording, the only thing the flag changes
    Objectives     the list, with spent against estimated
    DashboardView  the Overview tab: what a day, week or month was worth
    charts.jsx     stat tiles and the trend columns
scripts/build.mjs  bundles everything into one HTML file
tests/             261 tests: unit on domain, integration on the built artifact
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

## Reporting performance

The app opens on **Overview**, which reports every project at once for a chosen **Day**, **Week** or **Month**; **Projects** is the tab beside it, and opening one from either place drills into its meter and ledger.

Pick the period, then step back through it with the arrows — last week, the month before. Forward stops at the present, because there is nothing recorded ahead of now.

Each period shows what it earned, billed and idle time with the change against the period before, the billable share of time at the desk, how many days (or hours) saw work, a column chart of when the work happened, and a breakdown by project.

Figures are derived by **overlap**, not by when a session started. A session running 23:30 → 00:30 is half an hour of one day and half an hour of the next, counted in each for exactly the minutes it spent there. That is what makes the numbers agree with one another: the daily bars always add up to the weekly headline, and no hour is ever counted twice or lost at a boundary. Period boundaries are built from calendar fields, so they stay correct across DST — including in zones where the clocks go forward at midnight and a local 00:00 simply doesn't exist that day.

Money is never mixed across currencies. If you bill in two, each is totalled and shown on its own line.

---

## Objectives

What you mean to get done, beside what it actually took.

Each project carries a list — **Objectives** on a work project, **To-do** off the clock. An item can be linked to a task, and then the row reports **est 2h · spent 3h 10m · 150% of estimate**. That pairing is the reason this lives in a timer rather than a to-do app: a checklist can tell you something is finished, and only this can tell you it took half again as long as you thought.

**edit** on an objective changes its text, its estimate and what it tracks under. Linking is editable rather than fixed at creation because the usual order is backwards: you write the objective first and only create the task once you actually start timing it. Link it later and the row immediately reports the hours already on that task.

Objectives are their own records rather than a flag on a task, because the two answer different questions. A task is "which bucket does this time go in" and only exists once there is time to file; an objective is "I intend to do this", which is true before a second has been tracked and sometimes forever ("email the client back"). Deleting a task unfiles its objectives rather than destroying them — the intent outlives the bucket, exactly as a session's hours do.

Star a few as **today** and they gather at the top of the Overview, work and life alike. Today is stored as a local calendar day, not a boolean: a flag would still be set tomorrow morning and would need a nightly job to clear it, which is the same accumulate-versus-derive mistake the timer itself avoids. Ticking an item drops it off today's list, because what is left is the point.

---

## Adding time you didn’t track

**add time** beside the ledger records a block the meter never watched — for the hours you worked and forgot to start it. It previews the duration and the money before committing, takes the rate the project charges now (there is no record of what it charged then; a task rate can still correct it), and leaves a running meter alone: logging Tuesday afternoon is no reason to stop the clock ticking today.

Entries made this way are marked **Added** in the ledger. A block you typed in is different evidence from one the clock measured, and the app rests on being able to tell.

It also checks the window against every other record, on every project. Starting a session closes any other open one precisely because you cannot be in two places at once — but a block entered after the fact can break that rule in a way the timer never could, and two records over the same hour count it twice in both the hours and the money. An overlap is named, listed, and needs an explicit *add it anyway* rather than being silently accepted or flatly refused.

---

## Off the clock

Not everything worth timing is work. Sleep, play, time away from the desk — you may want the history without any of it touching what you earned.

Open a project's **Settings** and set it to **Off the clock**. Its hours stay recorded exactly as before; what changes is how they are counted. Off-clock time never enters earnings, billed hours, billable share, active days, or the project breakdown, and it gets its own panel on the Overview reporting the same period. The project keeps its own meter, ledger and tasks, but shows elapsed time where a work project shows money.

An off-clock project also reads differently. "Ledger", "task" and "Stop and save" are accounting words; applied to sleep or an evening of play they invite you to read the panel as money, which is the one thing it isn't. So tasks become **activities**, the ledger becomes **history**, sessions become **entries**, and the meter says **Start tracking**. The billing-only controls go with them: there is no billed-against-idle split to choose, no minute rail counting out an hour you are going to charge for, and no money goal that could never move. Only the labels change — the records, the timer and every figure underneath are identical, which is why it's a lookup in the UI layer (`src/ui/words.js`) and not a second path through the domain.

The flag is absent on every project written before it existed, and absent reads as work — so nothing already recorded moves, and no migration is needed.

This replaces the workaround of giving a project a rate like `0.00001`. That hides the money and nothing else: the hours still land in billed time, in the billable share and in the breakdown, so a night's sleep still reads as a productive night. Setting the rate near zero was always treating the symptom.

---

## Reporting time per task

The **By task** panel on a project lists every task with hours and earnings, ordered by earnings, with idle time on its own line. Clicking a row filters the ledger to that task so you can check what's actually in it.

To correct filing: open the ledger, tick the sessions, then **Assign to task**. One session or twenty, onto an existing task or a new one. The running session's task can be changed from the chip on the meter face.

**edit** on a ledger row corrects a finished session's start and end — for the times you leave the meter running. It previews the resulting duration and earnings before you commit, keeps what the meter originally recorded, and marks the row "Edited". Undo is available immediately, and "Undo correction" restores the recorded times at any point later.

**edit** on a task row renames it, sets its rate, or deletes it. Setting a rate reprices every session under that task, finished ones included — for when the rate you're actually paid is settled after the work is done. Leave it empty to value each session at the rate it recorded. Deleting warns how many sessions will move to "No task" and can be undone.

## Running it

**Just open it.** `dist/meter.html` works by double-clicking. Everything is inlined — React, styles, icons.

**As a desktop app.** Run `tools/Setup Meter.bat` from a folder containing `meter.html` and `meter.ico`. It creates a Desktop shortcut that launches Edge or Chrome in `--app` mode with its own `--user-data-dir`, so you get a separate process, its own taskbar entry, and no browser chrome.

**As a real executable.** `npm run desktop` packages a standalone `Meter.exe` — its own process, its own taskbar entry, no browser involved. The shell in `desktop/` is more than a wrapper:

- it remembers window size and position between launches
- a second launch focuses the existing window instead of starting a rival process that would fight over the same storage
- closing with a meter still running asks first, since that is exactly how a session ends up billing overnight

That guard reads persisted state directly, because the Electron main process can't import the app's ES modules. The duplicated rule lives in `desktop/running.js` with its own tests — nothing else would notice if it drifted from the domain. Any doubt (corrupt storage, a failed read) resolves to "not running", so a broken guard can never trap you inside the app.

The cost is real: about 220 MB on disk to run a 300 KB file, because it ships its own copy of Chromium. That copy also stops receiving security patches when the pinned Electron does. The shortcut above gets you the same standalone window using the engine Windows already keeps updated, which is why it's listed first.

Note that Edge and Chrome grey out "Install as an app" for `file://` pages, since installation requires a secure origin. That's why the shortcut route exists.

---

## Testing

```
tests/time.test.js         elapsed time, clock jumps, staleness
tests/money.test.js        rounding, drift, formatting fallbacks
tests/sessions.test.js     the state machine and the rate-snapshot rule
tests/projects.test.js     creation, validation, cascading removal
tests/goals.test.js        period boundaries including DST
tests/performance.test.js  window overlap, calendar buckets, period comparison
tests/app.integration.test.js   the built HTML, driven in jsdom
```

The unit tests are fast because the domain layer is pure. The integration tests are slower but catch what unit tests structurally can't: bundling mistakes, event wiring, and CSS that fails silently. They refuse to run against a `dist/` older than `src/` — a failed build leaves the previous bundle in place, and without that check they pass happily against code that doesn't compile. One of them is a regression test for exactly that — project card text was rendering inline because the elements were `<span>`s, so `margin-top` was dropped without any error anywhere.

Cases worth knowing about:

- An 8-hour backgrounded tab still reports exactly 8 hours.
- A backwards clock jump clamps to zero rather than subtracting billable time.
- Starting a session closes any other open session on that project.
- A paused session stays the current session; a stopped one doesn't.
- Changing a project's rate leaves recorded and running sessions alone.
- An overnight crash bills 2 hours to the last heartbeat, not the 11-hour gap.
- Startup reads storage exactly once, and rendering never reads or writes it.
- Two labels differing only by case or whitespace resolve to one task.
- A task's idle hours never land in its earned column.
- Re-filing a session moves its totals between tasks and leaves its hours and rate alone.
- A batch re-file skips deleted sessions.
- A task rate reprices finished sessions without touching their hours or their original snapshot.
- Clearing a task rate restores the recorded rate.
- Deleting a task keeps its hours and moves them to "No task".
- Correcting a session with a four-hour break bills 45m, not 5h45m.
- A second correction still preserves what the meter first recorded.
- A running session offers no edit link — stop it first.
- The desktop quit-guard treats a paused session as not running, and resolves any doubt as "safe to close".
- A long ledger starts collapsed, and its totals stay visible while collapsed.
- Weeks start Monday at local midnight, including across a DST shift — and including a week containing a day that has no local midnight at all.
- A session running 23:30 to 00:30 gives each day 30 minutes, and the week the full hour.
- Every day of a calendar year abuts the next exactly: no window overlaps its neighbour, and no bucket falls in a gap between them.
- A day that loses or gains an hour to DST is charted with 23 or 25 bars, and they still tile it exactly.
- The trend bars always sum to the headline figure for the period.
- Stepping a month back from the 31st lands on the 1st of the previous month, not in the one after it.
- A period with no predecessor reports no comparison rather than +0%.
- Off-clock hours never reach earnings, billed time, billable share or the breakdown — while the same data left on the clock inflates all four.
- A project with no `offClock` flag counts as work, so nothing recorded before the setting existed moves.
- A session whose project has been deleted counts as work, so reporting fails towards showing time you did record.
- Moving a project off the clock and back changes only how its hours are counted, never the hours.
- An off-clock project says activities, history and Start tracking; a work project still says tasks, ledger and Start the meter.
- Off the clock drops the idle split, the billable-hour rail and the money goal, and prints the elapsed figure once rather than twice.
- Work and Life are separate tabs; opening a project returns to the tab it belongs to.
- A life area is created with no rate at all, rather than a rate of zero to be explained away.
- An objective linked to a task reports hours spent against hours estimated; one with no link says so instead of implying zero.
- Deleting a task unfiles its objectives and keeps them.
- Today's focus is a calendar day, so it expires by itself and gathers work and life picks together.
- An objective can be linked to a task after it was written, and reports that task's hours the moment it is.
- A block entered by hand is marked as added, snapshots the current rate, and does not stop a meter that is running.
- Overlapping time is found across every project, ignores blocks that merely meet end to end, skips the gap inside a paused session, and needs explicit confirmation before it is recorded.
- Idle time never reaches an earnings total, a goal, or the cross-project headline.
- Starting idle stops the billed meter, so the same wall-clock hour is never counted twice.
- A session saved before idle tracking existed still counts as billed.

---

## Data

Everything lives in browser storage under `meter:v1`, as:

```js
Project    { id, name, currentRate, currency, createdAt, sessionGoal, overallGoal, offClock? }
Objective  { id, projectId, text, done, doneAt, createdAt, focusedOn, estimateMs, taskId, deletedAt }
Project  { ..., tasks: [{ id, label, createdAt, rate }] }
Session    { id, projectId, kind, taskId, rate, currency, createdAt, segments[], closedAt, deletedAt, original?, manual? }
Segment  { startedAt, endedAt, lastTick }
```

`manual` is absent on anything the meter recorded and `true` on a block entered by hand — absent reads as measured. `objectives` is absent on a store written before they existed and reads as none. `focusedOn` is a local `YYYY-MM-DD` and an objective is today's only while it matches today — so the pick expires on its own rather than needing to be cleared. `estimateMs` and `taskId` are both nullable: an objective with neither is a plain checklist item. `offClock` is absent on a work project and `true` on one you track but don't work — absent reads as work, so nothing written before the setting existed changed meaning. `original` is present only on a corrected session and holds `{ segments, closedAt, correctedAt }` as the meter first recorded them. A task's `rate` is nullable — null means "value each session at the rate it recorded". `taskId` is nullable — sessions without one group under "No task". Projects saved before tasks existed have no `tasks` array and read as having none. `kind` is `'billed'` or `'idle'`. Sessions written before idle tracking existed have no `kind` at all, and that absence reads as billed — no migration needed, because nothing about the existing data changed meaning. The key is versioned so a real schema change can migrate rather than clobber.

Browser storage evaporates — a cleared cache takes your ledger with it. **Export a backup** from the projects screen periodically; it writes plain JSON that Restore reads back.

---

## Known gaps

- **Corrections replace, they don't accumulate.** `original` holds what the meter recorded, and that's it — there's no log of each successive edit or when. Enough to prove a figure was adjusted; not a full audit trail.
- **No re-filing or repricing history.** A session doesn't record that it was moved between tasks, and a task doesn't record that its rate changed or when.
- **No archiving.** A task you've finished with stays in the start prompt's dropdown forever. Delete is the only way out, and that unfiles its sessions.
- **No cross-project task view.** Tasks belong to one project, so a task number spanning two projects reports as two separate tasks.
- **No billing increments.** Time is billed to the second. If you invoice in 15-minute blocks, the ledger and your invoice will disagree.
- **No cross-tab locking.** Two tabs are detected and warned about, but not prevented.
- **Idle time isn't in goals.** Deliberate — a money goal fed by unbilled time is meaningless. If it belongs in goals later, the right shape is a utilisation target, not a second money target.
- **Fonts load from Google Fonts.** First run with no internet falls back to system faces. Layout is unaffected.

## License

MIT
