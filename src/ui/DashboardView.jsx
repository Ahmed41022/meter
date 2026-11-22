import { useMemo, useState } from "react";
import { utilisation } from "../domain/sessions.js";
import { offClockProjects, workProjects } from "../domain/projects.js";
import { pricer } from "../domain/terms.js";
import {
  PERIODS, activeBuckets, byProject, currenciesByValue, deltaRatio, performanceIn, periodRange,
  splitByClock, trendFor, byCompany, comparisonRanges, concentration, currenciesByWork,
  firstRecord, heatDepth, hourlyRates, revenueShare, soleCurrency, worthPerHour,
} from "../domain/performance.js";
import {
  BY_PROJECT_ORDERS, keysOf, orderCompanyRows, orderProjectRows,
} from "../domain/order.js";
import { doneToday, todaysObjectives } from "../domain/objectives.js";
import { byHourOfDay, byWeekday, timedOnly } from "../domain/rhythm.js";
import { ByCompanyPanel, ByProjectPanel, TargetsPanel } from "./DashboardPanels.jsx";
import { SETTING, loadSetting } from "../storage/settings.js";
import { useMoney } from "./useMoney.js";
import PeriodHeader from "./dashboard/PeriodHeader.jsx";
import Headline from "./dashboard/Headline.jsx";
import TodayFocus from "./dashboard/TodayFocus.jsx";
import StatTiles from "./dashboard/StatTiles.jsx";
import Trend from "./dashboard/Trend.jsx";
import DeskTime from "./dashboard/DeskTime.jsx";
import OffClockList from "./dashboard/OffClockList.jsx";
import Activity from "./dashboard/Activity.jsx";
import WhenYouWork from "./dashboard/WhenYouWork.jsx";
import { BEFORE, SO_FAR } from "./dashboard/labels.js";
import { calendarFor, earliestOf, targetsFor } from "./dashboard/model.js";

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
  projects, sessions, earnings = [], objectives = [], defaultPeriod = "last", defaultProjectSort = "time", defaultCompanySort = "earned", now, today,
  onOpenProject, onToggleObjective, pastUnanswered = false, onOpenPayments,
}) {
  const fx = useMoney();
  // Remembered, because reopening the app to a span you did not choose is a
  // small daily annoyance and the answer is one string. Validated on read: a
  // stored value from a future version, or a hand-edited one, must not leave
  // the Overview showing nothing.
  //
  // A default chosen in Settings comes first: it is shared by every device, so
  // it is what the owner asked this screen to open on. "last" is the old
  // behaviour. Picking a span here still updates the per-device memory either
  // way, so switching the default back to "last" resumes from where this
  // device left off.
  const [period, setPeriod] = useState(() => {
    if (PERIODS.includes(defaultPeriod)) return defaultPeriod;
    const saved = loadSetting(SETTING.PERIOD, "week");
    return PERIODS.includes(saved) ? saved : "week";
  });
  const [offset, setOffset] = useState(0);
  const [heatScale, setHeatScale] = useState("work");
  const [heatBack, setHeatBack] = useState(0);
  // What was picked on a breakdown, or null to follow the synced default.
  // Kept until the Overview is left, never written back.
  const [projectPick, setProjectPick] = useState(null);
  const [companyPick, setCompanyPick] = useState(null);

  /** Which rate values a session is the caller's question, and the answer is a
   *  task override when there is one, and a share of it for time over a task's
   *  limit. Rebuilt only when the projects or the sessions change. */
  const rateOf = useMemo(() => pricer(projects, sessions), [projects, sessions]);

  const view = useMemo(() => {
    const earliest = firstRecord(sessions, earnings);
    const { from, to } = periodRange(period, now, offset, earliest);
    // Nothing sits behind all time, so there is no comparison to draw. Held as
    // null rather than an empty window, which would read as a truthful 0%.
    const compare = comparisonRanges(period, now, offset);
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
      previous: compare
        ? performanceIn(work, compare.previous.from, compare.previous.to, now, rateOf, workEarnings)
        : null,
      // This period's side of the comparison while it is still going: up to
      // now and no further. Once it is over, its side is `current` itself.
      sofar: compare?.toDate
        ? performanceIn(work, compare.current.from, compare.current.to, now, rateOf, workEarnings)
        : null,
      trend: trendFor(period, work, now, offset, rateOf, earliest),
      rows: byProject(workProjects(projects), work, from, to, now, rateOf, workEarnings),
      offRows: byProject(offClockProjects(projects), offClock, from, to, now, rateOf),
      targets: targetsFor(workProjects(projects), work, now, rateOf, workEarnings),
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
  /** The side of every comparison figure that is this period's. */
  const base = view.sofar ?? current;
  /** Worth showing once it groups anything: either several clients, or one
   *  client carrying more than a single project. A lone company on a lone
   *  project is just the project's name again, and that is the only case this
   *  skips. */
  const named = companies.filter((c) => c.company !== null);
  const showCompanies = named.length > 1
    || (named.length === 1 && named[0].projects.length > 1);
  const shares = showCompanies ? revenueShare(companies) : null;
  const behind = targets.filter((t) => t.state === "behind").length;
  // The currency most of the period's hours were worked in leads, rather than
  // whichever figure is the bigger number: EGP 300 is not more than $70.
  const earned = currenciesByWork(current);
  const pending = currenciesByValue(current.pendingCents).filter(([, c]) => c !== 0);
  const share = utilisation(current.billedMs, current.idleMs);
  const active = activeBuckets(trend);
  // What an hour came to, and what an hour of TIMED work came to, once for
  // each currency, each over its own hours. On work paid per accepted item
  // the two are different numbers, and quoting only the first one implies a
  // clock measured money that no clock ever saw.
  const rates = hourlyRates(current);
  /** The one currency the period's money is in, or null when there are
   *  several. The figures that set projects against each other — how much of
   *  the money rides on one, and which paid best by the hour — exist only
   *  within one currency: a share of a total that adds pounds to dollars is
   *  not a share, and neither is a ranking that sets one against the other. */
  const sole = soleCurrency(current.billedCents);
  const vs = offset < 0 ? BEFORE[period] : SO_FAR[period];
  /** The headline's change, one figure per currency it lists — never one
   *  figure for money that is in two. */
  const moneyDeltas = previous
    ? earned.map(([cur]) => [cur, deltaRatio(base.billedCents[cur] ?? 0, previous.billedCents[cur] ?? 0)])
    : [];
  /** Bars are scaled to the longest desk time on screen. Scaling to the first
   *  row instead would break the moment a row below it had more idle time than
   *  the leader had billed — the rows are ordered by billed time, not total. */
  const widest = Math.max(...rows.map((r) => r.billedMs + r.idleMs), 1);

  // What an hour came to, per project. Answers a different question from the
  // default order: not "where did the time go" but "which of these was worth
  // it" — and on work paid per accepted item those have different answers.
  const ranked = sole ? worthPerHour(rows, sole) : [];
  // "An hour" divides money by hours, so it exists only inside one currency,
  // and only once two rows clear the floor. Earned does not divide anything:
  // it groups by currency instead, so it is always on offer.
  const rateOffered = ranked.length > 1;
  const projectOrders = rows.length > 1
    ? BY_PROJECT_ORDERS.filter(([key]) => key !== "rate" || rateOffered)
    : [];
  const wanted = projectPick ?? defaultProjectSort;
  const projectSort = keysOf(projectOrders).includes(wanted) ? wanted : "time";
  const byRate = projectSort === "rate";
  const shownRows = byRate ? ranked : orderProjectRows(rows, projectSort, fx.settings);
  const companySort = companyPick ?? defaultCompanySort;
  const shownCompanies = orderCompanyRows(companies, companySort, fx.settings);
  const top = sole ? concentration(rows, sole) : null;

  // Today's focus is the same whichever period is on screen: what is left to
  // do now does not change because you are looking at last month.
  const focus = todaysObjectives({ objectives }, today);
  const finished = doneToday({ objectives }, today);
  const nameOf = (id) => projects.find((p) => p.id === id)?.name ?? "";

  return (
    <>
      {/* Upcoming payments moved to its own tab. This says so only where it
          matters: past paydays nobody has answered, whose one-time question
          lives there and holds back the app-wide notice until it is answered. */}
      {pastUnanswered && (
        <p className="hint" role="status">
          <button type="button" className="linkish" onClick={onOpenPayments}>
            Upcoming payments are now in Payments →
          </button>
        </p>
      )}
      <PeriodHeader period={period} setPeriod={setPeriod} setOffset={setOffset} offset={offset} />

      <Headline
        period={period} offset={offset} from={from} to={to} earned={earned}
        moneyDeltas={moneyDeltas} vs={vs} pending={pending}
      />

      {(focus.length > 0 || finished.length > 0) && (
        <TodayFocus
          focus={focus} finished={finished} onToggleObjective={onToggleObjective}
          onOpenProject={onOpenProject} nameOf={nameOf}
        />
      )}

      <TargetsPanel targets={targets} behind={behind} onOpenProject={onOpenProject} />

      <StatTiles
        current={current} previous={previous} base={base} vs={vs} share={share} period={period}
        active={active} trend={trend} rates={rates}
      />

      <Trend trend={trend} period={period} earned={earned} offset={offset} />

      {current.idleMs > 0 && (
        <DeskTime current={current} share={share} />
      )}

      <ByCompanyPanel show={showCompanies} companies={shownCompanies} named={named}
                      shares={shares} sort={companySort} setSort={setCompanyPick} />

      <ByProjectPanel rows={rows} shownRows={shownRows} orders={projectOrders} byRate={byRate}
                      rateCurrency={sole} top={top} widest={widest} projectSort={projectSort}
                      setProjectSort={setProjectPick} onOpenProject={onOpenProject} />

      {offRows.length > 0 && (
        <OffClockList offRows={offRows} onOpenProject={onOpenProject} />
      )}

      <Activity
        view={view} now={now} heatScale={heatScale} setHeatScale={setHeatScale}
        heatBack={heatBack} setHeatBack={setHeatBack}
      />

      {/* Only once there is enough of a record for a shape to mean anything. */}
      {view.rhythm.weekdays.some((r) => r.billedMs > 0) && (
        <WhenYouWork view={view} />
      )}
    </>
  );
}
