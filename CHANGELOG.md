# Changelog

Notable changes to Meter. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Meter follows
[semantic versioning](README.md#versioning) — where **major** means the stored
ledger changed such that an older build can no longer read it.

## [Unreleased]

### Added

- **A payday for each client, and an Upcoming payments panel that uses it.**
  You set the schedule yourself — weekly (“work in before Monday is paid the
  following Wednesday”) or monthly (“work in before the 1st is paid on the
  15th”) — and the Overview says what lands on which day. Knowing what you have
  earned and knowing when it arrives are different questions, and the app only
  answered the first.
  - The schedule belongs to the **company**, not the project, so every project
    under one client shares it instead of being kept in step by hand. Two
    spellings of a name fold to one record, so two devices cannot end up with
    two schedules that disagree, and one client is one row in the panel however
    its name was typed.
  - A period shuts at a **minute on the client's own clock** — “the week shuts
    Sunday 7pm Eastern” — rather than at midnight here, because seven hours
    across a cutoff is not hours, it is a whole payday. The offset is read off
    the zone at each instant, so a daylight-saving change on either side moves
    the boundary with it. A zone this browser does not know is kept as it was
    saved, and Settings says paydays are worked out on this device's clock
    until it is.
  - A task is paid in the run for the period its **answer** fell in, hours and
    reward together. A payout run covers the tasks accepted during a period, so
    a task handed in on Sunday and accepted on Wednesday missed the period that
    shut on Monday and rides the next one. Work nobody has answered yet has no
    payday, only the earliest it could arrive — “Not before Wed 7 Oct” — and
    only answered work is totalled.
  - A reward shared across several tasks is paid with the last of them to get
    there — accepted, where the project pays once accepted; handed in, where it
    pays as worked — and waits like unreviewed work until then.
  - Every row opens to list the tasks and rewards that make it up, so a figure
    can be accounted for rather than taken on trust. Anything whose payday has
    passed drops off: it arrived, or it is a conversation with the client
    rather than a forecast.
  - A payday is a date on the client's own calendar all the way to the screen,
    so a client east of you is never shown a day early.

- **Money says which task it was for.** Every earning names its task, in the
  list, in the CSV export and on the task itself. A row that read `$10.00 ·
  Per accepted item` told you an amount and a date, which is as much as a bank
  statement tells you — and the question being asked of that list is which
  task has been paid for.
- **A task says where it stands.** Under each one: what has been paid, what is
  accepted and still owed, or **not claimed** — because on work paid on
  acceptance the absence of a line is not a zero, it is work that is done and
  not yet credited, and past thirty tasks that is not a thing you can see by
  reading down a column of amounts.
- **Acceptance in batches.** Pick any number of tasks and move them through
  their life in one go. Approval does not arrive one task at a time and
  neither should the ledger.
- **A second way to be paid for accepted work: an extra rate per hour.** Some
  platforms top up by the hour rather than by the item — $80 as worked and $10
  more for every hour once the task lands, so accepted work is worth $90 an
  hour. A flat per-item amount got this wrong in both directions at once,
  crediting the same for a task that took twenty minutes and one that took six
  hours. A project now chooses which of the two it pays, in Settings, and
  holds exactly one of them.
- **Tasks have a life: submitted, accepted, rejected.** Submitting stops the
  clock on a task for good — no more hours can be recorded against it, by the
  meter or by hand, because the platform priced what it received — and stops a
  meter still running on it. Where the project pays as worked the hours count
  as earned from then; where it pays once accepted they stay pending, with the
  acceptance reward, until the answer. Accepted pays them. Rejected cancels
  their money and the reward with it, while the hours stay on the record and
  in every time figure: the work happened, it simply was not paid for. Any task
  can be handed in, turned down or reopened, whatever the project pays.
  Reopening an answered task puts its money back to pending until it is
  accepted again; reopening one that was only handed in leaves its money where
  it is.
- **The settle bar records when things happened, to the minute.** Submit
  records when the last sitting on the tasks ended, because work is nearly
  always handed in as it is finished; Accepted and Rejected record the minute
  you press them; a time typed in the box is what every button records instead.
  Both times can be corrected in the task editor afterwards. The answer's is the
  one that decides a pay period, so it is kept to the minute of the cutoff.
  Answers recorded before this were stored at noon, and the editor's hint says
  those are the ones worth checking.
- **One reward across many tasks.** "Finish fifty and we pay you X" is a single
  payment naming all fifty. Each of them then reads as paid for without being
  given a share of it — splitting it fifty ways would invent a per-task price
  nobody quoted.
- An earning can be re-filed under a different task, or unfiled, from its row.
- **A note on a task**, for what its name cannot hold — ids, a link, what the
  thing actually is. Asked for when the task is made and editable after, shown
  wherever the task is listed. Nothing groups, matches or reports on it, which
  is the point: the label has to stay short and stable because every figure is
  bucketed by it.
- **A meter can be stopped from any device.** It could be seen from one
  already; stopping it did not stick, because the machine that started it
  stamped a heartbeat every minute and the merge takes the later stamp — so
  the session reopened with the hours it had kept counting. A heartbeat is now
  written without a stamp, a session records which device is holding it, and
  the app looks for news on a timer while something is running.
- **Sync state in the footer**, on every screen rather than only the tab that
  configures it. "Has my phone got this yet?" is asked everywhere.
- **A Today tab, and the app now opens on it.** What you are doing and what to
  start next is why the app gets opened; how a month went is a question nobody
  asks first, and the Overview goes on answering it. Today holds one-click
  restarts of the last few things you ran, what today has come to per project,
  and every day there was work, newest first, seven at a time.
  - A day with nothing in it is absent rather than empty. A fortnight off
    would otherwise be fourteen rows saying nothing between the two days you
    wanted to compare.
  - A sitting that crossed midnight is listed under each day it touched, each
    row carrying that day's share of the hours and the money, so the rows under
    a day add up to its heading — the same overlap split every other screen
    uses. A ledger whose arithmetic does not work in front of you is not one
    anybody goes on trusting.
  - Its figures are work only, as the Overview's are: time off the clock is
    listed with its hours and never counted as earnings. Rejected sittings are
    struck through and pending ones say so, and each day says what is still
    pending after its total.
- The task note is shown beside the sessions when you filter the ledger down
  to that task, with an edit link — filtering to a task is what you do in
  order to work on it, and the ids are the reason you came.
- **A Save button on project settings.** Typing a rate used to take effect the
  moment focus left the box, so a half-typed `4` on the way to `45` was
  briefly the project's real rate. Nothing typed there is saved until asked
  now. The three toggles below it stay immediate: each is one decisive click,
  and Status already has an Undo. What is typed and not saved is kept while the
  panel is closed or the project is left, the closed panel says **Unsaved**,
  and in a browser closing the window asks first.
- **The overlap warning names the sessions it is about**, and opens either
  one. Counting two records and leaving the reader to find them by matching
  timestamps by eye was throwing away work the app had already done. The
  warning you meet while typing in a manual entry names them too, but does not
  link — following a link mid-form would cost the entry you were filling in.
  Correcting a session makes the same check and asks the same “anyway”.
- **The task list sorts** by amount, by the day the work went in, by hours
  taken or by hours lost, either way round, with undated rows kept at the
  bottom whichever way it points.
- **Rejected work says what it cost.** The project card, By project and By
  client name the money withheld beside the hours (“$991.63 cancelled”), so a
  zero next to real hours reads as a fact about the month rather than a fault.
- **Marking sessions against their task's answer asks first.** Mark paid on a
  rejected task's sessions, or Mark pending on an accepted task's, says what
  the mark would claim and waits for “anyway”. Either can be meant; far more
  often it is a row ticked by mistake.
- **Restoring a backup asks first.** It sets the ledger here beside the one in
  the file — projects, sessions and payments, and the dates they span — and
  says that it replaces rather than merges, before either is touched. The Undo
  after it stays.
- **A ledger that cannot be read is kept, not saved over.** Stored data that
  does not parse used to open as an empty ledger, and the first change wrote
  over the original for good. It is now copied to a key of its own before
  anything is written, and a banner offers it as a download, or a backup to
  restore.

### Changed

- An earning's task is stored as `taskIds`, a list, because one payment can
  cover a batch. The singular `taskId` an earlier build wrote is still read and
  never written again, so no record holds two answers to one question.
- A batch of rows changes pay state in one write rather than one write each —
  it was one stamp and one upload per row.
- On work paid once accepted, accepting a task settles its hours along with
  its reward, instead of each session being marked paid by hand.
- The task list speaks the vocabulary the platforms use. What was "Accept"
  is now **Submit**, and the answer that comes back later is **Accepted** or
  **Rejected** — two different days, which the one button had conflated.
- The task picker and the Today tab's one-click starts leave out tasks that
  have been handed in. Offering one would be a start that does nothing, and
  starting a meter closes whatever else is open, so the failure would not have
  been quiet. A handed-in task's name typed under New task says why it takes
  no more time instead.
- The task note is a box rather than a line, and keeps its line breaks. One
  task runs across many sittings and collects an id from each, so what goes in
  it is usually a list that grows.
- A meter found running at startup is only offered back as a crash if THIS
  device opened it. One running elsewhere is neither a crash nor a second tab,
  and closing it at a heartbeat that was never going to arrive would have cut
  hours off work still being done.
- **Comparisons are like for like.** On a period still going, “vs this point
  last week” sets the week so far against last week up to the same weekday and
  time, rather than against the whole of it, which only ever said the week was
  not over. A past period is still compared whole with the whole one before it.
- **Money in two currencies is never added together or divided across.** The
  Overview leads with the currency most of the hours were worked in, gives
  each currency its own hourly figure, over the hours worked in it, and its own
  change against the period before, and charts each amount on its own line. How much rides on one project and
  which paid best by the hour appear only when the period's money is in one
  currency.
- **Money targets count settled money no clock measured** — a bonus, an
  accepted item's price — the way the headline does, on the Overview and on the
  project page. The project page's goal no longer counts money still pending.

### Fixed

- **Editing one task, then another, saved the first one's values onto the
  second** — name, note and rate. Every editor now starts from the thing it
  was opened on: tasks, sessions, the settle prompt, objectives, and the whole
  project page when the project changes underneath it. Removing a session while
  its editor was open no longer takes the page down.
- **A reward could be paid twice.** Rejecting a task, reopening it, handing it
  in again and having it accepted paid the first reward beside a new one, so
  $40 of hours and a $50 item read as $140 earned. A task has one acceptance
  reward, re-priced when the task is handed in again.
- **The app's clock stood still while no meter ran.** A window opened on
  Sunday night still showed Sunday as today on Monday, and dated answers from
  the moment it was opened.
- **The settle bar fixed its time when it opened**, from whatever was ticked
  first, so an acceptance could be stored at the time another task was last
  worked on — a payday early. Its defaults are worked out at the click now.
- **Handing in a task left its meter running**, on work that could take no more
  time, and the extra hour was counted as the task's pay.
- **Today counted time off the clock as work** — eight hours of sleep at a
  snapshot rate read as $70 earned — and priced rejected and pending sittings
  as if they had been paid.
- **Time could be filed under work already handed in**: moved there under a
  typed name, started there with no word, or added by hand while the form said
  “Time added.” and recorded nothing. Each now says which task and why, and
  keeps what was typed.
- **The rate and price boxes saved what they could not read as no rate or
  price at all**, so “12,5” or “-5” cleared what the task had. A decimal comma
  is read as one, and anything else is named under the box. The box that
  prices a task as it is made also read a rate as an item price on hourly work
  with a per-item bonus.
- **Two tasks could share a name**, and the second could no longer be reached
  by it.
- **A correction could lay one session over another**, counting the overlap
  twice, and an end moved before the start was quietly swapped into an hour
  nobody worked.
- **An earning saved with its date cleared counted in no period**, and the CSV
  would have dated it 1970.
- **The CSV exported time off the clock as billed money.** It keeps its hours,
  carries no money and says what it is. The file also starts with a
  byte-order mark, so Excel reads Arabic names and emoji, and a text cell that
  starts with =, +, - or @ is written so Excel shows it rather than runs it.
- **Paydays for clients east of you showed a day early** and dropped off a day
  before they came.
- **Upcoming payments could keep a passed cutoff's date all day**, because it
  was worked out once a day. It is worked out every minute.
- **One client typed two ways was two clients** in By company, though the two
  spellings share one payday.
- **Renaming a project's company dropped its payday**: the schedule was saved
  to the old name. Settings saves it to the company typed, and says so before
  replacing another company's schedule.
- **The activity legend could repeat one boundary**, “to 1h 00m” three times
  over.
- **The backup nudge read “1 record exist”.**
- **At 320px wide the tab bar stuck out**, and every main screen scrolled
  sideways.
- **Opening the desktop app while it was already open showed an error**
  blaming another program for port 47823. The other program was Meter. A
  second copy now just hands over to the first.
- Several hints still described rules that had changed: that handing work in
  settles its money, that rejected hours stay paid, that a payday follows the
  hand-in, and that Paused and Done stop a running meter.
- Tests that seeded work a day or two back failed every Monday, two all-time
  tests failed from 1 to 19 January, and two that put a session across
  midnight failed when the day before had been one the clocks changed on.
- **The activity calendar printed its month labels in the wrong place.** A flex
  item defaults to refusing to shrink below its own text, so each labelled
  column came out 18px wide instead of the 10px asked for, and the error
  compounded left to right. By the far end of the year September sat 80px past
  the week it named, printed over empty space off the end of the grid — which
  read as September missing from every year.
- **A stray backtick in a CSS comment ended the stylesheet**, which is one
  template literal, and took the whole app down with it. Caught by the test
  suite before it left the working tree; the comment now says so.
- **Opening a session from a warning could take the page down.**
  `scrollIntoView` does not exist in every environment, and bringing a row
  into view is not worth a blank screen — the highlight finds it anyway.
- **A piece-rate project's task list quoted `$0.00` against every task**, in
  the column next to what the task had actually been paid. Hourly figures were
  already hidden everywhere else on that kind of project; this one was missed.

## [1.1.0] — 2026-09-26

Minor rather than major: every field added here is absent by default, and an
absent field already had a defined meaning, so a 1.0.0 build reads a 1.1.0
ledger without migrating anything. One caveat to that, recorded because it is
exactly what a version number is supposed to warn you about — deleted projects
are tombstones now rather than removals, and a 1.0.0 build does not know to
hide them, so it would list a project this one deleted.

### Added

- **Per-task pricing.** A task can carry its own hourly rate, a factor — a
  share of the rate snapshotted onto the session — or a price per accepted
  item. They resolve in that order before falling back to the session's
  snapshot. A factor applies to the snapshot and never to the project's
  current rate, so repricing a project cannot reach back into recorded work.
- **A task can be priced at nothing.** Zero and "no price set" are different
  answers: empty inherits the project's figure, `0` says this task pays
  nothing.
- **A settle prompt.** Stopping a meter on work paid per accepted item asks
  what the sitting produced — which reward, how many, and as many lines as it
  took, since one sitting can yield an accepted task and an accepted
  changelist at two different prices. Each line is filed pending against that
  session, and the same question is reachable later from any row.
- **Earnings point at the session that produced them**, so money paid on
  acceptance can be traced back to the hours that earned it.
- **A running bar above every screen**, naming the project, its task, the
  elapsed time and the money as it accrues. It stops the meter from wherever
  you are, and renders nothing at all when nothing is running.
- **A dark theme**, following the system setting, with a Light / Dark / Match
  system switch. The choice is per device and deliberately outside the ledger.
- **The Overview remembers its span** per device instead of reopening on Week.
- `docs/demo-seed.json` — a fictional ledger, for screenshots and for anyone
  who wants to see the app with something in it.
- Screenshots and a GIF in the README, generated by `npm run shots`.

### Changed

- **Piece-rate projects no longer quote hourly figures anywhere.** The header
  names a price per item, session rows quote what they earned, and the minute
  rail is gone — it was counting out an hour nobody is going to be charged for.
- **"Earned without the clock" is "Accepted work"** on projects paid per
  accepted item, where every penny arrives that way.
- The theme switch is three icons rather than three labelled buttons, each
  keeping its name for anyone who cannot see the glyph.
- `DashboardView` split its three largest panels out into `DashboardPanels`.

### Fixed

- **Deleting a project erased every objective and every earning in the
  ledger**, and the backup stamp with them. Undo would have brought them back;
  closing the app first would not have.
- **Sync handed back projects you had deleted.** A record that is simply gone
  carries no evidence it was ever deleted, so the merge read its absence as
  something the other device had not seen yet.
- **A project paid by the hour *and* on acceptance lost its rate**, its minute
  rail and its accruing money. Hiding hourly figures keyed off "has a per-item
  price", when it should have keyed off "has a per-item price and no hourly
  rate".
- Every segmented control in the app stood 12px taller than its own rule asked
  for, from two different things sharing the class `.seg`.
- Every choice on the settings page was a half-page slab, from `.seg-btn`
  being given the `flex:1` that `.seg-btn` exists to avoid.
- In dark mode, the selected tab of a segmented control read as a hole, and
  the activity calendar kept a light scrollbar on a dark panel.
- A test that failed only between midnight and 01:00.

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

[Unreleased]: https://github.com/Ahmed41022/meter/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Ahmed41022/meter/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Ahmed41022/meter/releases/tag/v1.0.0
