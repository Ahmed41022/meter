# Changelog

Notable changes to Meter. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Meter follows
[semantic versioning](README.md#versioning) — where **major** means the stored
ledger changed such that an older build can no longer read it.

## [Unreleased]

## [1.6.0] — 2026-11-25

Minor rather than major: the one new thing stored is a preference, which older
builds ignore. An older build keeps every goal's day midnight to midnight.

### Added

- Goals take the **hours left in the day** into account. A daily goal says what
  is left to do against what is left of today, and when it would be met with the
  meter going. A weekly or monthly one has a share of today, settled as the day
  starts; what today can no longer hold moves to the days after. A money goal
  says how long the rest takes at what its work has earned an hour lately. The
  same on Today, in the Overview's Targets and on a project's page.
- **My day ends at**, in Settings under Defaults, shared by every device. A time
  past midnight moves when a goal's day turns over, so late work counts toward
  the day before. Nothing else moves: other screens keep midnight and pay keeps
  each client's clock.
- A notice, once, when the time left for a goal is nearly all needed.

### Changed

- Where today's share is said, a goal's pace no longer says what it needs a day:
  that figure counted today as a whole day however late it was.

### Fixed

- Goals leave out projects that are paused or done. The form no longer offers
  them, and a goal for one, or for a company with no active project, leaves
  Today and the Overview until it runs again. Manage still lists it.

## [1.5.0] — 2026-11-24

Minor rather than major: everything new is stored in optional fields, on a
project, a task, a session or the preferences, which older builds ignore. An
older build still runs one meter at a time, so starting one there stops the
others.

### Added

- A project can allow **parallel tasks**, in its settings or when it is made.
  Several of its tasks then run at once, and beside any other project; the same
  task never runs twice. Each task's time counts in full.
- A life activity runs beside work instead of ending it. Two life activities
  are still one at a time, and so are two ordinary work projects.
- Every running meter has its own bar, the main one first. Work behind it says
  it is **working in background**, and a parallel task can be made the main one.
- A **minimum time** for a task, set for a whole project, when a task is made, or
  on one task. Its clock counts down, over every sitting on it, and says when it
  is met; the task list says how much is left, and handing one in short warns
  without refusing. No pay depends on it.
- **Goals** on Today: as many as you like, daily, weekly or monthly, in time or
  money, over all work, one company or one project. Each says its pace over the
  days you work, a rest day is never a miss, and a changed target applies from
  that day, so past results stay true. Each shows how its last five periods went
  and says once when it is met. The Overview's Targets lists them beside the
  projects' own.
- **What's new**, told once after an update, on whichever device opens first. The
  version at the foot of the page opens it again.
- **How it pays** in a project's settings: by the hour or per task, where it
  could only be chosen when the project was made. It asks how far the change
  reaches, and past included can be undone.
- Today offers every start that would not stop a running meter, rather than
  none while one runs.

### Changed

- A project paid per task no longer says its hourly rate has to be above zero,
  and its price cannot be saved empty. A sitting or a task on one that does hold
  hourly money shows it.
- Resuming a paused session closes whatever may not run beside it, as starting
  one does.
- Time is reported as counted twice only where the two records may not share
  their hours. The check now also catches a clash with another record between.
- The payment history is worked out many times faster on a large ledger: a time
  zone's clock is asked once a day rather than several times a task, and a task
  is looked up rather than searched for.
- A crash that leaves several meters running asks about each of them.

### Fixed

- Reloading the tab that is running a meter no longer says "Already running"
  as if another tab had it. Tabs of the same browser now ask each other, and
  the warning shows only when another tab answers that it holds the meter.
- A device that has just opened, reloaded or updated learns at once which
  device is running the meter. The device holding it answers the new one's
  hello instead of waiting for its once-a-minute presence, so the running bar
  no longer says "on another device" for up to a minute.

## [1.4.0] — 2026-11-22

Minor rather than major: nothing about how the ledger is stored changed. The
create card writes only fields a project's Settings already wrote, and a
batch's build stamp is information that older builds ignore. The desktop app
now loads its page from the hosted address instead of a bundled copy, and
carries its storage there once on first launch; that moves where the ledger
lives on the machine, not what it is.

### Added

- **Every device keeps itself on the newest version.** Each build is stamped
  with the time of its commit. A device that syncs says which build it runs, in
  each batch it sends and once whenever its live connection opens, and a
  device that hears of a newer one fetches the hosted page past the browser's
  cache and reloads into it, saying "Updating Meter to the latest version…".
  It waits while settings are typed and not saved; a running meter carries on
  through the reload, which no longer raises "Already running". With nobody to
  hear from, it still checks a little after opening, every half hour and on
  coming back on screen. Older builds ignore the stamp.
- **The desktop app runs the hosted app**, so it updates the way a phone does
  instead of waiting to be rebuilt. On its first launch it carries everything
  it keeps (the ledger, the Meter Sync account, preferences) to the hosted
  app's address, once, only into an empty store, and leaves the old copy where
  it was. Offline on that launch, it opens the bundled copy as before and tries
  again next time. A hosted app never loaded and with no connection shows a
  page saying so, with a way to try again.
- **The desktop window matches the app.** No system title bar: the page runs
  to the top in its own colour, with the window's buttons drawn over it in the
  theme the app shows, and the strip they sit in still drags the window. F11
  is real full screen (Escape leaves it). The page's scrollbar and background
  now follow a theme picked in Settings, not only the system's, in the browser
  too.
- **The running bar names the device a meter was started on** ("on Pixel 8"),
  where Meter Sync has heard from it lately, and says "on another device"
  otherwise, instead of "elsewhere".
- **A project can be fully set up when it is made.** The create card now asks
  for the company, suggesting the clients already known and filing the
  project under a known client's own spelling. A client with a payday says
  which, in words; a new client can be given one on the spot, which every
  project under it then shares. "More settings", closed by default, holds the
  rest of a project's own settings: a per-task time limit and what time over
  it pays, the acceptance reward (a flat amount or more per hour), and the
  session and overall goals. Every one of them is optional and can still be
  changed later in the project's Settings; on the Life tab the card offers
  only the goals. The new fields are the ones the project's Settings already
  write, so nothing new is stored.

### Fixed

- **A project with pending money no longer opens on a blank page with live
  rates on.** The pending part of its Earnings heading counted the currencies
  of a figure before asking whether it had been converted into one, and a
  converted figure has none to count. Nothing stored was affected.

## [1.3.0] — 2026-11-22

Minor rather than major: every field and record added here (`prefs`,
`companies[].history`, `receivedOn`, `hoursReceived`, `hoursPayday`,
`hoursReceivedOn`) is absent by default, and an absent field already had a
defined meaning, so a 1.2.0 build reads a 1.3.0 ledger without migrating
anything. Meter Sync keeps its own encrypted copy on the relay and changes
nothing in the stored ledger. The caveat from 1.2.0 still applies, and for
the last time: a 1.2.0 build drops lists it does not know (here, `prefs`)
when it syncs, which 1.3.0 no longer does, so every device that syncs should
run 1.3.0.

### Changed

- **Upcoming payments moved from the Overview to a new Payments tab**, the
  third tab, with every way of answering it intact (paid in full, not yet or
  partly, cancelled, already paid, change date, single lines). The one-time
  question about past paydays is asked from Payments now.
- **Two devices that stamped the same record in the same millisecond now
  agree.** On an exact tie in `updatedAt` the merge used to keep "mine", so each
  device kept its own copy and they disagreed for ever. The copy whose JSON
  sorts greater now wins, the same on every device; identical copies are left
  as they are. Merging also indexes the other side once instead of scanning it
  for every record, which a ledger of a few thousand sessions had made slow.
- **Google Drive stays for now, beside Meter Sync.** A device with no Meter
  Sync account syncs through Drive exactly as before. Once a device has an
  account, Drive no longer syncs by itself there: its panel moves below Meter
  Sync under "Google Drive (being replaced)". Drive keeps working through a
  two-week grace period, and is then removed. Nothing is deleted from your
  Drive.
- **Node 24 is now the toolchain.** `.nvmrc` says 24 and CI, the Pages build
  and the release build read it; `engines` asks for Node 22.13 or later. The
  tests of the relay run on Node's built-in `node:sqlite`, which is why. The
  app itself runs in a browser and is unaffected.

- **Changing a client's payday no longer moves paydays that have passed.**
  Only paydays still to come follow the new schedule; past ones keep their
  dates, so the answers given about them stay with them instead of coming
  back as overdue on other days. A company keeps its old schedules, with the
  moment each was replaced, in an optional `history`.

### Added

- **Meter Sync: encrypted sync through your own Cloudflare relay**, in Settings
  → Sync & backup, replacing Google Drive. A phone and a desktop share one
  account; the ledger is encrypted on the device before it leaves it, and the
  relay only ever holds ciphertext, so its operator cannot read a project, a
  client, an amount or a device name. It is invite-only (an invite code or a
  `#invite=` link makes one account), and the built-in relay runs as "Meter
  Sync". A privacy notice says what the relay can and cannot see before
  anything is made, and an account can be deleted from Settings at any time.
  Changes travel as small batches of whole records, not whole-file copies, and
  while the app is visible a live connection brings another device's edit, or
  a meter started or stopped there, within moments; without one Meter syncs on
  open, after edits and every couple of minutes while a meter runs. A device
  running a meter is shown on the others as "Running on <device>", never
  stored. Local use never waits on any of it.
- **Recovery code, and adding a device.** Creating an account shows a recovery
  code, the vault key as eight groups of eight characters, and will not move on
  until it is ticked as saved; it can be shown again from Settings. A new
  device joins from a code the first one shows under Add a device: scan the QR
  with the phone's camera, or paste or type the code. Both devices then show the
  same six digits, and the first approves. The code holds no key and lives ten
  minutes; it carries a one-time secret the relay never sees, so neither a
  stranger holding the relay's address nor the relay itself can slip into
  pairing. A device can be renamed, and Settings lists the devices with when
  each was last seen.
- **Not built yet, and said so on screen:** removing another device (it needs
  the key changed for everyone who stays; until then a lost device is cut off
  by deleting the account), a screen to type the recovery code on a fresh
  install (the relay already accepts it), and the guided move off Google Drive.
  Keep exporting backups: the recovery code, the JSON export and your other
  devices are the only ways back if every device is lost.
- **Everyone who syncs should run the same version.** A batch carries a format
  number; a build that meets a newer one stops applying it and says "update
  Meter to keep syncing" rather than guess. A list of records that a newer
  build added now survives an older one's sync (see Fixed), and each record is
  replaced whole, so a field an older build does not know is kept, not
  stripped, but two devices on different versions can still show different
  things.
- **Per-account limits, so one account cannot use up a shared free relay:**
  50 MB stored, 2,000 writes a day and 6 devices each, and 25 accounts on a
  relay by default. Over its daily allowance, an account says when it resets
  and keeps everything pending; nothing is lost. If the relay itself is at its
  daily limit every device shows the same paused state and local use goes on.
- **Operating your own relay.** The relay is one Cloudflare Worker and two
  SQLite-backed Durable Objects in `relay/`, on the free plan. `npm run
  relay:deploy` deploys it in one command, with the secrets made once into the
  git-ignored `relay/.admin.json` and handed to Cloudflare without being
  printed. `npm run relay:admin -- ...` makes and revokes invites, lists
  accounts with their sizes and last-seen times (never any content), deletes an
  account, and changes the caps or opens sign-up without an invite. `npm run
  relay:init` is the manual version of the same set-up, and `npm run
  relay:local` runs the real relay on `127.0.0.1:8788` for trying Meter Sync
  with no Cloudflare account. "Use my own relay" points a device at any other
  relay's address.
- **A Payments tab**, third after Work and Life. Upcoming payments sits at the
  top as it was on the Overview. Below it is the history of paydays that have
  passed or been answered, newest first: **By payday**, with a subtotal for
  each date and each month, or **By company**, a statement per currency of what
  was expected, what came, what is still outstanding, what was cancelled and
  the difference. Each payday is paid, partly paid, cancelled, not answered,
  paid line by line, or "Nothing to come" when its deductions cancel it out.
  **Still owed** covers everything not yet paid, overdue and coming, with the
  split shown under it; a partly paid rest counts as coming until the day it
  was moved to has passed. Work still waiting on a review sits on a line of
  its own and is never counted as owed. Both views open with a **Coming**
  section for dated paydays still ahead. A period filter (this month, last month, this year, last
  year, all, or custom days; opening on this year) is remembered on the device
  and applies to both views. **Print** (or Save as PDF) gives a black-on-white
  statement, and **Export CSV** one row per line of each payday for an
  accountant. Money is never added across currencies; with live rates on, a
  "≈" total in the display currency appears beside them. The history is
  derived from the ledger like the forecast and stores nothing new.
- **Single lines marked paid now record the day they were paid**, the payday of
  the row they were on, as `receivedOn` on an earning and `hoursReceivedOn` on
  a task. Older ones, and money added as "already paid", have none, and are
  dated by the payday rules from their hand-in, their acceptance or the day they
  were added, on the client's schedule as it stood then. The statement CSV's
  "Dated by" column says which dates were recorded and which came from the
  schedule. A client with no schedule has no payday, so its money is not in the
  history.

- **Live exchange rates, off by default, and a display currency.** Settings →
  Currency turns them on. Meter then asks `cdn.jsdelivr.net` (and
  `latest.currency-api.pages.dev` if that is down) for today's rates, about
  once a day, from a free public feed (CC0, no key). Only the request for the
  rates is sent: nothing from your ledger leaves the device, and with rates
  off the app never contacts either host. The last good rates are kept on the
  device (`meter:rates`, not synced) and used offline, with their date. The
  section also holds the favourite currencies (add, remove, reorder; only
  current ISO currencies are offered) and a "Refresh now" button with the last
  error. Three new preferences sync: `fxOn`, `displayCurrency` (a code or
  "earned", default USD) and `favourites`.
- **A ▾ beside every headline total** (Today, Overview, Work, a project's
  ledger) opens the favourites and "As earned". The choice is one app-wide
  currency, so every total switches at once. A converted figure is marked
  "≈" and names the rate date; with no usable rates (off, none yet, or a
  currency the feed lacks) only "As earned" works and the menu says why.
- **Summaries follow the display currency**: project cards, Today's rows and
  the Recent day headings, the Overview's By project and By company figures
  with their pending and cancelled amounts, Upcoming payments' heading and
  row totals, a project's Earnings heading, its per-task totals and its
  unearned figure. Individual records (a session, an earning, a payline) stay
  in their own currency, as do rates per hour, goals and answering a payment,
  which always stores the row's own cents.
- **The money sorts can rank in the display currency**: Work cards and By
  project *Earned*, By company *Earned* and *An hour*, and *Amount* on a
  project's Earnings and Sessions rank by converted value as one group when
  every row can be converted, and keep their per-currency grouping otherwise.
- **Sorting on the project lists, with synced defaults.** Work and Life cards
  have a Sort row: Added (today's order), Earned, Recently worked, Name and
  Time, without Earned on Life. The Overview's By project gains Earned, and
  By company gets Time, An hour and Earned, opening on Earned, with the
  unassigned row always last. A project's Earnings list can be sorted Newest
  or by Amount, and its Sessions ledger the same way. Money is never added or
  compared across currencies without a rate: rows are grouped by currency, the one with most
  hours first, biggest first inside each, a row with several currencies is
  placed by its biggest single figure, and rows with no money stay at the
  bottom. Settings → Defaults has one choice per list; six new preferences
  (`cardsSort`, `lifeSort`, `byProjectSort`, `byCompanySort`, `earningsSort`,
  `sessionsSort`) store the order's name, not its direction. A pick on a list
  lasts until you leave it. With one currency every default is the order the
  list already had, apart from By company with several currencies, which is
  now grouped rather than ranked on bare amounts.
- **A Settings tab**, after Life, in four sections. *Appearance* holds the
  theme switch, moved from the footer, which now keeps only the sync status
  and the version. *Defaults* holds choices that follow you between devices;
  the first is which period the Overview opens on: the last one used on this
  device, as before, or always Day, Week, Month, Year or All. *Companies &
  paydays* lists every client with its schedule in words, its project count and
  its next payday, and edits a schedule in place with an Undo; a project's own
  settings link to it. *Sync & backup* now holds Export backup, Restore,
  Export CSV and the Drive sync panel, all moved from the Work tab, with the
  restore confirmation unchanged. The "restore a backup" link on the
  unreadable-ledger banner now goes there.
- **Synced preferences.** A new `prefs` list in the ledger holds one record
  per preference, `{ id, value, createdAt, deletedAt }`, so a change on the
  phone and a different one on the desktop both survive a sync. A value this
  build does not know reads as the default, and a ledger with no `prefs` reads
  as all defaults. They are settings, not work: they never count towards "N
  records exist only in this browser". One caveat, for anyone syncing two
  devices: a 1.2.0 build knows nothing of `prefs`, so it neither shows them nor
  keeps them in its own copy when it syncs, as with to-dos in 1.2.0. A newer
  device still holds them and puts them back on its next sync, but every
  device that syncs should run the same version.
- **Mark single lines of a payment paid, or move them to another day.** Open
  any row in Upcoming payments, overdue, still to come or waiting on a review,
  and each line has a box: a task's hours, its per-item pay, a bonus, a shared
  reward. Tick some and choose Mark paid or Move…; both have an Undo. For when
  a client pays three tasks of a payday and holds the fourth back. Tasks gain
  two optional fields for their hours, `hoursReceived` and `hoursPayday`;
  bonuses and other earnings use the `received` and `payday` they already had.
  Absent means what it did before, so older ledgers read unchanged. A row
  already partly received is still answered as a whole.
- **Upcoming payments' explanation is behind a "?"** beside its heading, a
  short list that opens in place and closes on a second tap or Escape,
  instead of a paragraph above every row.

### Fixed

- **Payment history now goes back to the start of the ledger.** Work on
  tasks that were never handed in or answered, and sittings with no task, had
  no payday and so never reached the history, which then began only where
  tasks started being handed in. Each such sitting is now dated by the period
  it was worked in, on its client's schedule as it stood then, and counted as
  paid on that payday unless an answer says otherwise; an answered payday also
  gains the lines behind it. Only paydays already past are included.
- **Work dated by the schedule counts as received, not only listed.** Paydays
  answered before that work could be dated (the one-time "mark all received")
  recorded only what the forecast listed then, often a lone bonus, so the
  lines showed thousands in paid work that the totals left out. That work is
  now paid on top of the answer, as a line marked paid one by one is, on
  screen, in statements and in the CSV.
- **A deduction comes off its own payday.** A negative adjustment was left out
  of the payday it belonged to, so Upcoming and the history overstated what
  would land by its amount. It is now a line of that payday, the payday's
  figure is the net, and "Paid in full" fills in the net. A payday that nets
  to nothing is not listed as coming.
- **A device no longer drops records it did not recognise when it syncs.**
  Merging only looked at the lists the build knew, so an older device threw
  away, on its next sync, any list a newer build had added. Every list of records is now merged, known or
  not, found by its shape; a value that is not a list keeps mine and takes
  theirs only where mine has none, and the backup date still takes the later.
- **Correcting a session that was paused and closed later billed the pause.**
  The editor offered the moment the session was closed as its end, so any
  correction stretched the last block across the break. It now offers the end
  of the last block. A time box left untouched also keeps its exact seconds
  instead of being rounded down to the minute.
- **Currencies are no longer added together on a project card, a project's
  ledger total or its Earnings heading.** A project holding money in more
  than one currency printed one sum in the project's currency. Each now shows
  every currency as earned ("$40.00 · €5.00"), or one converted figure when a
  display currency is set. A project in a single currency reads as before.

## [1.2.0] — 2026-11-18

Minor rather than major: every field and record added here is absent by
default, and an absent field already had a defined meaning, so a 1.1.0 build
reads a 1.2.0 ledger without migrating anything. One caveat, for anyone
syncing two devices: a 1.1.0 build knows nothing of to-dos or payday answers,
so it neither shows them nor keeps them in its own copy when it syncs. A 1.2.0
device still holds them and puts them back on its next sync, but every
device that syncs should run the same version.

### Added

- **After a payday, say what happened to the payment.** A notice asks, for the
  oldest payday that has passed, whether it was paid in full, cancelled, or not
  yet or only partly received (with the new date for the rest). Type what
  actually came and a difference, $101 for an expected $100, is recorded as an
  adjustment; a cancelled payment comes off your earnings. A payment still to
  come can be marked paid the same way, from its row in Upcoming payments.

- **Mark a payment paid, or give it another date, in Upcoming payments.** Open a
  payday and choose Already paid or Change date; both have an Undo. A payday
  that passes with no answer now stays listed as overdue instead of vanishing,
  and the first time there are any you are asked once whether to mark them all
  as received. The answers are kept in the ledger and sync between devices.

- **Bonuses tied to no task are in Upcoming payments too.** A bonus, adjustment
  or per-item payment with no task is dated by the day you add it, on the
  client's next payday. Where the company has a schedule, the add-earnings form
  asks when it is paid: the next payday (shown as a date), already paid, or
  another of the next six. A chosen payday is a date, and a task's own money
  or a shared reward can be moved or marked paid the same way. Without a
  schedule nothing changes: it counts in your earnings straight away. The
  example ledger `docs/payments-seed.json` now covers all of it.

- **Upcoming payments lists a task's bonuses on lines of their own.** Opening a
  payday used to show one line per task, with its hours, per-item payment,
  bonuses and adjustments added together. Now each kind is a line, named for
  what it is, so a bonus can be told from the time it came with. Every figure
  and date is as it was; the lines only show what already made it up. A task's
  lines sit together, biggest task first, and a negative adjustment is still
  left off, as it always was, since only money coming in is forecast.
  `docs/payments-seed.json` is a fictional ledger for trying it: restore it
  from **Work → Restore** (it replaces the ledger, so use a spare profile or
  back up first) and open the paydays from 18 November to 10 December 2026.

- **A time limit per task, and what the time over it pays.** Some platforms
  pay a task's time in full only up to a limit and the rest at a share of the
  rate — 30%, or nothing. A project can say so in Settings: the first two hours
  of a task's billed time pay the full rate and the time over them its share,
  across all of the task's sittings in the order they happened, split to the
  minute inside the sitting that crossed the line. Idle time does not count. A
  task can carry a limit of its own. Every money figure follows — Today, the
  Overview, the project page, Upcoming payments, goals, the CSV, whose note
  says why a row is less than its hours times its rate — and an hourly bonus
  on acceptance pays the same share of its rate for the time over. While the
  meter runs, the strip counts down the time left at full pay, and as it
  crosses says so once, with a notification where the device allows one.
- **A to-do list at the top of Today**, for anything you mean to do, not only
  work. A to-do is a line and a tick box; it may also name a project, and then
  it offers a one-click start on that project's meter — not while a meter is
  already going, since starting one would stop it, and not on a paused or
  finished project, which takes no time. Ticked ones fold away under
  **Done · 3**, where they can be unticked or cleared together, with an Undo.
  To-dos sync between devices like every other record, and a to-do whose
  project is removed stays on the list, unlinked. A store written before them
  has none, so nothing is migrated.
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
  - Where a project pays as worked, a task is paid in the run for the period
    it was **handed in**, hours and reward together, with nothing waiting on an
    answer. Where it pays once accepted, the **answer** decides: a payout run
    covers the tasks accepted during a period, so a task handed in on Sunday
    and accepted on Wednesday missed the period that shut on Monday and rides
    the next one, and work nobody has answered yet has no payday, only the
    earliest it could arrive — “Not before Wed 7 Oct”.
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
  Both times can be corrected in the task editor afterwards. One of them decides
  a pay period — the answer's where the project pays once accepted, the
  hand-in's where it pays as worked — so both are kept to the minute of the
  cutoff, and every hint says which one counts on that project.
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
  and closing the window asks first, in the desktop app as in a browser.
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

- **The test suite runs in about 30 seconds instead of ten minutes**, with the
  same 1,195 tests. The integration tests slept on fixed waits, about nine of
  every ten minutes; they now wait for what each step needs and fail, naming
  it, when it never comes, while the few that check time passing or nothing
  happening keep a real window longer than the app's tick. Every page a test
  opens is closed after it, and the 7,119-line integration file is twelve
  files by area, so they run side by side. The same planted bugs fail the
  same tests as before, and a stopped clock now fails two more.
- **Changing a project's rate, or its time limit, asks how far back the change
  reaches.** *From now on*: tasks already handed in keep the terms they were
  handed in under, and tasks still open take the new ones along with
  everything recorded from here. *Past included*: every task on the project is
  worked out again, the ones already paid included, except a task with a rate
  or a limit of its own; it can be undone in one step. Until now a new rate
  reached only sessions started after it, so a rate settled halfway through an
  open task left that task's earlier hours on the old one.
- **An open Settings panel follows the project when nobody is editing it.**
  After that Undo, or a change arriving by sync from another device, it kept
  showing what the project used to say, marked as saved. A panel with an
  unsaved edit in it keeps the edit.
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
- **Money targets count the work done**: money no clock measured — a bonus, an
  accepted item's price — as well as the clock's, settled or still waiting on
  an answer, on the Overview and on the project page alike. A goal is there to
  keep the work going, so it does not sit still until somebody reviews it;
  only rejected money is left out. The headline still keeps pending money on a
  line of its own.

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
- **A change against the period before misled at its two ends.** A week that
  earned $1.71 against $2,533 read −100%, a week that earned nothing, because
  −99.93% rounds there; it reads −99.9% now, and −100% is kept for a real drop
  to nothing. And twelve hours against a quarter of one read +4531%, true and
  impossible to picture; past +999% a change is said as a multiple, 47×.
- **On a phone, the second of two date-and-time boxes ran off the screen** —
  a task's hand-in and answer, a session's start and end — and took the page
  with it, so it scrolled sideways. A box like that will not shrink below its
  full reading, and two are wider than a phone; there they now go one under
  the other.

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

[Unreleased]: https://github.com/Ahmed41022/meter/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/Ahmed41022/meter/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/Ahmed41022/meter/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Ahmed41022/meter/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Ahmed41022/meter/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Ahmed41022/meter/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Ahmed41022/meter/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Ahmed41022/meter/releases/tag/v1.0.0
