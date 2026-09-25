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

---

## Reporting performance

The app opens on **Overview**, which reports every project at once for a chosen **Day**, **Week**, **Month** or **Year**. **Work** and **Life** are the tabs beside it, and opening a project from any of the three drills into its meter and ledger.

Pick the period, then step back through it with the arrows — last week, the month before. Forward stops at the present, because there is nothing recorded ahead of now.

Each period shows what it earned, billed and idle time with the change against the period before, the billable share of time at the desk, how many days (or hours, or months) saw work, a column chart of when the work happened, and a breakdown by project.

A year reads month by month rather than day by day — 365 bars two pixels wide are a texture, not a chart — and each month is one bucket of its own length, so February is never a gap.

Two panels on that page deliberately ignore the period control: **Targets** and **the activity calendar**. Both answer questions about *now* rather than about the period on screen.

Figures are derived by **overlap**, not by when a session started. A session running 23:30 → 00:30 is half an hour of one day and half an hour of the next, counted in each for exactly the minutes it spent there. That is what makes the numbers agree with one another: the daily bars always add up to the weekly headline, and no hour is ever counted twice or lost at a boundary. Period boundaries are built from calendar fields, so they stay correct across DST — including in zones where the clocks go forward at midnight and a local 00:00 simply doesn't exist that day.

Money is never mixed across currencies. If you bill in two, each is totalled and shown on its own line.

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

A **lifetime** goal has no pacing — a target with no end cannot be late. Nor do session goals: a session has no deadline. Off-clock goals are paced on their own page rather than among work targets, because sleep is not a work target.

---

---

## The activity calendar

A year of days at the foot of the Overview, each shaded by how much time it carried. It answers the question none of the period views can: not what this week was worth, but what the year has actually looked like — the streaks, the gaps, the weeks that quietly went missing.

Its summary line leads with the **streak** — the run of consecutive days with something on them, because it is the one figure there you can still change today. A day that isn't logged yet doesn't break it: the line says *none today* rather than silently reporting a number that hasn't moved, since a live run that hasn't been extended and a broken one are different things to be told.

Work and off-clock time get **separate calendars**, switched with the toggle in the heading, and separate colour ramps: jade for work, the same quiet slate the rest of the app gives time you track but don't work. They are never shaded on one scale, because they are not the same quantity.

The shade boundaries are **quantiles of whatever is being shaded**, not fixed hour marks. Six hours is a full day of work and a short night's sleep, so one fixed scale would render one of the two as a flat wall of colour. That makes the boundaries arbitrary unless they are stated, so the legend spells out every one of them rather than saying "less" and "more". Empty days are left out of the distribution — include them and a single busy week in a blank year sets every boundary by how often you did nothing.

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

The company is free text with suggestions from what you've already typed. It's a name until it needs to carry something, so it isn't a record of its own yet; the suggestion list is what stops *Northwind* and *northwind* becoming two clients. Every figure above is keyed by the name, so it can become a real entity later without touching a single stored project.

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

**Cancelled work keeps its hours and loses its money.** It is dimmed rather than deleted — the hours were still worked, and erasing the record would leave them in the ledger with no account of where their money went.

Absent means settled. Every session recorded before any of this existed counts exactly as it always did, so nothing already stored changed meaning and there is no migration. Only work genuinely waiting on someone else's decision carries a status at all.

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

It also checks the window against every other record, on every project. Starting a session closes any other open one precisely because you cannot be in two places at once — but a block entered after the fact can break that rule in a way the timer never could, and two records over the same hour count it twice in both the hours and the money. An overlap is named, listed, and needs an explicit *add it anyway* rather than being silently accepted or flatly refused.

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

The **By task** panel on a project lists every task with hours and earnings, ordered by earnings, with idle time on its own line. Clicking a row filters the ledger to that task so you can check what's actually in it.

To correct filing: open the ledger, tick the sessions, then **Assign to task**. One session or twenty, onto an existing task or a new one. The running session's task can be changed from the chip on the meter face.

**edit** on a ledger row corrects a finished session's start and end — for the times you leave the meter running. It previews the resulting duration and earnings before you commit, keeps what the meter originally recorded, and marks the row "Edited". Undo is available immediately, and "Undo correction" restores the recorded times at any point later.

**edit** on a task row renames it, sets its rate, or deletes it. Setting a rate reprices every session under that task, finished ones included — for when the rate you're actually paid is settled after the work is done. Leave it empty to value each session at the rate it recorded. Deleting warns how many sessions will move to "No task" and can be undone.
