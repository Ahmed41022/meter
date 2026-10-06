import { overlapMs } from "./time.js";
import { isIdle } from "./sessions.js";
import { companyOf, fold, isOffClock } from "./projects.js";
import { earningsIn, isCancelled, isPending } from "./earnings.js";
import { earningsCents } from "./money.js";
import { periodBoundary } from "./goals.js";

/**
 * Performance reporting: what a day, a week or a month was actually worth.
 *
 * The whole module rests on one primitive — the OVERLAP of a segment with a
 * time window. Reporting must never ask "which bucket did this session start
 * in?", because a session running 23:30 → 00:30 belongs to two days.
 * Attributing it whole to either one moves an hour of money onto the wrong day
 * and the daily figures stop adding up to the weekly one. Splitting by overlap
 * gives every bucket exactly the minutes it is owed, and the parts always sum
 * back to the total.
 *
 * Like the rest of `domain/`, nothing here reads the clock — `now` is passed
 * in, so an open session's "so far" is the caller's notion of now.
 */

export const PERIODS = ["day", "week", "month", "year", "all"];

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

/** Milliseconds of one segment inside [from, to) — the primitive the whole
 *  module rests on. Defined in time.js because the one-meter-at-a-time rule
 *  needs the same arithmetic. */
export const segmentMsInWindow = overlapMs;

/** Milliseconds a session spent inside [from, to), summed over its segments.
 *  Paused gaps fall between segments, so they are never counted here either. */
export const sessionMsInWindow = (session, from, to, now) =>
  (session.segments || []).reduce((total, s) => total + segmentMsInWindow(s, from, to, now), 0);

/** The window for a period, as a half-open [from, to). `offset` steps whole
 *  periods: -1 is "the period before this one". What a comparison figure is
 *  measured against is `comparisonRanges`, which is not always a whole one. */
export const periodRange = (period, now, offset = 0, earliest = Infinity) => {
  // All time is not a period. It does not repeat, so it cannot be stepped and
  // has no predecessor to measure against; it runs from the first thing ever
  // recorded to the end of today. An empty ledger collapses it to today rather
  // than opening a window at the epoch.
  if (period === "all") {
    return {
      from: periodBoundary("day", Number.isFinite(earliest) ? earliest : now, 0),
      to: periodBoundary("day", now, 1),
    };
  }
  return {
    from: periodBoundary(period, now, offset),
    to: periodBoundary(period, now, offset + 1),
  };
};

/** How many days a calendar month has. The month may be out of range: Date
 *  reads -1 as December of the year before. */
const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

/**
 * The same point in the period before the one `now` is in: this time
 * yesterday, this weekday and time last week, this day of the month and time
 * last month, this date and time last year.
 *
 * Built from calendar fields, never by subtracting milliseconds. A week that
 * spans a DST change is 167 or 169 hours long, and "a week ago" counted in
 * hours lands an hour off the wall-clock time it is meant to match — on the
 * wrong weekday, when the change falls at midnight. A day of the month the
 * earlier month does not have is clamped to its last day, so the 31st of
 * March is set against the 28th of February rather than spilling into
 * March. Null for all time, which has no period before it.
 */
export const samePointBefore = (period, now) => {
  const d = new Date(now);
  const [y, m, day] = [d.getFullYear(), d.getMonth(), d.getDate()];
  const time = [d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()];
  if (period === "day") return new Date(y, m, day - 1, ...time).getTime();
  if (period === "week") return new Date(y, m, day - 7, ...time).getTime();
  if (period === "month") return new Date(y, m - 1, Math.min(day, daysInMonth(y, m - 1)), ...time).getTime();
  if (period === "year") return new Date(y - 1, m, Math.min(day, daysInMonth(y - 1, m)), ...time).getTime();
  return null;
};

/**
 * The two windows a comparison figure sets against each other, or null for
 * all time, which has nothing before it.
 *
 * A period that is over is compared whole with the whole one before it. The
 * one still going is not: on a Wednesday this week holds three days and last
 * week seven, so "−57% vs last week" would say only that the week is not
 * over yet. It is compared up to now against the period before up to the
 * same point — Monday 00:00 to now against last Monday 00:00 to this weekday
 * and time last week — which is a question the figure can actually answer.
 * `toDate` says which of the two it is, for the words beside the figure.
 */
export const comparisonRanges = (period, now, offset = 0) => {
  if (period === "all") return null;
  if (offset < 0) {
    return {
      current: periodRange(period, now, offset),
      previous: periodRange(period, now, offset - 1),
      toDate: false,
    };
  }
  return {
    current: { from: periodBoundary(period, now, 0), to: now },
    previous: { from: periodBoundary(period, now, -1), to: samePointBefore(period, now) },
    toDate: true,
  };
};

/** The first instant anything was recorded, time OR money. All time has to
 *  start where the record starts, and a project paid per accepted item carries
 *  money on days that hold no session at all. */
export const firstRecord = (sessions, earnings = []) => Math.min(
  ...sessions.flatMap((s) => (s.segments ?? []).map((g) => g.startedAt)),
  ...earnings.map((e) => e.at),
  Infinity,
);

/**
 * The buckets a period is charted in: a day reads hour by hour, a week and a
 * month day by day.
 *
 * A year advances by calendar month, so February is one bucket of its own
 * length rather than a gap. Hours advance by a fixed 3,600,000ms because an
 * hour is always an hour of
 * real time — DST moves the wall-clock LABEL, not the duration. Walking wall
 * clock instead would skip the hour that repeats when the clocks go back, and
 * that hour's work would vanish from the chart. Days advance by calendar date,
 * so a 23- or 25-hour day is one bucket of its true length. Either way the
 * buckets tile the window exactly: no gap, no overlap.
 *
 * `major` marks which bucket carries an axis label. It is calendar-derived
 * rather than an index modulo, so labels land on round clock hours and real
 * dates whatever the period's length.
 */
export const bucketsFor = (period, now, offset = 0, earliest = Infinity) => {
  const { from, to } = periodRange(period, now, offset, earliest);
  const hourly = period === "day";
  // A year reads month by month. Days would be 365 bars two pixels wide, which
  // is a texture rather than a chart. All time reads by month for the same
  // reason, however many years it turns out to cover.
  const monthly = period === "year" || period === "all";
  // Over more than a year of months, an axis reading "Jan" three times tells
  // the reader nothing, so January carries its year instead. Under that there
  // are too few Januaries to label anything and every month speaks for itself.
  const spanned = period === "all" && to - from > 400 * 86_400_000;
  const buckets = [];
  for (let at = from; at < to; ) {
    const step = hourly
      ? at + MS_PER_HOUR
      : periodBoundary(monthly ? "month" : "day", at, 1);
    const next = Math.min(step, to);
    const d = new Date(at);
    buckets.push({
      from: at,
      to: next,
      label: hourly
        ? String(d.getHours()).padStart(2, "0")
        : spanned && (d.getMonth() === 0 || at === from)
          ? String(d.getFullYear())
          : monthly
            ? d.toLocaleDateString(undefined, { month: "short" })
            : period === "week"
              ? d.toLocaleDateString(undefined, { weekday: "short" })
              : String(d.getDate()),
      major: hourly
        ? d.getHours() % 6 === 0
        : spanned
          ? d.getMonth() === 0 || at === from
          : monthly || period === "week" || d.getDate() % 7 === 1,
    });
    at = next;
  }
  return buckets;
};

/**
 * What a window was worth. Billed and idle come back as SEPARATE named fields,
 * never folded together — the same reason `sessionsFor` hands back billed
 * sessions only. A caller cannot accidentally add idle time into income,
 * because no field holds both.
 *
 * Money stays per-currency: EGP and USD are different units and adding them
 * would be a lie. Cents are integers, derived once from the milliseconds
 * actually inside the window.
 *
 * `rateOf` is a parameter for the same reason `earningsCents` takes a rate —
 * which rate applies to a session is the caller's question to answer, and a
 * task carrying an override answers it differently from the snapshot.
 */
export const performanceIn = (sessions, from, to, now, rateOf = (s) => s.rate, earnings = []) => {
  const billedCents = {};
  const idleCents = {};
  const pendingCents = {};
  // Money that was earned and then taken away. In no total, because it never
  // arrived — but named, because a week whose hours are all there and whose
  // earnings are zero reads as a broken figure until something says why.
  const cancelledCents = {};
  // The settled money that DID come from hours. Kept apart from `billedCents`
  // so a rate can be quoted two ways without either one being a guess: money
  // per hour across everything, and money per hour across the work that was
  // actually timed. On a project paid per accepted item those are wildly
  // different numbers, and only showing one of them misleads.
  const timedCents = {};
  // Billed time again, split by the currency it was worked in. A rate divides
  // money by hours, and pounds divided by hours that earned dollars is a
  // figure in no unit at all — so every per-hour figure takes its hours from
  // here, in the currency of the money it divides.
  const billedMsByCurrency = {};
  let billedMs = 0;
  let idleMs = 0;

  for (const session of sessions) {
    const ms = sessionMsInWindow(session, from, to, now);
    if (ms <= 0) continue;
    const idle = isIdle(session);
    // Cancelled work was done and then rejected. The hours happened, so they
    // stay in the time figures; the money never arrived, so it is in none.
    //
    // Skipping the session outright was the same mistake read from the other
    // end: it threw away hours that were really spent, so a project whose
    // work was all turned down vanished from every breakdown, and the heat
    // map still shaded a day the headline above it called empty.
    if (idle) {
      idleMs += ms;
    } else {
      billedMs += ms;
      billedMsByCurrency[session.currency] = (billedMsByCurrency[session.currency] || 0) + ms;
    }
    const cents = earningsCents(rateOf(session), ms);
    if (idle) {
      idleCents[session.currency] = (idleCents[session.currency] || 0) + cents;
    } else if (isCancelled(session)) {
      cancelledCents[session.currency] = (cancelledCents[session.currency] || 0) + cents;
    } else if (isPending(session)) {
      pendingCents[session.currency] = (pendingCents[session.currency] || 0) + cents;
    } else {
      billedCents[session.currency] = (billedCents[session.currency] || 0) + cents;
      timedCents[session.currency] = (timedCents[session.currency] || 0) + cents;
    }
  }

  // Money with no hours behind it: it reaches the totals and the rate, but it
  // can never move a duration.
  for (const earning of earningsIn(earnings, from, to)) {
    const into = isCancelled(earning)
      ? cancelledCents
      : (isPending(earning) ? pendingCents : billedCents);
    into[earning.currency] = (into[earning.currency] || 0) + earning.cents;
  }

  return {
    billedMs, idleMs, billedCents, idleCents, pendingCents, timedCents, cancelledCents,
    billedMsByCurrency,
  };
};

/** The share of settled money that no clock ever measured. Null when there is
 *  nothing earned to take a share of. */
export const untimedShare = ({ billedCents, timedCents }, currency) => {
  const total = billedCents[currency] ?? 0;
  if (total <= 0) return null;
  return (total - (timedCents[currency] ?? 0)) / total;
};

/** Currencies in a cents map, biggest first.
 *
 *  A DISPLAY ORDER, never a sum — 100 EGP against 100 USD is meaningless as a
 *  quantity, but this reliably puts the currency the user actually works in at
 *  the top of the view. */
export const currenciesByValue = (cents) =>
  Object.entries(cents).sort((a, b) => b[1] - a[1]);

/**
 * The currencies a window's settled money came in, the one most of its hours
 * were worked in first.
 *
 * Also a display order and never a sum, but ranked by the hours rather than
 * by the figure, because across currencies the figure says nothing: EGP 300
 * is a bigger number than $70 and was a quarter of the work. Hours are the one
 * quantity every currency shares. Money in a currency nothing was timed in —
 * a bonus, an accepted item's price — follows, biggest first.
 */
export const currenciesByWork = ({ billedCents, billedMsByCurrency = {} }) =>
  Object.entries(billedCents).sort((a, b) =>
    (billedMsByCurrency[b[0]] ?? 0) - (billedMsByCurrency[a[0]] ?? 0) || b[1] - a[1]);

/**
 * Signed change against the previous period, as a ratio of it.
 *
 * Null when there is nothing to compare against, because "no previous data"
 * and "no change" are different statements — rendering the first as +0% invents
 * a baseline that never existed. Same convention as `utilisation`.
 */
export const deltaRatio = (current, previous) =>
  previous > 0 ? (current - previous) / previous : null;

/** Any money at all against a row, including money that was cancelled — work
 *  that was rejected is a fact about how the week went, and a row dropped for
 *  having earned nothing takes the explanation with it. */
const hasMoney = (row) =>
  Object.values(row.billedCents).some((c) => c !== 0)
  || Object.values(row.pendingCents).some((c) => c !== 0)
  || Object.values(row.cancelledCents).some((c) => c !== 0);

/** Per-project totals for a window, busiest first. Projects with no time in
 *  the window are dropped — a page of zeroes buries the rows that matter. */
export const byProject = (projects, sessions, from, to, now, rateOf, earnings = []) =>
  projects
    .map((project) => ({
      project,
      ...performanceIn(
        sessions.filter((s) => s.projectId === project.id), from, to, now, rateOf,
        earnings.filter((e) => e.projectId === project.id)),
    }))
    .filter((row) => row.billedMs > 0 || row.idleMs > 0 || hasMoney(row))
    .sort((a, b) => b.billedMs - a.billedMs || b.idleMs - a.idleMs);

/**
 * Where a project's overall goal stands over [from, to): minutes for a time
 * goal, whole currency units for a money goal. `sessions` and `earnings` are
 * the project's own.
 *
 * Money is counted the way the Overview's headline counts it: the settled
 * money the clock measured and the settled money it did not — a bonus, an
 * accepted item's price — in the project's currency, with pending and
 * cancelled money in neither. Counting the clock alone left a $60 bonus out
 * of a weekly target, and gave a project paid per accepted item, whose money
 * never comes from a clock, a target that could never move. The Overview's
 * Targets and the project page both ask here, so the same goal cannot read
 * two ways on two screens.
 */
export const goalValue = (goal, project, sessions, earnings, from, to, now, rateOf) => {
  const { billedMs, billedCents } = performanceIn(sessions, from, to, now, rateOf, earnings);
  return goal?.type === "money" ? (billedCents[project.currency] ?? 0) / 100 : billedMs / 60_000;
};

/** Each bucket of a period with its totals attached, for the trend chart. The
 *  bucket is spread back in so a caller never re-derives which window a bar
 *  covers. */
export const trendFor = (period, sessions, now, offset = 0, rateOf, earliest = Infinity) =>
  bucketsFor(period, now, offset, earliest).map((bucket) => ({
    ...bucket,
    ...performanceIn(sessions, bucket.from, bucket.to, now, rateOf),
  }));

/**
 * Split sessions by whether their project is on the clock.
 *
 * Returned as two named fields rather than a flag on each session, for the
 * same reason `performanceIn` keeps billed and idle apart: there is no single
 * list holding both, so no caller can accidentally total sleep into income.
 *
 * A session whose project has gone missing counts as work. Reporting should
 * fail towards showing you time you did record, not towards quietly hiding it.
 */
export const splitByClock = (projects, sessions) => {
  const off = new Set(projects.filter(isOffClock).map((p) => p.id));
  const work = [];
  const offClock = [];
  for (const s of sessions) (off.has(s.projectId) ? offClock : work).push(s);
  return { work, offClock };
};

/** How many buckets of a trend saw billable work — "active days" in a week or
 *  month, "active hours" in a day. Counted from the buckets rather than from
 *  session starts, so a session spanning midnight makes both of its days
 *  active, which is what actually happened. */
export const activeBuckets = (trend) => trend.filter((b) => b.billedMs > 0).length;

/**
 * Every day's time in one pass, keyed by the local midnight that starts it.
 *
 * A year grid is 371 cells, and running `performanceIn` once per cell would
 * walk every session 371 times. This inverts the loop — each segment is
 * distributed across the days it actually touches — so the cost is the work
 * you did, not the size of the calendar.
 *
 * The distribution is the same overlap rule as everywhere else, applied day by
 * day: a session running 23:30 → 00:30 puts half an hour in each of two cells
 * rather than colouring one of them twice as dark.
 */
export const dailyTotals = (sessions, from, to, now) => {
  const byDay = new Map();
  for (const session of sessions) {
    const idle = isIdle(session);
    for (const segment of session.segments || []) {
      const start = Math.max(segment.startedAt, from);
      const end = Math.min(segment.endedAt ?? now, to);
      if (!(end > start)) continue;
      for (let at = periodBoundary("day", start, 0); at < end; ) {
        const next = periodBoundary("day", at, 1);
        const ms = Math.min(end, next) - Math.max(start, at);
        if (ms > 0) {
          const cell = byDay.get(at) || { billedMs: 0, idleMs: 0 };
          if (idle) cell.idleMs += ms; else cell.billedMs += ms;
          byDay.set(at, cell);
        }
        at = next;
      }
    }
  }
  return byDay;
};

/**
 * The window a year grid covers: whole weeks, ending with the one `now` is in,
 * so today is always in the last column.
 *
 * `back` steps the whole window earlier in units of itself — one step is one
 * grid, so the columns never half-overlap between views and a week belongs to
 * exactly one of them.
 */
export const heatRange = (now, weeks = 53, back = 0) => ({
  from: periodBoundary("week", now, 1 - weeks * (back + 1)),
  to: periodBoundary("week", now, 1 - weeks * back),
});

/** How many whole grids back the earliest record sits, so the stepper knows
 *  where to stop rather than walking into empty years for ever. */
export const heatDepth = (earliest, now, weeks = 53) => {
  if (!Number.isFinite(earliest)) return 0;
  let back = 0;
  while (back < 40 && heatRange(now, weeks, back).from > earliest) back += 1;
  return back;
};

/**
 * The grid itself: a column per week, seven rows deep, Monday at the top.
 *
 * Built by walking calendar days rather than adding 86,400,000 — a week that
 * contains a DST shift is 167 or 169 hours long, and stepping by fixed
 * milliseconds would slide the whole calendar by an hour and eventually put a
 * Tuesday in the Monday row.
 */
export const heatGrid = (from, to, byDay, todayStart) => {
  const weeks = [];
  for (let at = from; at < to; ) {
    const days = [];
    for (let i = 0; i < 7; i += 1) {
      const cell = byDay.get(at) || { billedMs: 0, idleMs: 0 };
      days.push({ at, ...cell, future: at > todayStart });
      at = periodBoundary("day", at, 1);
    }
    weeks.push({ from: days[0].at, days });
  }
  return weeks;
};

/**
 * Where to cut the shading, as the quantiles of the days that have any time on
 * them at all.
 *
 * Fixed hour thresholds cannot serve both registers: six hours is a full day of
 * work and a short night's sleep, and one scale would render one of the two as
 * a flat wall of colour. Quantiles adapt to whatever is being shaded — which
 * makes the boundaries meaningless unless they are shown, so the legend states
 * every one of them rather than saying "less" and "more".
 *
 * Empty days are excluded from the distribution. Including them would set every
 * boundary by how often you didn't work, so a single busy week in a blank year
 * would come out as the darkest shade available and tell you nothing.
 *
 * Every boundary is distinct, so there may be fewer than `steps - 1` of them.
 * With few days on the calendar several quantiles land on the same day, and
 * keeping each would have the legend state one boundary three times — "to
 * 1h 00m", "to 1h 00m", "to 1h 00m", "over 1h 00m" — for shades no day could
 * ever take. Boundaries are taken up to the whole minute first, the finest
 * grain a duration is printed at, so two that differ only by seconds cannot
 * print as the same figure either.
 */
export const heatThresholds = (values, steps = 4) => {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const cuts = Array.from({ length: steps - 1 }, (_, i) =>
    Math.ceil(sorted[Math.floor(((i + 1) / steps) * (sorted.length - 1))] / MS_PER_MINUTE)
      * MS_PER_MINUTE);
  return [...new Set(cuts)];
};

/** 0 for a day with nothing on it, then 1..steps. */
export const heatLevel = (ms, thresholds) =>
  ms <= 0 ? 0 : thresholds.filter((t) => ms > t).length + 1;

/** A display order across currencies, never a sum — the same rule
 *  `currenciesByValue` follows. Ranks a row by its single largest currency. */
const topCents = (cents) => Math.max(0, ...Object.values(cents));

/** The one currency a cents map is in, or null when it holds none or several.
 *  Figures that divide money — an effective rate, a share — exist only when
 *  there is a single unit to divide. */
export const soleCurrency = (cents) => {
  const held = Object.keys(cents);
  return held.length === 1 ? held[0] : null;
};

/**
 * What an hour of billed work actually came to, in cents per hour.
 *
 * The figure a per-project rate cannot give you: across several projects, and
 * across tasks carrying their own rate overrides, this is the blend. A client
 * who looks busy at $7.50/hr and one who looks quiet at $90/hr are not the
 * same client, and only this says so.
 *
 * Billed time is the divisor, not desk time — idle hours earn nothing by
 * definition, and folding them in would report a rate you never charged. The
 * billable share is a separate question the tiles already answer.
 */
export const effectiveRate = (cents, billedMs) =>
  billedMs > 0 ? Math.round(cents / (billedMs / MS_PER_HOUR)) : null;

/**
 * What an hour came to, once for each currency the window's hours or money
 * were in, the currency most of the hours were worked in first.
 *
 * Each figure divides one currency's settled money by the hours worked in
 * that currency and no other. Dividing EGP 300 by all four hours of a week in
 * which three were dollar hours reported "EGP 75.00/hr", a rate nothing was
 * ever paid at. A currency with money and no hours behind it has no rate and
 * is left out; one with hours and nothing settled reads as nothing an hour,
 * which is what rejected or unanswered work came to.
 *
 * `timedRateCents` is the same over only the money a clock measured, and
 * `untimed` the share that no clock did, as `untimedShare` reads it.
 */
export const hourlyRates = (totals) => {
  const hours = totals.billedMsByCurrency ?? {};
  const held = new Set([...Object.keys(hours), ...Object.keys(totals.billedCents)]);
  return [...held]
    .sort((a, b) => (hours[b] ?? 0) - (hours[a] ?? 0)
      || (totals.billedCents[b] ?? 0) - (totals.billedCents[a] ?? 0))
    .map((currency) => ({
      currency,
      rateCents: effectiveRate(totals.billedCents[currency] ?? 0, hours[currency] ?? 0),
      timedRateCents: effectiveRate(totals.timedCents[currency] ?? 0, hours[currency] ?? 0),
      untimed: untimedShare(totals, currency),
    }))
    .filter((r) => r.rateCents !== null);
};

/**
 * The window's work grouped by who it was for.
 *
 * Projects with no company are kept as their own row rather than dropped, so
 * the shares add up to the whole and unassigned work is visible instead of
 * silently missing from the total.
 *
 * Off-clock projects have no client and must not be passed in — sleep is not
 * unassigned revenue.
 *
 * One client is one row however its name was typed. Rows are keyed by the
 * folded name, the same key the payday rule is filed under, so "Northwind"
 * and "northwind" are one company here exactly as they share one payday; the
 * row carries the spelling met first. Unassigned has a key of its own, so a
 * name that folds to nothing still names somebody.
 */
export const byCompany = (projects, sessions, from, to, now, rateOf, earnings = []) => {
  const keyOf = (project) => {
    const name = companyOf(project);
    return name === null ? null : fold(name);
  };
  const keyById = new Map(projects.map((p) => [p.id, keyOf(p)]));
  const named = new Map();
  const grouped = new Map();
  // Seeded from the projects, not from the sessions: a project whose whole
  // income was paid per accepted item has money and no session at all, and
  // grouping off the sessions alone would drop it from the breakdown.
  for (const project of projects) {
    const key = keyOf(project);
    if (grouped.has(key)) continue;
    grouped.set(key, []);
    named.set(key, companyOf(project));
  }
  for (const session of sessions) {
    if (!keyById.has(session.projectId)) continue;
    grouped.get(keyById.get(session.projectId)).push(session);
  }

  return [...grouped.entries()]
    .map(([key, group]) => {
      const members = projects.filter((p) => keyOf(p) === key);
      const mine = new Set(members.map((p) => p.id));
      const totals = performanceIn(group, from, to, now, rateOf,
        earnings.filter((e) => mine.has(e.projectId)));
      const currency = soleCurrency(totals.billedCents);
      // Over the hours worked in that currency only. Hours in another one
      // earned none of this money, even when none of theirs was settled.
      const hours = currency ? totals.billedMsByCurrency[currency] ?? 0 : 0;
      return {
        company: named.get(key),
        projects: members,
        ...totals,
        currency,
        // Null rather than a figure when the row spans currencies: there is no
        // single unit for "per hour" to be in.
        rateCents: currency ? effectiveRate(totals.billedCents[currency], hours) : null,
        // The same rate across only the money a clock actually measured. Equal
        // to the one above wherever nothing untimed was earned.
        timedRateCents: currency ? effectiveRate(totals.timedCents[currency] ?? 0, hours) : null,
      };
    })
    .filter((row) => row.billedMs > 0 || row.idleMs > 0 || hasMoney(row))
    // Unassigned always sits last: it is a gap to fill, not a client to rank.
    .sort((a, b) => (a.company === null) - (b.company === null)
      || topCents(b.billedCents) - topCents(a.billedCents)
      || b.billedMs - a.billedMs);
};

/**
 * Each row's share of the window's revenue.
 *
 * Null when the money spans currencies — 100 EGP and 100 USD have no total to
 * take a share of, and inventing one would be the same lie as adding them.
 */
export const revenueShare = (rows) => {
  const currencies = new Set(rows.flatMap((r) => Object.keys(r.billedCents)));
  if (currencies.size !== 1) return null;
  const [currency] = currencies;
  const total = rows.reduce((a, r) => a + (r.billedCents[currency] ?? 0), 0);
  if (total <= 0) return null;
  return new Map(rows.map((r) => [r, (r.billedCents[currency] ?? 0) / total]));
};

/**
 * Consecutive days with something on them: the run you are on, and the best
 * one in the window.
 *
 * Today not being active does not break the current streak, it just hasn't
 * extended it yet — the day is not over. Reporting a five-day run as broken at
 * 09:00 would be both wrong and the kind of thing that makes a streak feel
 * like an accusation. `includesToday` is returned rather than folded in, so
 * the wording can say which of the two it is instead of implying the stronger
 * one.
 *
 * `cells` must be in calendar order and must not include days that have not
 * happened yet.
 */
export const streaks = (cells, isActive) => {
  let longest = 0;
  let run = 0;
  for (const cell of cells) {
    run = isActive(cell) ? run + 1 : 0;
    if (run > longest) longest = run;
  }

  const last = cells.length - 1;
  const includesToday = last >= 0 && isActive(cells[last]);
  let current = 0;
  for (let i = includesToday ? last : last - 1; i >= 0 && isActive(cells[i]); i -= 1) current += 1;

  return { current, longest, includesToday };
};

/**
 * What each project's hour was really worth, best first.
 *
 * Not the rate on the project card. On work paid per accepted item the card's
 * rate and the money that arrived are different numbers, and on this ledger
 * more than half the income never touched a clock at all — so this divides
 * everything settled by the hours actually recorded against it, which is the
 * only figure that answers "which of these was worth my time".
 *
 * Rows holding less than `floor` are left out rather than ranked, because a
 * small denominator is all it takes to top the list. An hour and a half of work
 * that also collected fifty dollars of untimed money reads as $106/hr, which is
 * arithmetic rather than a finding — and ranking puts it first, where the eye
 * goes. Five hours is enough that a single untimed payment cannot dominate.
 */
export const RATE_FLOOR_MS = 5 * 3_600_000;

/** Ranked within one currency, and over that currency's hours only: the
 *  money and the hours a rate divides have to be the same work. */
export const worthPerHour = (rows, currency, floor = RATE_FLOOR_MS) =>
  rows
    .map((r) => ({ r, ms: r.billedMsByCurrency?.[currency] ?? 0 }))
    .filter(({ r, ms }) => ms >= floor && (r.billedCents[currency] ?? 0) > 0)
    .map(({ r, ms }) => ({ ...r, perHour: effectiveRate(r.billedCents[currency] ?? 0, ms) }))
    .sort((a, b) => b.perHour - a.perHour);

/**
 * The largest single share of the money, and whose it is.
 *
 * One project at half of everything is a fact about risk rather than success,
 * and it is exactly the kind of fact people notice too late. Null across mixed
 * currencies, for the same reason nothing else here adds them.
 */
export const concentration = (rows, currency) => {
  if (!currency) return null;
  const total = rows.reduce((a, r) => a + (r.billedCents[currency] ?? 0), 0);
  if (total <= 0) return null;
  let top = null;
  for (const row of rows) {
    const cents = row.billedCents[currency] ?? 0;
    if (top === null || cents > top.cents) top = { row, cents };
  }
  return top === null || top.cents <= 0 ? null : { ...top, share: top.cents / total, total };
};
