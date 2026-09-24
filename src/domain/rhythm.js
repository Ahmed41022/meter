/**
 * When the work actually happens.
 *
 * Everything else in the app asks how much; this asks when. The answer is
 * already in the ledger — every segment carries its own start and end — but
 * nothing has ever looked at it from this angle.
 *
 * Like the rest of `domain/`, nothing here reads the clock.
 */
import { dailyTotals } from "./performance.js";
import { isIdle } from "./sessions.js";

/** Monday first, matching the calendar and the year grid. `Date.getDay()` puts
 *  Sunday at 0, so every index here is shifted. */
export const MONDAY_FIRST = (t) => (new Date(t).getDay() + 6) % 7;

const empty = (n, extra) => Array.from({ length: n }, (_, i) => ({ ...extra(i) }));

/**
 * Time by the day of the week it fell on.
 *
 * Built on `dailyTotals`, so a session running past midnight lands in both
 * days for exactly the minutes it spent in each — Sunday night bleeding into
 * Monday is two days' work, not one.
 *
 * `activeDays` counts the calendar days that saw anything, which is what makes
 * the totals comparable: a window of a hundred days holds fifteen Mondays and
 * fourteen Sundays, so a raw total quietly flatters whichever weekday the
 * window happened to start on.
 */
export const byWeekday = (sessions, from, to, now) => {
  const rows = empty(7, (weekday) => ({ weekday, billedMs: 0, idleMs: 0, activeDays: 0 }));
  for (const [dayStart, cell] of dailyTotals(sessions, from, to, now)) {
    const row = rows[MONDAY_FIRST(dayStart)];
    row.billedMs += cell.billedMs;
    row.idleMs += cell.idleMs;
    if (cell.billedMs > 0 || cell.idleMs > 0) row.activeDays += 1;
  }
  return rows;
};

/** The start of the wall-clock hour `t` falls in, built from calendar fields so
 *  that an hour which does not exist on a DST morning normalises forward
 *  rather than landing an hour out. */
const hourStart = (t) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
};
const nextHour = (t) => {
  const d = new Date(hourStart(t));
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
  // On the morning the clocks go back, the same wall-clock hour happens twice
  // and the calendar arithmetic can fail to advance. Never return a step that
  // would not terminate.
  return next > t ? next : t + 3_600_000;
};

/**
 * Time by the hour of the day it fell in, 00 to 23.
 *
 * Distributed across every hour a segment touches, not filed under the hour it
 * started: a session from 09:40 to 12:10 is twenty minutes of nine, two whole
 * hours, and ten minutes of twelve. Filing it under "09" would claim you work
 * mornings on the evidence of an afternoon.
 */
export const byHourOfDay = (sessions, from, to, now) => {
  const rows = empty(24, (hour) => ({ hour, billedMs: 0, idleMs: 0 }));
  for (const session of sessions) {
    const idle = isIdle(session);
    for (const segment of session.segments || []) {
      const start = Math.max(segment.startedAt, from);
      const end = Math.min(segment.endedAt ?? now, to);
      if (!(end > start)) continue;
      for (let at = hourStart(start); at < end; ) {
        const next = nextHour(at);
        const ms = Math.min(end, next) - Math.max(start, at);
        if (ms > 0) {
          const row = rows[new Date(at).getHours()];
          if (idle) row.idleMs += ms; else row.billedMs += ms;
        }
        at = next;
      }
    }
  }
  return rows;
};

/** The row holding most billed time, or null when nothing was billed at all.
 *  Ties go to the earlier row, so a dead heat reads the same on every render. */
export const busiest = (rows) => {
  let best = null;
  for (const row of rows) {
    if (row.billedMs > 0 && (best === null || row.billedMs > best.billedMs)) best = row;
  }
  return best;
};

/**
 * The run of `width` consecutive hours holding the most billed time.
 *
 * Wraps past midnight, because a day is a circle and this ledger contains
 * sessions that start at 23:35 and finish at 00:33. A non-wrapping window
 * would split that work in half and report neither end of it.
 */
export const busiestStretch = (hours, width = 4) => {
  if (width < 1 || width > 24) return null;
  let best = null;
  for (let start = 0; start < 24; start += 1) {
    let ms = 0;
    for (let i = 0; i < width; i += 1) ms += hours[(start + i) % 24].billedMs;
    if (ms > 0 && (best === null || ms > best.billedMs)) {
      best = { from: start, to: (start + width) % 24, billedMs: ms, width };
    }
  }
  return best;
};

/** What share of all billed time a slice holds — the number that turns "your
 *  busiest hours" into a claim worth making or not making. */
export const shareOf = (rows, ms) => {
  const total = rows.reduce((a, r) => a + r.billedMs, 0);
  return total > 0 ? ms / total : null;
};

/**
 * Sessions whose clock time is real.
 *
 * A typed-in session carries whatever start time was entered for it, which for
 * anything imported from an export is a placement rather than a measurement —
 * this ledger's imported rows were all laid out from 09:00 because the source
 * gave a date and no time. Their DATE is real, so they belong in a weekday
 * reading; their hour is not, so they must stay out of an hourly one, or the
 * app reports the importer's arithmetic back as the user's habit.
 */
export const timedOnly = (sessions) => (sessions ?? []).filter((s) => !s.manual);

/**
 * The busiest row, but only when it is actually busier than the rest.
 *
 * Seven bars within a fifth of each other is not a habit, it is a flat week,
 * and naming a winner from it reports noise as a finding. The peak has to clear
 * the median of everything else before it is worth saying out loud.
 */
export const standsOut = (rows, margin = 1.25) => {
  const top = busiest(rows);
  if (top === null) return null;
  const rest = rows.filter((r) => r !== top && r.billedMs > 0)
    .map((r) => r.billedMs).sort((a, b) => a - b);
  if (rest.length === 0) return top;
  const median = rest[Math.floor(rest.length / 2)];
  return top.billedMs >= median * margin ? top : null;
};
