# Architecture

How Meter is built, and why each decision is the way it is. Most of what
follows exists to avoid a specific way of getting the numbers wrong — the
failure is named alongside the choice that prevents it.

For what the app *does*, see [FEATURES.md](FEATURES.md).

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

---

## Data

Everything lives in browser storage under `meter:v1`, as:

```js
Project    { id, name, currentRate, currency, createdAt, sessionGoal, overallGoal,
             offClock?, company?, status?, statusAt?, paysOnAcceptance? }
Earning    { id, projectId, taskId, kind, cents, currency, at, note, units?, status?, createdAt, deletedAt }
Objective  { id, projectId, text, done, doneAt, createdAt, focusedOn, estimateMs, taskId, deletedAt }
Project  { ..., tasks: [{ id, label, createdAt, rate }] }
Session    { id, projectId, kind, taskId, rate, currency, createdAt, segments[], closedAt, deletedAt, original?, manual? }
Segment  { startedAt, endedAt, lastTick }
```

An `Earning` is money with no duration anywhere on it — no segments, no rate — because it was never paid by the hour. `kind` is `'piece'`, `'bonus'` or `'adjust'`, and `units` records how many accepted items an amount covers. On both sessions and earnings a `status` of `'pending'` or `'cancelled'` says the money has not landed or never will; **absent means settled**, so nothing written before pay states existed changed meaning. `paysOnAcceptance` is absent on ordinary work and `true` where a session should start out pending. `status` is absent on a running project and `'paused'` or `'done'` otherwise — absent reads as running, and one field rather than two flags because a project cannot be both. `statusAt` stamps when it stopped and is cleared on the way back, so a project running again never reports a range that ended. `company` is absent or empty on work with no client named; it is the key every company figure is grouped by, so it can become a record of its own later without a migration. `manual` is absent on anything the meter recorded and `true` on a block entered by hand — absent reads as measured. `objectives` is absent on a store written before they existed and reads as none. `focusedOn` is a local `YYYY-MM-DD` and an objective is today's only while it matches today — so the pick expires on its own rather than needing to be cleared. `estimateMs` and `taskId` are both nullable: an objective with neither is a plain checklist item. `offClock` is absent on a work project and `true` on one you track but don't work — absent reads as work, so nothing written before the setting existed changed meaning. `original` is present only on a corrected session and holds `{ segments, closedAt, correctedAt }` as the meter first recorded them. A task's `rate` is nullable — null means "value each session at the rate it recorded". `taskId` is nullable — sessions without one group under "No task". Projects saved before tasks existed have no `tasks` array and read as having none. `kind` is `'billed'` or `'idle'`. Sessions written before idle tracking existed have no `kind` at all, and that absence reads as billed — no migration needed, because nothing about the existing data changed meaning. The key is versioned so a real schema change can migrate rather than clobber.

Browser storage evaporates — a cleared cache takes your ledger with it. **Export a backup** from the projects screen periodically; it writes plain JSON that Restore reads back.

---

---

## Testing

```
tests/time.test.js         elapsed time, clock jumps, staleness
tests/money.test.js        rounding, drift, formatting fallbacks
tests/sessions.test.js     the state machine and the rate-snapshot rule
tests/projects.test.js     creation, validation, cascading removal, status and companies
tests/goals.test.js        period boundaries including DST, and pacing
tests/earnings.test.js     money without hours, and whether it has landed
tests/performance.test.js  window overlap, calendar buckets, period comparison, the year grid,
                           company rollups, effective rate, streaks
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
