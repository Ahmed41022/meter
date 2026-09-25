import { useMemo, useState } from "react";
import { formatMoney, formatShortDuration } from "../domain/money.js";
import { utilisation } from "../domain/sessions.js";
import { activeProjects, offClockProjects, workProjects } from "../domain/projects.js";
import { rateFor } from "../domain/tasks.js";
import {
  PERIODS, activeBuckets, byProject, currenciesByValue, dailyTotals, deltaRatio,
  heatGrid, heatRange, heatThresholds, performanceIn, periodRange, splitByClock, trendFor,
  byCompany, concentration, effectiveRate, firstRecord, heatDepth, revenueShare, streaks,
  untimedShare, worthPerHour,
} from "../domain/performance.js";
import { doneToday, todaysObjectives } from "../domain/objectives.js";
import { normaliseGoal, pace, paceState, periodBoundary } from "../domain/goals.js";
import { Delta, Heatmap, Rhythm, SplitBar, StatTile, TrendChart } from "./charts.jsx";
import {
  busiestStretch, byHourOfDay, byWeekday, shareOf, standsOut, timedOnly,
} from "../domain/rhythm.js";
import { ByCompanyPanel, ByProjectPanel, TargetsPanel } from "./DashboardPanels.jsx";

// "All" rather than "All time" in the control: five tabs have to fit a phone,
// and the heading directly under it says "All time" in full.
const NAMES = { day: "Day", week: "Week", month: "Month", year: "Year", all: "All" };
// All time has no predecessor, and its absence from this table is what
// suppresses every comparison figure on screen.
const PREVIOUS = { day: "yesterday", week: "last week", month: "last month", year: "last year" };

const day = (t, opts) => new Date(t).toLocaleDateString(undefined, opts);

/** Monday first, named by the reader's own locale rather than hardcoded. Built
 *  from a known Monday so the list cannot drift with the current date. */
const DAY_NAMES = Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "long" }));

/**
 * What the reader is looking at, in words. Relative names for the periods
 * people actually name — "today", "last week" — and dates beyond that, because
 * "3 periods ago" is not how anyone thinks about their own week.
 */
const periodLabel = (period, offset, from, to) => {
  if (period === "all") return "All time";
  if (offset === 0) {
    return { day: "Today", week: "This week", month: "This month", year: "This year" }[period];
  }
  if (offset === -1) {
    return { day: "Yesterday", week: "Last week", month: "Last month", year: "Last year" }[period];
  }
  if (period === "day") return day(from, { weekday: "long", day: "numeric", month: "long" });
  if (period === "month") return day(from, { month: "long", year: "numeric" });
  if (period === "year") return String(new Date(from).getFullYear());
  return `${day(from, { day: "numeric", month: "short" })} – ${day(to - 1, { day: "numeric", month: "short" })}`;
};

/** The exact window, always shown under the name — a reader should never have
 *  to guess where a week was cut. */
const rangeNote = (period, from, to) => {
  if (period === "day") {
    return day(from, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }
  if (period === "year") return `Jan – Dec ${new Date(from).getFullYear()}`;
  // Months, not days: the span of a whole working history reads as "Jun 2024 –
  // Sep 2026", and a reader who sees no years cannot tell what they are looking
  // at. Collapsed when it begins and ends in the same month.
  if (period === "all") {
    const opts = { month: "short", year: "numeric" };
    const first = day(from, opts);
    const last = day(to - 1, opts);
    return first === last ? first : `${first} – ${last}`;
  }
  return `${day(from, { day: "numeric", month: "short" })} – ${day(to - 1, { day: "numeric", month: "short", year: "numeric" })}`;
};

/** A year of days for one register, ready to shade. */
const calendarFor = (sessions, now, back = 0) => {
  const { from, to } = heatRange(now, 53, back);
  const byDay = dailyTotals(sessions, from, to, now);
  return { from, to, byDay };
};

/** The first instant anything was recorded, so the calendar knows how far
 *  back there is anything to look at. */
const earliestOf = (sessions) => Math.min(
  ...sessions.flatMap((s) => (s.segments ?? []).map((g) => g.startedAt)), Infinity);


/**
 * Every work goal that has a deadline, paced against its own period.
 *
 * Deliberately NOT tied to the period control above it. A goal resets when it
 * resets — asking "am I on for this week?" is a question about now, and the
 * answer must not change because the reader stepped the report back to look at
 * last month. Each row therefore says which period it is measuring.
 *
 * Lifetime goals are absent for the same reason they have no pacing: a target
 * with no end cannot be late. Off-clock goals are absent because sleep is not
 * a work target, and they are paced on their own page instead. Paused and
 * finished projects are absent because a target you are not working towards
 * is not news — it is a number that can only ever get worse.
 *
 * Ordered by how many days' worth off the line each one is — unit-free, so a
 * money goal and an hours goal can be compared, and the one needing attention
 * is at the top.
 */
const targetsFor = (projects, work, now, rateOf) =>
  activeProjects(projects)
    .map((project) => {
      const goal = normaliseGoal(project.overallGoal);
      if (!goal || goal.period === "lifetime") return null;
      const from = periodBoundary(goal.period, now, 0);
      const to = periodBoundary(goal.period, now, 1);
      const mine = work.filter((s) => s.projectId === project.id);
      const { billedMs, billedCents } = performanceIn(mine, from, to, now, rateOf);
      const value = goal.type === "money"
        ? (billedCents[project.currency] ?? 0) / 100
        : billedMs / 60_000;
      const pacing = pace({ target: goal.target, from, to }, value, now);
      return { project, goal, value, pacing, state: paceState(pacing) };
    })
    .filter(Boolean)
    .sort((a, b) => a.pacing.drift / a.pacing.flatPerDay - b.pacing.drift / b.pacing.flatPerDay);

/**
 * The overall view: what a chosen day, week or month was worth across every
 * project at once.
 *
 * Every figure is derived through `performanceIn`, which splits sessions by
 * their overlap with the window. That is what makes the numbers here agree with
 * each other — the daily bars sum to the weekly headline, and a session that ran
 * past midnight is counted in both days for exactly the minutes it spent in each.
 */
export default function DashboardView({
  projects, sessions, earnings = [], objectives = [], now, today,
  onOpenProject, onToggleObjective,
}) {
  const [period, setPeriod] = useState("week");
  const [offset, setOffset] = useState(0);
  const [heatScale, setHeatScale] = useState("work");
  const [heatBack, setHeatBack] = useState(0);
  const [projectSort, setProjectSort] = useState("time");

  /** Which rate values a session is the caller's question, and the answer is a
   *  task override when there is one. Rebuilt only when the projects change. */
  const rateOf = useMemo(() => {
    const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
    return (s) => rateFor(byId[s.projectId], s);
  }, [projects]);

  const view = useMemo(() => {
    const earliest = firstRecord(sessions, earnings);
    const { from, to } = periodRange(period, now, offset, earliest);
    // Nothing sits behind all time, so there is no comparison to draw. Held as
    // null rather than an empty window, which would read as a truthful 0%.
    const before = period === "all" ? null : periodRange(period, now, offset - 1);
    // Every work figure below is derived from `work` alone. Sleep and play are
    // measured on the same clock but must never reach an earnings total, a
    // billable share, or the project breakdown.
    const { work, offClock } = splitByClock(projects, sessions);
    // Off the clock cannot earn, so a bonus there would be a category error.
    const offIds = new Set(offClockProjects(projects).map((p) => p.id));
    const workEarnings = earnings.filter((e) => !offIds.has(e.projectId));
    return {
      from, to,
      current: performanceIn(work, from, to, now, rateOf, workEarnings),
      previous: before ? performanceIn(work, before.from, before.to, now, rateOf, workEarnings) : null,
      trend: trendFor(period, work, now, offset, rateOf, earliest),
      rows: byProject(workProjects(projects), work, from, to, now, rateOf, workEarnings),
      offRows: byProject(offClockProjects(projects), offClock, from, to, now, rateOf),
      targets: targetsFor(workProjects(projects), work, now, rateOf),
      companies: byCompany(workProjects(projects), work, from, to, now, rateOf, workEarnings),
      // A fixed rolling year, like Targets and for the same reason: it is
      // context for everything above it, not another reading of the period.
      calendar: { work: calendarFor(work, now, heatBack), life: calendarFor(offClock, now, heatBack) },
      depth: { work: heatDepth(earliestOf(work), now), life: heatDepth(earliestOf(offClock), now) },
      // Deliberately over the WHOLE record rather than the chosen period. A
      // habit is a shape that needs months to show, and "you work Tuesdays"
      // drawn from four days would be a coincidence stated as a fact.
      rhythm: {
        from: Number.isFinite(earliest) ? earliest : now,
        // Every session, because an imported row's DATE came from the export
        // and is real.
        weekdays: byWeekday(work, 0, now, now),
        // Measured sessions only. A typed-in row's hour was chosen, not
        // observed — this ledger's imported rows were all laid out from 09:00
        // because the source gave dates and no times, and reading those back
        // would report the importer's arithmetic as the user's habit.
        hours: byHourOfDay(timedOnly(work), 0, now, now),
        timed: timedOnly(work).length,
      },
      hasOffClock: offClock.length > 0,
    };
  }, [projects, sessions, earnings, now, period, offset, rateOf, heatBack]);

  const { from, to, current, previous, trend, rows, offRows, targets, companies } = view;
  /** Worth showing once it groups anything: either several clients, or one
   *  client carrying more than a single project. A lone company on a lone
   *  project is just the project's name again, and that is the only case this
   *  skips. */
  const named = companies.filter((c) => c.company !== null);
  const showCompanies = named.length > 1
    || (named.length === 1 && named[0].projects.length > 1);
  const shares = showCompanies ? revenueShare(companies) : null;
  // Off the clock has no billable half, so its calendar shades every tracked
  // minute; work shades the billed ones, which is what the goals count.
  const scale = view.hasOffClock ? heatScale : "work";
  const heat = view.calendar[scale];
  const heatValue = scale === "work" ? (d) => d.billedMs : (d) => d.billedMs + d.idleMs;
  const heatWeeks = heatGrid(heat.from, heat.to, heat.byDay, periodBoundary("day", now, 0));
  const heatDays = heatWeeks.flatMap((w) => w.days).filter((d) => !d.future);
  const heatCuts = heatThresholds(heatDays.map(heatValue));
  const streak = streaks(heatDays, (d) => heatValue(d) > 0);
  // `standsOut` rather than `busiest`: seven bars within a fifth of each other
  // is a flat week, and naming a winner from it states noise as a habit.
  const peak = standsOut(view.rhythm.weekdays);
  const peakDay = peak ? peak.weekday : null;
  // A dozen measured sessions is not a working pattern, so below that the
  // hourly half is not drawn at all.
  const enoughTimed = view.rhythm.timed >= 12;
  const stretch = enoughTimed ? busiestStretch(view.rhythm.hours, 4) : null;
  const stretchShare = stretch ? shareOf(view.rhythm.hours, stretch.billedMs) : null;
  const behind = targets.filter((t) => t.state === "behind").length;
  const offMs = offRows.reduce((a, r) => a + r.billedMs + r.idleMs, 0);
  const earned = currenciesByValue(current.billedCents);
  const pending = currenciesByValue(current.pendingCents).filter(([, c]) => c !== 0);
  const share = utilisation(current.billedMs, current.idleMs);
  const active = activeBuckets(trend);
  const lead = earned[0]?.[0] ?? projects[0]?.currency ?? "USD";
  // What an hour came to, and what an hour of TIMED work came to. On work
  // paid per accepted item those are different numbers, and quoting only the
  // first one implies a clock measured money that no clock ever saw.
  const untimed = untimedShare(current, lead);
  const blendedRate = effectiveRate(current.billedCents[lead] ?? 0, current.billedMs);
  const timedRate = effectiveRate(current.timedCents[lead] ?? 0, current.billedMs);
  const vs = PREVIOUS[period];
  /** Bars are scaled to the longest desk time on screen. Scaling to the first
   *  row instead would break the moment a row below it had more idle time than
   *  the leader had billed — the rows are ordered by billed time, not total. */
  const widest = Math.max(...rows.map((r) => r.billedMs + r.idleMs), 1);

  // What an hour came to, per project. Answers a different question from the
  // default order: not "where did the time go" but "which of these was worth
  // it" — and on work paid per accepted item those have different answers.
  const ranked = worthPerHour(rows, lead);
  const byRate = projectSort === "rate" && ranked.length > 1;
  const shownRows = byRate ? ranked : rows;
  const top = concentration(rows, lead);

  // Today's focus is the same whichever period is on screen: what is left to
  // do now does not change because you are looking at last month.
  const focus = todaysObjectives({ objectives }, today);
  const finished = doneToday({ objectives }, today);
  const nameOf = (id) => projects.find((p) => p.id === id)?.name ?? "";

  return (
    <>
      <div className="dash-head">
        <div className="segmented" role="tablist" aria-label="Reporting period">
          {PERIODS.map((p) => (
            <button key={p} role="tab" aria-selected={period === p}
                    className={"seg" + (period === p ? " on" : "")}
                    onClick={() => { setPeriod(p); setOffset(0); }}>
              {NAMES[p]}
            </button>
          ))}
        </div>
        {/* All time cannot be stepped: there is exactly one of it. */}
        {period !== "all" && (
          <div className="stepper">
            <button className="step" aria-label={`Previous ${period}`}
                    onClick={() => setOffset((o) => o - 1)}>‹</button>
            {/* Forward is disabled at the present period — there is no data
                ahead of now, and an empty "next week" reads as a bug. */}
            <button className="step" aria-label={`Next ${period}`} disabled={offset >= 0}
                    onClick={() => setOffset((o) => Math.min(0, o + 1))}>›</button>
          </div>
        )}
      </div>

      <div className="grand">
        <span className="eyebrow">{periodLabel(period, offset, from, to)} · earned</span>
        {earned.length === 0
          ? <div className="grand-amt">—</div>
          : earned.map(([cur, cents], i) => (
              <div className={i === 0 ? "grand-amt" : "grand-alt"} key={cur}>
                {formatMoney(cents, cur)}
              </div>
            ))}
        <div className="dash-sub">
          {rangeNote(period, from, to)}
          {previous && earned.length > 0 && (
            <> · <Delta ratio={deltaRatio(current.billedCents[lead] ?? 0, previous.billedCents[lead] ?? 0)}
                        label={vs} /></>
          )}
        </div>
        {/* Money still waiting on someone else's decision. Below the headline
            rather than inside it: the figure you glance at should be what has
            actually landed, or a rejected week reads as a good one. */}
        {pending.length > 0 && (
          <div className="grand-pending">
            + {pending.map(([cur, c]) => formatMoney(c, cur)).join(" · ")} pending
          </div>
        )}
      </div>

      {(focus.length > 0 || finished.length > 0) && (
        <div className="sec" style={{ marginTop: 0, marginBottom: 26 }}>
          <div className="sec-head">
            <span className="eyebrow">Today</span>
            <span className="eyebrow">
              {finished.length > 0 && `${finished.length} done`}
              {finished.length > 0 && focus.length > 0 && " · "}
              {focus.length > 0 && `${focus.length} left`}
            </span>
          </div>
          <div className="panel">
            {focus.length === 0 ? (
              <div className="empty">Everything you picked for today is done.</div>
            ) : focus.map((o) => (
              <div className="obj" key={o.id}>
                <label className="obj-check">
                  <input type="checkbox" checked={false}
                         onChange={() => onToggleObjective(o.id)}
                         aria-label={`Mark ${o.text} done`} />
                  <span className="obj-text">{o.text}</span>
                </label>
                <div className="obj-meta">
                  <button className="linkish" onClick={() => onOpenProject(o.projectId)}>
                    {nameOf(o.projectId)}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <TargetsPanel targets={targets} behind={behind} onOpenProject={onOpenProject} />

      <div className="tiles">
        <StatTile label="Billed" value={formatShortDuration(current.billedMs)}
                  sub={previous
                    ? <Delta ratio={deltaRatio(current.billedMs, previous.billedMs)} label={vs} />
                    : null} />
        <StatTile label="Idle" value={formatShortDuration(current.idleMs)}
                  sub={previous
                    ? <Delta ratio={deltaRatio(current.idleMs, previous.idleMs)}
                             goodWhenUp={false} label={vs} />
                    : null} />
        <StatTile label="Billed share"
                  value={share === null ? "—" : `${Math.round(share * 100)}%`}
                  sub={share === null ? "no time recorded" : "of time at the desk"} />
        <StatTile
          label={{ day: "Active hours", year: "Active months", all: "Active months" }[period]
            ?? "Active days"}
          value={active} sub={`of ${trend.length}`} />
        {/* Both rates, because they answer different questions and only one of
            them is about the clock. Where nothing untimed was earned they are
            the same number, so the second line would be noise and is dropped. */}
        {blendedRate !== null && (
          <StatTile label="An hour came to"
                    value={`${formatMoney(blendedRate, lead)}/hr`}
                    sub={untimed > 0.005
                      ? `${formatMoney(timedRate, lead)}/hr on timed work · ${Math.round(untimed * 100)}% earned no tracked time`
                      : "across billed time"} />
        )}
      </div>

      <div className="sec">
        <div className="sec-head"><span className="eyebrow">Trend</span></div>
        <div className="panel">
          <TrendChart trend={trend} period={period} currency={lead}
                      emptyNote={offset === 0 ? "Nothing recorded yet." : "Nothing recorded in this period."} />
        </div>
      </div>

      {current.idleMs > 0 && (
        <div className="sec">
          <div className="sec-head"><span className="eyebrow">Time at the desk</span></div>
          <div className="panel">
            <SplitBar billedMs={current.billedMs} idleMs={current.idleMs} share={share} />
          </div>
        </div>
      )}

      <ByCompanyPanel show={showCompanies} companies={companies} named={named}
                      shares={shares} />

      <ByProjectPanel rows={rows} shownRows={shownRows} ranked={ranked} byRate={byRate}
                      top={top} widest={widest} projectSort={projectSort}
                      setProjectSort={setProjectSort} onOpenProject={onOpenProject} />

      {offRows.length > 0 && (
        <div className="sec">
          <div className="sec-head">
            <span className="eyebrow">Off the clock</span>
            <span className="eyebrow">{formatShortDuration(offMs)}</span>
          </div>
          <div className="panel">
            <div className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
              Tracked, but counted as neither work nor earnings.
            </div>
            {offRows.map(({ project, billedMs, idleMs }) => {
              const total = billedMs + idleMs;
              return (
                <button className="prow off" key={project.id}
                        onClick={() => onOpenProject(project.id)}>
                  <span className="prow-top">
                    <span className="prow-name">{project.name}</span>
                    <span className="prow-amt">{formatShortDuration(total)}</span>
                  </span>
                  <span className="prow-bar">
                    <span className="prow-off" style={{ width: `${(total / offMs) * 100}%` }} />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="sec">
        <div className="sec-head">
          <span className="eyebrow">Activity</span>
          <span className="hm-head">
            {view.hasOffClock && (
            // Named for the section above it, not for the tabs at the top of the
            // page: a Work/Life pair here would look like navigation and go
            // nowhere.
            <div className="segmented small" role="tablist" aria-label="Which time to show">
              {[["work", "Work"], ["life", "Off the clock"]].map(([key, label]) => (
                <button key={key} role="tab" aria-selected={scale === key}
                        className={"seg" + (scale === key ? " on" : "")}
                        onClick={() => setHeatScale(key)}>
                  {label}
                </button>
              ))}
            </div>
            )}
            {/* Steps a whole grid at a time, so a week belongs to exactly one
                view rather than straddling two. Stops where the records do. */}
            {view.depth[scale] > 0 && (
              <span className="stepper">
                <button className="step" aria-label="Earlier years"
                        disabled={heatBack >= view.depth[scale]}
                        onClick={() => setHeatBack((b) => b + 1)}>‹</button>
                <button className="step" aria-label="Later years"
                        disabled={heatBack <= 0}
                        onClick={() => setHeatBack((b) => Math.max(0, b - 1))}>›</button>
              </span>
            )}
          </span>
        </div>
        <div className="panel">
          <Heatmap weeks={heatWeeks} thresholds={heatCuts} scale={scale} streak={streak}
                   valueOf={heatValue} noun={scale === "work" ? "Billed" : "Tracked"} />
        </div>
      </div>

      {/* Only once there is enough of a record for a shape to mean anything. */}
      {view.rhythm.weekdays.some((r) => r.billedMs > 0) && (
        <div className="sec">
          <div className="sec-head"><span className="eyebrow">When you work</span></div>
          <div className="panel">
            <Rhythm weekdays={view.rhythm.weekdays} hours={stretch ? view.rhythm.hours : null}
                    dayNames={DAY_NAMES} peakDay={peakDay}
                    stretch={stretch} stretchShare={stretchShare}
                    span={`Across everything recorded, from ${day(view.rhythm.from, { month: "short", year: "numeric" })}`
                      + (stretch ? " · hours from timed sessions only" : "")} />
          </div>
        </div>
      )}
    </>
  );
}
