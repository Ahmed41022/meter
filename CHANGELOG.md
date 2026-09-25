# Changelog

Notable changes to Meter. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Meter follows
[semantic versioning](README.md#versioning) — where **major** means the stored
ledger changed such that an older build can no longer read it.

## [Unreleased]

Nothing yet.

## [1.0.0] — 2026-09-25

First tagged release. Everything below was built before versioning began; it
is recorded here as the baseline rather than as a set of changes.

### Timing and money

- Time a session against a project, with pause and resume, and watch the
  earnings accrue in real time.
- Elapsed time derived from `startedAt` rather than accumulated, so a
  throttled tab or a sleeping machine cannot lose it.
- Rates snapshotted onto each session, with an optional per-task override, so
  changing a project's rate never reaches back into recorded work.
- Crash recovery: a session that stopped checking in is offered back at its
  last heartbeat rather than billing the hours you were asleep.
- Corrections that keep what the meter originally recorded, and are reversible.
- Idle time tracked with the same machinery but held out of every earnings
  total.
- Soft deletes with undo, on sessions and tasks alike.

### Reporting

- Day, week, month, year and all-time reporting across every project at once.
- Goal pacing that says whether you are on course, not just how far along.
- An activity calendar that steps back a whole grid at a time.
- Totals by client, with what an hour actually came to and what share of
  revenue one relationship represents.
- Projects ranked by real hourly worth, over a floor that stops a short
  session inventing a huge rate.
- When you actually work — by weekday and hour, excluding entries whose times
  were never measured.

### Money the clock never measured

- Bonuses, rewards and per-item piece rates recorded as earnings without hours.
- Pending, paid and cancelled states, because work finished is not money
  received.
- Pay-per-task projects, chosen when the project is created.

### Getting it and keeping it

- One self-contained `meter.html`, with no server and no build step to run it.
- A hosted build with a service worker and web manifest, installable on
  Android and usable offline.
- A packaged Windows desktop app.
- Sync through the user's own Google Drive `appDataFolder`, merging per record
  by last write rather than replacing, and reporting overlapping billed time
  instead of absorbing it.
- JSON backup export and restore, a CSV export of every line item, and a nudge
  when the ledger has gone too long without being written to a file.

[Unreleased]: https://github.com/Ahmed41022/meter/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Ahmed41022/meter/releases/tag/v1.0.0
