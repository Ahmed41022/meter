import { useMemo, useState } from "react";
import { formatMoney, formatShortDuration } from "../domain/money.js";
import { utilisation } from "../domain/sessions.js";
import { offClockProjects, workProjects } from "../domain/projects.js";
import { rateFor } from "../domain/tasks.js";
import {
  PERIODS, activeBuckets, byProject, currenciesByValue, dailyTotals, deltaRatio,
  heatGrid, heatRange, heatThresholds, performanceIn, periodRange, splitByClock, trendFor,
} from "../domain/performance.js";
import { doneToday, todaysObjectives } from "../domain/objectives.js";
import { normaliseGoal, pace, paceState, periodBoundary } from "../domain/goals.js";
import { Delta, Heatmap, SplitBar, StatTile, TrendChart } from "./charts.jsx";
import { GoalMeter, goalFormatter } from "./parts.jsx";

const NAMES = { day: "Day", week: "Week", month: "Month" };
const PREVIOUS = { day: "yesterday", week: "last week", month: "last month" };

const day = (t, opts) => new Date(t).toLocaleDateString(undefined, opts);

/**
 * What the reader is looking at, in words. Relative names for the periods
 * people actually name — "today", "last week" — and dates beyond that, because
 * "3 periods ago" is not how anyone thinks about their own week.
 */
const periodLabel = (period, offset, from, to) => {
  if (offset === 0) return { day: "Today", week: "This week", month: "This month" }[period];
  if (offset === -1) return { day: "Yesterday", week: "Last week", month: "Last month" }[period];
  if (period === "day") return day(from, { weekday: "long", day: "numeric", month: "long" });
  if (period === "month") return day(from, { month: "long", year: "numeric" });
  return `${day(from, { day: "numeric", month: "short" })} – ${day(to - 1, { day: "numeric", month: "short" })}`;
};

/** The exact window, always shown under the name — a reader should never have
 *  to guess where a week was cut. */
const rangeNote = (period, from, to) =>
  period === "day"
    ? day(from, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : `${day(from, { day: "numeric", month: "short" })} – ${day(to - 1, { day: "numeric", month: "short", year: "numeric" })}`;

/** A year of days for one register, ready to shade. */
const calendarFor = (sessions, now) => {
  const { from, to } = heatRange(now);
  const byDay = dailyTotals(sessions, from, to, now);
  return { from, to, byDay };
};

const PERIOD_WORD = { week: "this week", month: "this month" };

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
 * a work target, and they are paced on their own page instead.
 *
 * Ordered by how many days' worth off the line each one is — unit-free, so a
 * money goal and an hours goal can be compared, and the one needing attention
 * is at the top.
 */
const targetsFor = (projects, work, now, rateOf) =>
  projects
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
  projects, sessions, objectives = [], now, today, onOpenProject, onToggleObjective,
}) {
  const [period, setPeriod] = useState("week");
  const [offset, setOffset] = useState(0);
  const [heatScale, setHeatScale] = useState("work");

  /** Which rate values a session is the caller's question, and the answer is a
   *  task override when there is one. Rebuilt only when the projects change. */
  const rateOf = useMemo(() => {
    const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
    return (s) => rateFor(byId[s.projectId], s);
  }, [projects]);

  const view = useMemo(() => {
    const { from, to } = periodRange(period, now, offset);
    const before = periodRange(period, now, offset - 1);
    // Every work figure below is derived from `work` alone. Sleep and play are
    // measured on the same clock but must never reach an earnings total, a
    // billable share, or the project breakdown.
    const { work, offClock } = splitByClock(projects, sessions);
    return {
      from, to,
      current: performanceIn(work, from, to, now, rateOf),
      previous: performanceIn(work, before.from, before.to, now, rateOf),
      trend: trendFor(period, work, now, offset, rateOf),
      rows: byProject(workProjects(projects), work, from, to, now, rateOf),
      offRows: byProject(offClockProjects(projects), offClock, from, to, now, rateOf),
      targets: targetsFor(workProjects(projects), work, now, rateOf),
      // A fixed rolling year, like Targets and for the same reason: it is
      // context for everything above it, not another reading of the period.
      calendar: { work: calendarFor(work, now), life: calendarFor(offClock, now) },
      hasOffClock: offClock.length > 0,
    };
  }, [projects, sessions, now, period, offset, rateOf]);

  const { from, to, current, previous, trend, rows, offRows, targets } = view;
  // Off the clock has no billable half, so its calendar shades every tracked
  // minute; work shades the billed ones, which is what the goals count.
  const scale = view.hasOffClock ? heatScale : "work";
  const heat = view.calendar[scale];
  const heatValue = scale === "work" ? (d) => d.billedMs : (d) => d.billedMs + d.idleMs;
  const heatWeeks = heatGrid(heat.from, heat.to, heat.byDay, periodBoundary("day", now, 0));
  const heatCuts = heatThresholds(
    heatWeeks.flatMap((w) => w.days).filter((d) => !d.future).map(heatValue));
  const behind = targets.filter((t) => t.state === "behind").length;
  const offMs = offRows.reduce((a, r) => a + r.billedMs + r.idleMs, 0);
  const earned = currenciesByValue(current.billedCents);
  const share = utilisation(current.billedMs, current.idleMs);
  const active = activeBuckets(trend);
  const lead = earned[0]?.[0] ?? projects[0]?.currency ?? "USD";
  const vs = PREVIOUS[period];
  /** Bars are scaled to the longest desk time on screen. Scaling to the first
   *  row instead would break the moment a row below it had more idle time than
   *  the leader had billed — the rows are ordered by billed time, not total. */
  const widest = Math.max(...rows.map((r) => r.billedMs + r.idleMs), 1);

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
        <div className="stepper">
          <button className="step" aria-label={`Previous ${period}`}
                  onClick={() => setOffset((o) => o - 1)}>‹</button>
          {/* Forward is disabled at the present period — there is no data
              ahead of now, and an empty "next week" reads as a bug. */}
          <button className="step" aria-label={`Next ${period}`} disabled={offset >= 0}
                  onClick={() => setOffset((o) => Math.min(0, o + 1))}>›</button>
        </div>
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
          {earned.length > 0 && (
            <> · <Delta ratio={deltaRatio(current.billedCents[lead] ?? 0, previous.billedCents[lead] ?? 0)}
                        label={vs} /></>
          )}
        </div>
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

      {targets.length > 0 && (
        <div className="sec" style={{ marginTop: 0, marginBottom: 26 }}>
          <div className="sec-head">
            <span className="eyebrow">Targets</span>
            <span className="eyebrow">{behind > 0 ? `${behind} behind` : "all on pace"}</span>
          </div>
          <div className="panel">
            {targets.map(({ project, goal, value, pacing }) => {
              const show = goalFormatter(goal.type, project.currency);
              return (
                <div className="trg" key={project.id}>
                  <div className="trg-top">
                    <button className="linkish trg-name"
                            onClick={() => onOpenProject(project.id)}>{project.name}</button>
                    <span className="trg-of">{PERIOD_WORD[goal.period]}</span>
                    <span className="goal-val">{show(value)} / {show(goal.target)}</span>
                  </div>
                  <GoalMeter type={goal.type} target={goal.target} value={value}
                             currency={project.currency} pace={pacing} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="tiles">
        <StatTile label="Billed" value={formatShortDuration(current.billedMs)}
                  sub={<Delta ratio={deltaRatio(current.billedMs, previous.billedMs)} label={vs} />} />
        <StatTile label="Idle" value={formatShortDuration(current.idleMs)}
                  sub={<Delta ratio={deltaRatio(current.idleMs, previous.idleMs)}
                              goodWhenUp={false} label={vs} />} />
        <StatTile label="Billed share"
                  value={share === null ? "—" : `${Math.round(share * 100)}%`}
                  sub={share === null ? "no time recorded" : "of time at the desk"} />
        <StatTile label={period === "day" ? "Active hours" : "Active days"}
                  value={active} sub={`of ${trend.length}`} />
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

      <div className="sec">
        <div className="sec-head">
          <span className="eyebrow">By project</span>
          <span className="eyebrow">{rows.length ? `${rows.length} active` : ""}</span>
        </div>
        <div className="panel">
          {rows.length === 0 ? (
            <div className="empty">
              No project logged time in this period.
            </div>
          ) : rows.map(({ project, billedMs, idleMs, billedCents }) => {
            // One colour for every bar. These are projects, not an ordered
            // scale, so shading them by size would double-encode the length.
            const cents = billedCents[project.currency] ?? 0;
            return (
              <button className="prow" key={project.id} onClick={() => onOpenProject(project.id)}>
                <span className="prow-top">
                  <span className="prow-name">{project.name}</span>
                  <span className="prow-amt">{formatMoney(cents, project.currency)}</span>
                </span>
                <span className="prow-bar">
                  <span className="prow-billed"
                        style={{ width: `${(billedMs / widest) * 100}%` }} />
                  <span className="prow-idle"
                        style={{ width: `${(idleMs / widest) * 100}%` }} />
                </span>
                <span className="prow-meta">
                  {formatShortDuration(billedMs)} billed
                  {idleMs > 0 && ` · ${formatShortDuration(idleMs)} idle`}
                </span>
              </button>
            );
          })}
        </div>
      </div>

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
        </div>
        <div className="panel">
          <Heatmap weeks={heatWeeks} thresholds={heatCuts} scale={scale}
                   valueOf={heatValue} noun={scale === "work" ? "Billed" : "Tracked"} />
        </div>
      </div>
    </>
  );
}
