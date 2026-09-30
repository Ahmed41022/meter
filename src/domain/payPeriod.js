/**
 * When money actually arrives.
 *
 * Every other figure in this app answers what you have earned. This one
 * answers a different question — when it lands — and the two are weeks apart.
 * Work handed in on Tuesday is earned on Tuesday and paid on some Wednesday a
 * platform decided, and only one of those is a fact about your bank account.
 *
 * The rule belongs to the COMPANY, not the project. A platform pays on one
 * schedule whatever you were doing for it, and a person with four projects
 * under one client should not set the same rule four times and then keep them
 * in step by hand. Companies have always been a name on a project rather than
 * a record; this is the first thing that needs one, so the record's id is the
 * folded name — two devices that both name "Outlier" converge on one rule
 * instead of merging into two that disagree.
 *
 * Two shapes, because between them they cover how work like this is paid:
 *
 *   WEEKLY   work in before <weekday> is paid on <weekday>, optionally some
 *            whole weeks later. "Submitted before Monday, paid the following
 *            Wednesday" is this.
 *   MONTHLY  work in before the <nth> is paid on the <nth>, optionally some
 *            whole months later. Day numbers past the end of a short month
 *            clamp to its last day, so the 31st is the 28th in February
 *            rather than silently becoming the 3rd of March.
 *
 * Every date here is built from calendar fields and never by adding
 * milliseconds, for the same reason the rest of the app is: a week containing
 * a daylight-saving shift is 167 or 169 hours long, and a payday computed by
 * arithmetic would drift an hour every spring until it landed on the wrong
 * day entirely.
 *
 * Like the rest of `domain/`, nothing here reads the clock.
 */
import { fold } from "./projects.js";

export const PERIOD = { WEEKLY: "weekly", MONTHLY: "monthly" };

/** Monday 1 … Sunday 7, matching the Monday-first week the rest of the app
 *  counts in. `Date.getDay()` puts Sunday at 0, so it is shifted here once. */
export const WEEKDAYS = [
  [1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"],
  [5, "Friday"], [6, "Saturday"], [7, "Sunday"],
];

const weekdayName = (n) => WEEKDAYS.find(([i]) => i === n)?.[1] ?? "";
const isoDay = (t) => ((new Date(t).getDay() + 6) % 7) + 1;

const startOfDay = (t) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

const addDays = (t, n) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
};

/** The `day`th of a month, or its last day where the month is shorter. Day 0
 *  of the next month is the last day of this one. */
const dayInMonth = (year, month, day) => {
  const last = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(Math.max(day, 1), last)).getTime();
};

const whole = (value, low, high, fallback = null) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= low && n <= high ? n : fallback;
};

/**
 * A stored rule in the shape the rest of the code may rely on, or null where
 * there is no usable rule.
 *
 * Null rather than a default, because there is no sensible default payday and
 * inventing one would print a date that nobody has any reason to believe.
 */
export const normalisePeriod = (rule) => {
  if (!rule) return null;
  if (rule.kind === PERIOD.WEEKLY) {
    const cutoff = whole(rule.cutoff, 1, 7);
    const payday = whole(rule.payday, 1, 7);
    if (cutoff === null || payday === null) return null;
    return { kind: PERIOD.WEEKLY, cutoff, payday, after: whole(rule.after, 0, 8, 0) };
  }
  if (rule.kind === PERIOD.MONTHLY) {
    const cutoff = whole(rule.cutoff, 1, 31);
    const payday = whole(rule.payday, 1, 31);
    if (cutoff === null || payday === null) return null;
    return { kind: PERIOD.MONTHLY, cutoff, payday, after: whole(rule.after, 0, 6, 0) };
  }
  return null;
};

/**
 * The start of the next `day` weekday STRICTLY after `at`.
 *
 * Strictly, because the rule says work in *before* the cutoff. Work recorded
 * at the exact instant the cutoff falls is not before it, and rounding that
 * the friendly way would quietly promise money a week early.
 */
const nextWeekday = (day, at) => {
  const candidate = addDays(startOfDay(at), (day - isoDay(at) + 7) % 7);
  return candidate > at ? candidate : addDays(candidate, 7);
};

/** The first `day` weekday on or after `from`. On, because a period that
 *  closes on Monday and pays on Monday pays that same day. */
const weekdayOnOrAfter = (day, from) =>
  addDays(startOfDay(from), (day - isoDay(from) + 7) % 7);

const nextMonthDay = (day, at) => {
  const d = new Date(at);
  const candidate = dayInMonth(d.getFullYear(), d.getMonth(), day);
  return candidate > at ? candidate : dayInMonth(d.getFullYear(), d.getMonth() + 1, day);
};

const monthDayOnOrAfter = (day, from) => {
  const d = new Date(from);
  const candidate = dayInMonth(d.getFullYear(), d.getMonth(), day);
  return candidate >= from ? candidate : dayInMonth(d.getFullYear(), d.getMonth() + 1, day);
};

/**
 * When money for work recorded at `at` should arrive, or null without a rule.
 *
 * Two steps, and they are separate on purpose. First the period closes — the
 * next cutoff strictly after the work. Then the payday is found from that
 * close, not from the work: two tasks submitted on different days of the same
 * week are paid together, which is the whole reason a pay period exists.
 */
export const nextPayout = (rule, at) => {
  const r = normalisePeriod(rule);
  if (!r || !Number.isFinite(at)) return null;
  if (r.kind === PERIOD.WEEKLY) {
    const closes = nextWeekday(r.cutoff, at);
    return addDays(weekdayOnOrAfter(r.payday, closes), r.after * 7);
  }
  const closes = nextMonthDay(r.cutoff, at);
  const first = monthDayOnOrAfter(r.payday, closes);
  if (!r.after) return first;
  // Counted from the payday NUMBER rather than from the clamped date, so a
  // rule paying on the 31st does not become the 28th for ever after it once
  // passes through February.
  const d = new Date(first);
  return dayInMonth(d.getFullYear(), d.getMonth() + r.after, r.payday);
};

const ordinal = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/** The rule in words, for the editor. A schedule you cannot read back is a
 *  schedule you cannot tell you have set up wrong. */
export const describePeriod = (rule) => {
  const r = normalisePeriod(rule);
  if (!r) return "";
  if (r.kind === PERIOD.WEEKLY) {
    const later = r.after === 0 ? "the following" : `the ${ordinal(r.after + 1)}`;
    return `Work in before ${weekdayName(r.cutoff)} is paid ${later} ${weekdayName(r.payday)}.`;
  }
  const later = r.after === 0 ? "" : ` ${r.after} month${r.after === 1 ? "" : "s"} later`;
  return `Work in before the ${ordinal(r.cutoff)} is paid on the ${ordinal(r.payday)}${later}.`;
};

/* ── the company record the rule lives on ─────────────────────────────────── */

/** Named companies fold to one key, so "Northwind" and "northwind " are one
 *  client here exactly as they already are on the Overview. */
export const companyId = (name) => `co:${fold(name)}`;

export const liveCompanies = (state) =>
  (state?.companies ?? []).filter((c) => !c.deletedAt);

export const findCompany = (state, name) => {
  const key = fold(name);
  if (!key) return null;
  return liveCompanies(state).find((c) => fold(c.name) === key) ?? null;
};

/** The rule that applies to a project, through whatever company it names. */
export const payPeriodFor = (state, project) =>
  normalisePeriod(findCompany(state, project?.company ?? "")?.payPeriod);

/**
 * Writes a company's schedule, creating the record the first time.
 *
 * A null rule clears the schedule but keeps the record: the company is still
 * a company, it just has no stated payday, and tombstoning it would make the
 * next device to look think it had been deleted.
 */
export const setPayPeriod = (state, name, rule, now) => {
  const clean = String(name ?? "").trim();
  if (!clean) return state;
  const period = normalisePeriod(rule);
  const rows = state.companies ?? [];
  const key = fold(clean);
  const found = rows.find((c) => fold(c.name) === key);
  if (found) {
    return {
      ...state,
      companies: rows.map((c) => (c === found
        ? { ...c, name: clean, payPeriod: period, deletedAt: null }
        : c)),
    };
  }
  return {
    ...state,
    companies: [
      ...rows,
      { id: companyId(clean), name: clean, payPeriod: period, createdAt: now, deletedAt: null },
    ],
  };
};
