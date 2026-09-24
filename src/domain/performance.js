import { overlapMs } from "./time.js";
import { isIdle } from "./sessions.js";
import { isOffClock } from "./projects.js";
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

export const PERIODS = ["day", "week", "month"];

const MS_PER_HOUR = 3_600_000;

/** Milliseconds of one segment inside [from, to) — the primitive the whole
 *  module rests on. Defined in time.js because the one-meter-at-a-time rule
 *  needs the same arithmetic. */
export const segmentMsInWindow = overlapMs;

/** Milliseconds a session spent inside [from, to), summed over its segments.
 *  Paused gaps fall between segments, so they are never counted here either. */
export const sessionMsInWindow = (session, from, to, now) =>
  (session.segments || []).reduce((total, s) => total + segmentMsInWindow(s, from, to, now), 0);

/** The window for a period, as a half-open [from, to). `offset` steps whole
 *  periods: -1 is "the period before this one", which is what every comparison
 *  figure is measured against. */
export const periodRange = (period, now, offset = 0) => ({
  from: periodBoundary(period, now, offset),
  to: periodBoundary(period, now, offset + 1),
});

/**
 * The buckets a period is charted in: a day reads hour by hour, a week and a
 * month day by day.
 *
 * Hours advance by a fixed 3,600,000ms because an hour is always an hour of
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
export const bucketsFor = (period, now, offset = 0) => {
  const { from, to } = periodRange(period, now, offset);
  const hourly = period === "day";
  const buckets = [];
  for (let at = from; at < to; ) {
    const next = Math.min(hourly ? at + MS_PER_HOUR : periodBoundary("day", at, 1), to);
    const d = new Date(at);
    buckets.push({
      from: at,
      to: next,
      label: hourly
        ? String(d.getHours()).padStart(2, "0")
        : period === "week"
          ? d.toLocaleDateString(undefined, { weekday: "short" })
          : String(d.getDate()),
      major: hourly ? d.getHours() % 6 === 0 : period === "week" || d.getDate() % 7 === 1,
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
export const performanceIn = (sessions, from, to, now, rateOf = (s) => s.rate) => {
  const billedCents = {};
  const idleCents = {};
  let billedMs = 0;
  let idleMs = 0;

  for (const session of sessions) {
    const ms = sessionMsInWindow(session, from, to, now);
    if (ms <= 0) continue;
    const idle = isIdle(session);
    const into = idle ? idleCents : billedCents;
    if (idle) idleMs += ms; else billedMs += ms;
    into[session.currency] = (into[session.currency] || 0) + earningsCents(rateOf(session), ms);
  }
  return { billedMs, idleMs, billedCents, idleCents };
};

/** Currencies in a cents map, biggest first.
 *
 *  A DISPLAY ORDER, never a sum — 100 EGP against 100 USD is meaningless as a
 *  quantity, but this reliably puts the currency the user actually works in at
 *  the top of the view. */
export const currenciesByValue = (cents) =>
  Object.entries(cents).sort((a, b) => b[1] - a[1]);

/**
 * Signed change against the previous period, as a ratio of it.
 *
 * Null when there is nothing to compare against, because "no previous data"
 * and "no change" are different statements — rendering the first as +0% invents
 * a baseline that never existed. Same convention as `utilisation`.
 */
export const deltaRatio = (current, previous) =>
  previous > 0 ? (current - previous) / previous : null;

/** Per-project totals for a window, busiest first. Projects with no time in
 *  the window are dropped — a page of zeroes buries the rows that matter. */
export const byProject = (projects, sessions, from, to, now, rateOf) =>
  projects
    .map((project) => ({
      project,
      ...performanceIn(
        sessions.filter((s) => s.projectId === project.id), from, to, now, rateOf),
    }))
    .filter((row) => row.billedMs > 0 || row.idleMs > 0)
    .sort((a, b) => b.billedMs - a.billedMs || b.idleMs - a.idleMs);

/** Each bucket of a period with its totals attached, for the trend chart. The
 *  bucket is spread back in so a caller never re-derives which window a bar
 *  covers. */
export const trendFor = (period, sessions, now, offset = 0, rateOf) =>
  bucketsFor(period, now, offset).map((bucket) => ({
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
