# Features

A tour of what Meter does, screen by screen. For why any of it is built the
way it is, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Layout

```
src/
  domain/        Pure rules. No React, no storage, no clock.
    time.js        elapsed, running vs paused vs stopped, staleness
    money.js       earnings in minor units, formatting
    sessions.js    start / pause / resume / stop / recover / delete, billed vs idle
    projects.js    create, edit, remove, validate, on/off the clock, companies
    goals.js       period boundaries, progress, pacing
    tasks.js       task records, label matching, per-task totals, rates and prices
    taskState.js   a task's life: open, submitted, accepted, rejected
    settle.js      what submitting, answering and reopening do to the money
    earnings.js    money with no duration, pay states, how a project pays
    payPeriod.js   a client's payday: cutoff, zone, the run a time falls in
    payout.js      Upcoming payments: what lands on which day
    performance.js windows, overlap splitting, trends, comparisons, rollups
    recent.js      Today's lists: what to restart, every day there was work
    rhythm.js      when in the day and week the work happens
    objectives.js  what you mean to do, estimates, today's focus
    csv.js         the line-item export
    merge.js       sync: last write wins, record by record
    backup.js      how long since the ledger was last copied out
  storage/
    store.js       the only module that knows where data lives
    settings.js    per-device choices that are not part of the ledger
  ui/              React components; all logic imported from domain/
    words.js       work vs off-clock wording, the only thing the flag changes
    TodayView      the Today tab: today so far, and the days before it
    DashboardView  the Overview tab: what a day, week or month was worth
    ProjectView    one project: the meter, its tasks, its ledger, its settings
    charts.jsx     stat tiles, the trend columns and the activity calendar
scripts/build.mjs  bundles everything into one HTML file, and the web app beside it
tests/             unit tests on domain and storage, integration tests on the built file
desktop/           optional Electron wrapper for a standalone .exe
tools/             Windows desktop-shortcut installer
```

The dependency rule is one-directional: `ui` imports `domain`, `domain` imports nothing. Swap React out and the rules layer is untouched. Swap `storage/store.js` for IndexedDB or an API and nothing above it changes.

---

---

## Today

The app opens on **Today**, because what you are doing and what to start next is why it gets opened. It holds one-click restarts of the last few things you ran, what today has come to per project, and every day there was work, newest first, seven at a time. A day with nothing in it is absent rather than empty.

Every figure there is work, computed the way the Overview computes the same day. Time off the clock is listed with its hours and never counted as earnings; a rejected sitting is struck through and a pending one says so, and each day says what is still pending after its total.

A sitting that crossed midnight is listed under **each** day it touched, and each row carries that day's share of its hours and its money — *2h 00m of 3h 00m* under Monday, *1h 00m of 3h 00m · ran past midnight* under Sunday — so the rows under a day add up to its heading.

---

---

## Reporting performance

**Overview** reports every project at once for a chosen **Day**, **Week**, **Month**, **Year** or **All** of it. **Today**, **Work** and **Life** are the tabs beside it — the app opens on Today — and opening a project from any of them drills into its meter and ledger.

Pick the period, then step back through it with the arrows — last week, the month before. Forward stops at the present, because there is nothing recorded ahead of now.

Each period shows what it earned, billed and idle time with the change against the period before, the billable share of time at the desk, how many days (or hours, or months) saw work, a column chart of when the work happened, and a breakdown by project.

The change is like for like. A period still going is set against the one before **up to the same point** — this week so far against last week up to the same weekday and time, labelled *vs this point last week* — because a Wednesday's week against the whole of last week only ever says the week is not over. A period already over is compared whole with the whole one before it. The point a month earlier is the same day of the month, clamped to the shorter month, and every one of these instants is built from calendar fields rather than by subtracting milliseconds.

A year reads month by month rather than day by day — 365 bars two pixels wide are a texture, not a chart — and each month is one bucket of its own length, so February is never a gap.

Two panels on that page deliberately ignore the period control: **Targets** and **the activity calendar**. Both answer questions about *now* rather than about the period on screen.

Figures are derived by **overlap**, not by when a session started. A session running 23:30 → 00:30 is half an hour of one day and half an hour of the next, counted in each for exactly the minutes it spent there. That is what makes the numbers agree with one another: the daily bars always add up to the weekly headline, and no hour is ever counted twice or lost at a boundary. Period boundaries are built from calendar fields, so they stay correct across DST — including in zones where the clocks go forward at midnight and a local 00:00 simply doesn't exist that day.

Money is never mixed across currencies. If you bill in two, each is totalled and shown on its own line, led by the currency most of the hours were worked in rather than by whichever number is bigger — EGP 300 is not more than $70. Every per-hour figure divides one currency's money by the hours worked in that currency alone, so each currency gets its own *An hour came to* and its own change; a chart column lists each currency's amount on its own line; and the figures that set projects against each other — how much rides on one, which paid best by the hour — appear only when the period's money is in one currency.

---

---

## Pacing a goal

A goal with a deadline has two questions, and a progress bar only answers one. Half a weekly target is triumphant on Tuesday and a crisis on Sunday, and the bar looks identical either way.

So every goal that resets — weekly or monthly — also reports where it stands:

```
Delta Human Pref  this week            $765.00 / $1,260.00
[==============|==========------------------------------]
$225.00 ahead · 4 days left · needs $123.75/day
```

The mark on the bar is where the **finished days** say you should be. The fill either reaches it or falls short of it, so the standing is readable before the sentence is.

Pacing is measured against days that have **ended**, never against the fraction of the period that has physically elapsed. Elapsed-time pacing declares you behind at 09:00 on Monday for not having worked overnight, and makes the verdict depend on what hour you happen to open the app. Today counts as neither gone nor done: it is the first of the days you have left, because it is still yours to use.

That is generous early in a period, which is why the **required daily rate** is always there too. On Monday morning the drift cannot tell you anything — `needs $180/day` can.

Goals appear on the **Overview** under *Targets*, sorted by how many days' worth off the line each one is, so whatever needs attention is at the top. That panel deliberately ignores the period control above it: "am I on for this week?" is a question about now, and the answer must not change because you stepped the report back to look at last month.

A money target counts the work done: the clock's money and the money no clock measured — a bonus, an accepted item's price — alike, settled or still waiting on an answer, so a project paid per accepted item has a target that can move and a week of work under review does not read as a week of nothing. A goal is for keeping going, not for reporting what has landed; that is the headline's job. Only rejected money is left out. The Overview and the project's own page ask the same function, so the same week cannot read two ways.

A **lifetime** goal has no pacing — a target with no end cannot be late. Nor do session goals: a session has no deadline. Off-clock goals are paced on their own page rather than among work targets, because sleep is not a work target.

---

---

## The activity calendar

A year of days at the foot of the Overview, each shaded by how much time it carried. It answers the question none of the period views can: not what this week was worth, but what the year has actually looked like — the streaks, the gaps, the weeks that quietly went missing.

Its summary line leads with the **streak** — the run of consecutive days with something on them, because it is the one figure there you can still change today. A day that isn't logged yet doesn't break it: the line says *none today* rather than silently reporting a number that hasn't moved, since a live run that hasn't been extended and a broken one are different things to be told.

Work and off-clock time get **separate calendars**, switched with the toggle in the heading, and separate colour ramps: jade for work, the same quiet slate the rest of the app gives time you track but don't work. They are never shaded on one scale, because they are not the same quantity.

The shade boundaries are **quantiles of whatever is being shaded**, not fixed hour marks. Six hours is a full day of work and a short night's sleep, so one fixed scale would render one of the two as a flat wall of colour. That makes the boundaries arbitrary unless they are stated, so the legend spells out every one of them rather than saying "less" and "more" — each once: with only a few days on the calendar several quantiles land on the same day, and the legend then shows fewer shades rather than one boundary three times. Empty days are left out of the distribution — include them and a single busy week in a blank year sets every boundary by how often you did nothing.

Days are walked as calendar dates, not as 86,400,000ms steps. A week containing a DST shift is 167 or 169 hours long, and stepping by fixed milliseconds would slide the grid by an hour and eventually put a Tuesday in the Monday row. Each column is labelled with the month its **midweek** day falls in: the week of 31 Aug – 6 Sep is four-sevenths September, and going by the Monday leaves September unlabelled.

Where there is more history than one calendar holds, arrows in the heading step back a **whole grid at a time**, so a week belongs to exactly one view instead of straddling two. They stop where your records do rather than walking into empty years, and the heading names the span it is showing.

Like *Targets*, the calendar ignores the period control above it — it is context for everything else on the page, not another reading of the chosen week. Where 53 columns don't fit, it scrolls, opens on the most recent weeks, and keeps the day names pinned.

---

---

## Who the work is for

A project can name the company it's for, and the Overview then totals every project of that client together under **By company**.

```
BY COMPANY                                   2 companies
Northwind                                        $602.34
████████████████████████████████████████████████████
6h 42m · $90.00/hr · 97% of revenue · 2 projects

Lumen Labs                                        $15.87
██
2h 07m · $7.50/hr · 3% of revenue
```

Two figures there aren't available anywhere else. **What an hour came to** is the blend across every project and every task-level rate override for that client — a client who looks busy at $7.50/hr and one who looks quiet at $90/hr are not the same client, and this is what says so. **Share of revenue** is client concentration, the number that tells you how much of your income walks out of the door if one relationship ends.

Projects with no company are kept as their own row rather than dropped. Leaving them out would make the shares add up to less than the whole while looking like they added up to all of it.

The panel appears as soon as it groups anything: several clients, or one client carrying more than a single project — which is what a whole imported history looks like, forty projects under one name. The only case it skips is one company on one project, where it would just be the project's name again. Off-clock projects are never in it: sleep has no client, and it is certainly not unassigned revenue.

The company is free text with suggestions from what you've already typed, and rows are grouped by the name **folded** — case ignored, and spaces, hyphens and underscores read as one space — so *Northwind* and *northwind* are one client, shown in the spelling met first. It is a name until it needs to carry something; the first thing to need a record of its own was the payday (see *Getting paid*), and that record is keyed by the same folded name, so every figure here and the schedule agree on who a client is.

---

---

## Paused and done

A project is **running**, **paused** or **done**, set in its settings — never two of those at once, because two checkboxes could express a state that doesn't exist and then every reader has to decide what it means.

Both stopped states leave the **Targets** panel and refuse new time. A goal you aren't working towards is not news, it's a number that can only get worse; and a project you stopped shouldn't quietly resume because a Start button was still there. The refusal lives in the domain rather than only in the hidden button — starting a meter is the one action that *closes* whatever else is open, so a start that shouldn't have happened doesn't merely add a bad session, it ends a good one.

What separates them is what you're saying:

- **Paused** is "not now". The card stays exactly where it is, tagged, for work that's gone quiet for a month.
- **Done** is "finished". The card moves to a collapsed **Done** group at the bottom of the list, and the project page replaces its goals with a closing summary: what it earned, the hours, what an hour came to across the whole run, whether the goal was met, and the span it actually ran — taken from the work itself, so a project created in March and first worked in June ran from June.

Neither hides a minute of history. Both still appear in By project, By company, the calendar and every earnings total for the periods they actually worked. The hours happened and the money was real.

Whatever is already open can always be finished. Stopping a project refuses *new* time; it never strands a session that was running when you stopped it.

---

---

## Money the clock never measured

Not all work pays by the hour. A task can pay per accepted submission, a month can end with a bonus, a platform can settle an adjustment. That money is real and belongs in the totals — but it has no duration, and this app is built on money being *derived* from time rather than stored.

So it is a separate record rather than a session with the hours left blank. A session means "the meter watched this", and every figure leans on that: elapsed time recomputed from segments, money recomputed from rate × elapsed. A session carrying a stored amount and no segments would be a lie in the one place the app cannot afford one, and every reporting function would have to learn to skip it.

**Earned without the clock** on a project page takes an amount, what it was for (per accepted item, bonus, adjustment), a date, and optionally how many items it covers — because "6 × $500" is the fact and "$3,000" is only the consequence. Negative amounts are allowed; a clawback is a real thing.

### Two rates, because they answer different questions

Once money can arrive without hours, a single "per hour" figure stops meaning one thing. So both are shown:

```
AN HOUR CAME TO
$58.30/hr
$18.97/hr on timed work · 67% earned no tracked time
```

The first divides everything by the hours recorded. The second divides only the money a clock actually measured. Where nothing untimed was earned they are the same number and the second line is dropped rather than repeated.

---

---

## Pending, paid, cancelled

Work that only pays once someone accepts it is not earnings yet. A project set to pay **once accepted** starts every new session **pending** — from the moment the meter starts, not marked afterwards, because otherwise every figure counts the money first and corrects later.

The Overview leads with what has actually landed, and pending sits on its own line beneath it:

```
THIS WEEK · EARNED
$218.41
Sep 21 – Sep 27 · −92% vs last week
+ $250.00 pending
```

Conservative on purpose: the number you glance at should be money you have, or a rejected week reads as a good one.

**Cancelled work keeps its hours and loses its money.** It is dimmed rather than deleted — the hours were still worked, and erasing the record would leave them in the ledger with no account of where their money went. It still counts in every time figure, and the project card, By project and By company name what it cost beside the hours (*$991.63 cancelled*), so hours against a zero read as a fact about the month rather than a broken app.

Most work moves between these states through its task's answer (see *Tasks and their answers*). **Mark paid** and **Mark pending** on rows ticked in the ledger stay for everything else, and where a mark would contradict the answer — paid on a rejected task's sessions, pending on an accepted one's — the bar says what the mark would claim and waits for *anyway*. Either can be meant; far more often it is a row ticked by mistake.

Absent means settled. Every session recorded before any of this existed counts exactly as it always did, so nothing already stored changed meaning and there is no migration. Only work genuinely waiting on someone else's decision carries a status at all.

---

---

## Tasks and their answers

A task has a life, in the words the platforms use: open, **submitted**, then **accepted** or **rejected**. Tick any number of tasks in the task list and move them through it together, because approval never arrives one task at a time.

- **Submit** stops the clock on a task for good: no more hours can be recorded against it, by the meter or by hand, because the platform priced what it received. A meter still running on it stops at the click. Where the project pays as worked the hours count as earned from then; where it pays once accepted they stay pending, with the acceptance reward, until the answer.
- **Accepted** pays the hours and the task's reward. **Rejected** cancels both, while the hours stay on the record and in every time figure.
- **Reopen** gives a task back its clock. On an answered task it also puts the money back to pending until the task is accepted again; on one only handed in, the money stays where it is.

Any task can be handed in, turned down or reopened, whatever the project pays and however. A task never has more than one acceptance reward: handing one in again after a reopen re-prices the reward it already had rather than writing a second beside it.

The time beside the buttons is when it happened, not when you tick the box. Until you type one, **Submit** records when the last sitting on the tasks ended — work is nearly always handed in as it is finished — and **Accepted** and **Rejected** record the minute you press them; type a time and every button records that instead. Both times can be corrected in the task editor afterwards. Which one decides a pay period, to the minute of the cutoff, depends on how the project pays: the answer's where it pays once accepted, the hand-in's where it pays as worked. The hints beside both say which.

---

---

## Getting paid

A payday belongs to the client, not to one project, so it is set in the **Payday** part of any of its projects' settings and shared by every project under that company: weekly — *work in before Monday is paid the following Wednesday* — or monthly — *before the 1st, paid on the 15th* — or none. A period shuts at a minute on the client's own clock (*Sunday 19:00, America/New_York*), and Settings says what that is on yours. The offset is read off the zone at each instant, so a daylight-saving change on either side moves the boundary with it. A zone this browser does not know is kept as saved, with a note that paydays are worked out on this device's clock until it is.

Renaming a project's company takes the payday with it. Naming a company that already has a schedule brings that schedule in, since joining a client means joining its paydays; if you have changed the payday boxes and the company named has a different one, Settings says so before saving, because saving would change it for every project under that company.

**Upcoming payments** on the Overview says what lands on which day:

```
UPCOMING PAYMENTS                                $640.00 confirmed
Wed, October 7                                           $640.00
Northwind · 3 tasks
Not before Wed, October 14                               $600.00
Northwind · 2 waiting on a review
```

- Where a project pays **as worked**, a task is paid in the run for the period it was **handed in**, its hours and its reward together. There is no answer to wait for: it is listed with its date as soon as it goes in, and a rejection later takes it off.
- Where a project pays **once accepted**, the **answer** decides instead. A run covers the tasks accepted during a period, so a task handed in on Sunday and accepted on Wednesday missed the period that shut on Monday and rides the next one. Work nobody has answered yet has no payday, only the earliest it could arrive — *Not before* — and is not totalled.
- A reward shared across several tasks is one payment, paid with the last of them to get there: accepted where the project pays once accepted, handed in where it pays as worked. Until then it waits like unreviewed work.
- One client is one row per day and currency however its name was typed. Every row opens to list what makes it up. Rejected work appears nowhere, and anything whose payday has passed drops off.
- A payday is a date on the client's calendar all the way to the screen, so a client east of you is never shown a day early.

Nothing here is stored. A forecast written down would be wrong the moment a schedule changed, and wrong silently.

---

---

## Objectives

What you mean to get done, beside what it actually took.

Each project carries a list — **Objectives** on a work project, **To-do** off the clock. An item can be linked to a task, and then the row reports **est 2h · spent 3h 10m · 150% of estimate**. That pairing is the reason this lives in a timer rather than a to-do app: a checklist can tell you something is finished, and only this can tell you it took half again as long as you thought.

**edit** on an objective changes its text, its estimate and what it tracks under. Linking is editable rather than fixed at creation because the usual order is backwards: you write the objective first and only create the task once you actually start timing it. Link it later and the row immediately reports the hours already on that task.

Objectives are their own records rather than a flag on a task, because the two answer different questions. A task is "which bucket does this time go in" and only exists once there is time to file; an objective is "I intend to do this", which is true before a second has been tracked and sometimes forever ("email the client back"). Deleting a task unfiles its objectives rather than destroying them — the intent outlives the bucket, exactly as a session's hours do.

Star a few as **today** and they gather at the top of the Overview, work and life alike. Today is stored as a local calendar day, not a boolean: a flag would still be set tomorrow morning and would need a nightly job to clear it, which is the same accumulate-versus-derive mistake the timer itself avoids. Ticking an item drops it off today's list, because what is left is the point.

---

---

## Adding time you didn’t track

**add time** beside the ledger records a block the meter never watched — for the hours you worked and forgot to start it. It previews the duration and the money before committing, takes the rate the project charges now (there is no record of what it charged then; a task rate can still correct it), and leaves a running meter alone: logging Tuesday afternoon is no reason to stop the clock ticking today.

Entries made this way are marked **Added** in the ledger. A block you typed in is different evidence from one the clock measured, and the app rests on being able to tell.

It also checks the window against every other record, on every project. Starting a session closes any other open one precisely because you cannot be in two places at once — but a block entered after the fact can break that rule in a way the timer never could, and two records over the same hour count it twice in both the hours and the money. An overlap is named, listed, and needs an explicit *add it anyway* rather than being silently accepted or flatly refused. Correcting a session's times is the other way to type a window in, so it makes the same check, leaving the session itself out, and asks *save it anyway*.

Only tasks that still take time are offered: a task already handed in takes no more hours. If the one picked is handed in while the form is open, the form says so and keeps what was typed, rather than reporting *Time added.* over an hour that went nowhere.

---

---

## Off the clock

Not everything worth timing is work. Sleep, play, time away from the desk — you may want the history without any of it touching what you earned.

Open a project's **Settings** and set it to **Off the clock**. Its hours stay recorded exactly as before; what changes is how they are counted. Off-clock time never enters earnings, billed hours, billable share, active days, or the project breakdown, and it gets its own panel on the Overview reporting the same period. The project keeps its own meter, ledger and tasks, but shows elapsed time where a work project shows money.

An off-clock project also reads differently. "Ledger", "task" and "Stop and save" are accounting words; applied to sleep or an evening of play they invite you to read the panel as money, which is the one thing it isn't. So tasks become **activities**, the ledger becomes **history**, sessions become **entries**, and the meter says **Start tracking**. The billing-only controls go with them: there is no billed-against-idle split to choose, no minute rail counting out an hour you are going to charge for, and no money goal that could never move. Only the labels change — the records, the timer and every figure underneath are identical, which is why it's a lookup in the UI layer (`src/ui/words.js`) and not a second path through the domain.

The flag is absent on every project written before it existed, and absent reads as work — so nothing already recorded moves, and no migration is needed.

This replaces the workaround of giving a project a rate like `0.00001`. That hides the money and nothing else: the hours still land in billed time, in the billable share and in the breakdown, so a night's sleep still reads as a productive night. Setting the rate near zero was always treating the symptom.

---

---

## Reporting time per task

The **By task** panel on a project lists every task with hours and earnings, with idle time on its own line. It reads by amount, by the day the work went in, by hours taken or by hours lost, either way round, and a row with no date stays at the bottom whichever way it points. Clicking a row filters the ledger to that task so you can check what's actually in it.

To correct filing: open the ledger, tick the sessions, then **Assign to task**. One session or twenty, onto an existing task or a new one. The running session's task can be changed from the chip on the meter face.

**edit** on a ledger row corrects a finished session's start and end — for the times you leave the meter running. It previews the resulting duration and earnings before you commit, keeps what the meter originally recorded, and marks the row "Edited". An end at or before the start is pointed out rather than quietly swapped into an hour nobody worked. Undo is available immediately, and "Undo correction" restores the recorded times at any point later.

**edit** on a task row renames it, sets its rate or its price per accepted item, corrects the times it went in and was answered, or deletes it. Setting a rate reprices every session under that task, finished ones included — for when the rate you're actually paid is settled after the work is done. Leave it empty to value each session at the rate it recorded. A rate or a price is read the way it is written, decimal comma included (`12,5` is 12.5); anything else — a figure below zero, a stray letter, `1,250`, which could be either — is named under the box and nothing is saved until it is put right, because read as "nothing" it would quietly clear what the task had. A name another task already has is refused the same way: a name is how a typed task is found. Deleting warns how many sessions will move to "No task" and can be undone.

Every editor starts from the thing it was opened on. Opening one task's editor and then another's, or switching project with a form open, gives the new one its own values rather than carrying the last one's over.

---

---

## Keeping the ledger

The ledger lives in this browser's storage, which a cleared cache takes with it, so the app says when it has been a while since the last backup and how many records exist only here.

- **Export a backup** writes the whole ledger as plain JSON. **Restore** reads one back — after showing the ledger here beside the one in the file, in projects, sessions and payments and the dates they span, and saying that it replaces rather than merges. The Undo after it stays.
- **Export CSV** writes every line item for a spreadsheet. It starts with a byte-order mark, so Excel reads names in Arabic or with emoji as they were typed, and a text cell that starts with `=`, `+`, `-` or `@` is written so Excel shows it rather than runs it as a formula. Time off the clock keeps its hours and carries no money, and says what it is.
- Stored data that cannot be read is **kept, not saved over**. It is copied to a key of its own before anything is written, and a banner offers it as a download, or a backup to restore. If no copy can be made, nothing is saved until the original has been downloaded.
- Settings typed and not saved are kept while the panel is closed or the project is left, and the closed panel says **Unsaved**. Closing the window asks first, in the desktop app as in a browser.
