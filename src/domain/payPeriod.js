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
 * A cutoff is an INSTANT, not a day, because that is how the platforms state
 * it: "the week closes Sunday 7pm Eastern" is a Sunday evening, and work
 * handed in at nine that night is next week's. So a rule may carry the minute
 * it closes and the zone that minute is read on — and the zone is the
 * load-bearing half. Seven o'clock in New York is two in the morning in
 * Cairo, so a cutoff typed as 19:00 without a zone would close seven hours
 * early and push a whole evening's work a week late. Both are absent on older
 * rules, which then mean midnight on this device's own clock: exactly what
 * they meant before either field existed.
 *
 * The PAYDAY stays a date. Money arriving at nine or at five arrived the same
 * day, and the platforms say as much — processing runs through the day. It is
 * carried as a date on the rule's own clock, from the arithmetic to the
 * screen, because an instant read back on another clock can land on the day
 * before.
 *
 * Every date here is built from calendar fields and never by adding
 * milliseconds, for the same reason the rest of the app is: a week containing
 * a daylight-saving shift is 167 or 169 hours long, and a payday computed by
 * arithmetic would drift an hour every spring until it landed on the wrong
 * day entirely. The same holds across zones, where the shift happens on a
 * different date again — so an offset is never remembered, only ever read off
 * the zone's own clock at the instant in question.
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

const whole = (value, low, high, fallback = null) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= low && n <= high ? n : fallback;
};

/* ── calendar arithmetic, on this device's clock or on somebody else's ────── */

/**
 * One formatter per clock, made once and kept.
 *
 * Making an Intl.DateTimeFormat costs far more than using one, and a forecast
 * asks the same few clocks the same questions for every task, every minute:
 * made fresh each time, one pass over six hundred tasks took a seventh of a
 * second. A formatter holds no time of its own, so a kept one answers exactly
 * as a new one would.
 */
const walls = new Map();
const wallFormat = (zone) => {
  if (!walls.has(zone)) {
    walls.set(zone, new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }));
  }
  return walls.get(zone);
};

/** The parts of an instant as a named zone's own clock reads them. */
const zoneWall = (t, zone) => {
  const parts = wallFormat(zone).formatToParts(t);
  const got = {};
  for (const p of parts) if (p.type !== "literal") got[p.type] = Number(p.value);
  return got;
};

/**
 * How far a zone stands from UTC at a given instant, in milliseconds.
 *
 * Read off the zone's own clock rather than from a table, so daylight saving
 * needs no knowing — including the years a country changes its mind about it,
 * which Egypt has done twice in a decade.
 */
const zoneOffset = (t, zone) => {
  const w = zoneWall(t, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
    - Math.floor(t / 1000) * 1000;
};

/**
 * The instant at which a zone's clock reads the given wall time.
 *
 * Inverting a zone takes two passes. The first offset is read at the wrong
 * instant — the wall time treated as though it were already UTC — which lands
 * within a day of the answer; the second is read within hours of it, close
 * enough that only a daylight-saving change inside that gap could move it
 * again. At the gap itself an hour does not exist and at the fold it happens
 * twice; either answer is a defensible cutoff, and both are an hour from the
 * one anybody would have guessed.
 */
const instantInZone = (y, month, day, minutes, zone) => {
  const wall = Date.UTC(y, month, day, Math.floor(minutes / 60), minutes % 60);
  const once = wall - zoneOffset(wall, zone);
  return wall - zoneOffset(once, zone);
};

/** A day as the rule's own clock reads it: calendar fields and the weekday. */
const dayOf = (t, zone) => {
  if (!zone) {
    const d = new Date(t);
    return {
      y: d.getFullYear(), m: d.getMonth(), d: d.getDate(),
      iso: ((d.getDay() + 6) % 7) + 1,
    };
  }
  const w = zoneWall(t, zone);
  // The wall fields read back as UTC give the weekday on that clock, which is
  // not this device's whenever the two are on opposite sides of midnight.
  const asUtc = new Date(Date.UTC(w.year, w.month - 1, w.day));
  return {
    y: w.year, m: w.month - 1, d: w.day,
    iso: ((asUtc.getUTCDay() + 6) % 7) + 1,
  };
};

/** When a calendar day reaches `minutes` past midnight, on the rule's clock.
 *  Day numbers may overflow their month and roll forward into the next. */
const stamp = ({ y, m, d }, minutes, zone) => (zone
  ? instantInZone(y, m, d, minutes, zone)
  : new Date(y, m, d, Math.floor(minutes / 60), minutes % 60).getTime());

const plusDays = (day, n) => ({ ...day, d: day.d + n });

/** The `day`th of a month, or its last day where the month is shorter. */
const clampDay = (y, m, day) =>
  Math.min(Math.max(day, 1), new Date(y, m + 1, 0).getDate());

const nextMonth = ({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 });

/** A zone only where this device knows the name. An unknown one throws inside
 *  `Intl` on every render, so it is dropped here and the rule falls back to
 *  the local clock — hours out at worst, rather than a blank screen. Dropped
 *  for working dates out only: the rule as kept still names it (see
 *  `storedPeriod`). Asked once per name: the answer cannot change while the
 *  page is open, and every read of a rule asks it. */
const known = new Map();
export const knownZone = (value) => {
  const name = String(value ?? "").trim();
  if (!name) return null;
  if (!known.has(name)) {
    try {
      wallFormat(name);
      known.set(name, true);
    } catch {
      known.set(name, false);
    }
  }
  return known.get(name) ? name : null;
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
  // Absent means midnight on this device's clock, which is what every rule
  // written before these two fields existed already meant.
  const when = { closesAt: whole(rule.closesAt, 0, 1439, 0), zone: knownZone(rule.zone) };
  if (rule.kind === PERIOD.WEEKLY) {
    const cutoff = whole(rule.cutoff, 1, 7);
    const payday = whole(rule.payday, 1, 7);
    if (cutoff === null || payday === null) return null;
    return { kind: PERIOD.WEEKLY, cutoff, payday, after: whole(rule.after, 0, 8, 0), ...when };
  }
  if (rule.kind === PERIOD.MONTHLY) {
    const cutoff = whole(rule.cutoff, 1, 31);
    const payday = whole(rule.payday, 1, 31);
    if (cutoff === null || payday === null) return null;
    return { kind: PERIOD.MONTHLY, cutoff, payday, after: whole(rule.after, 0, 6, 0), ...when };
  }
  return null;
};

/**
 * The next weekly cutoff STRICTLY after `at`.
 *
 * Strictly, because the rule says work in *before* the cutoff. Work recorded
 * at the exact instant the cutoff falls is not before it, and rounding that
 * the friendly way would quietly promise money a week early.
 */
const nextWeekly = ({ cutoff, closesAt, zone }, at) => {
  const today = dayOf(at, zone);
  const ahead = (cutoff - today.iso + 7) % 7;
  const candidate = stamp(plusDays(today, ahead), closesAt, zone);
  // Only a cutoff falling today can already have passed; any later day starts
  // after `at` whatever minute it closes at.
  return candidate > at ? candidate : stamp(plusDays(today, ahead + 7), closesAt, zone);
};

const nextMonthly = ({ cutoff, closesAt, zone }, at) => {
  const d = dayOf(at, zone);
  const here = stamp({ ...d, d: clampDay(d.y, d.m, cutoff) }, closesAt, zone);
  if (here > at) return here;
  const n = nextMonth(d);
  return stamp({ ...n, d: clampDay(n.y, n.m, cutoff) }, closesAt, zone);
};

/**
 * The payday for work recorded at `at`, as a calendar day on the rule's own
 * clock.
 *
 * Two steps, and they are separate on purpose. First the period closes — the
 * next cutoff strictly after the work. Then the payday is found from that
 * close, not from the work: two tasks submitted on different days of the same
 * week are paid together, which is the whole reason a pay period exists.
 *
 * Everything after the close is done in DAYS, never instants. A weekly payday
 * is the first payday weekday on or after the day the period closed — on, so
 * a period that closes on Monday and pays on Monday pays that same day — plus
 * whole weeks. A monthly one compares day NUMBERS, so a period closing on the
 * 1st at seven in the evening and paying on the 1st still pays that same day,
 * which is what it says.
 */
const paydayOf = (r, at) => {
  if (r.kind === PERIOD.WEEKLY) {
    const closed = dayOf(nextWeekly(r, at), r.zone);
    return plusDays(closed, ((r.payday - closed.iso + 7) % 7) + r.after * 7);
  }
  const closed = dayOf(nextMonthly(r, at), r.zone);
  const first = clampDay(closed.y, closed.m, r.payday) >= closed.d ? closed : nextMonth(closed);
  // Counted from the payday NUMBER rather than from the clamped date, so a
  // rule paying on the 31st does not become the 28th for ever after it once
  // passes through February.
  const y = first.y + Math.floor((first.m + r.after) / 12);
  const m = (first.m + r.after) % 12;
  return { y, m, d: clampDay(y, m, r.payday) };
};

const two = (n) => String(n).padStart(2, "0");

/**
 * A calendar day written out, "2026-10-07".
 *
 * The form a payday travels in. Days written this way sort and compare as
 * plain strings, and nothing can read one on the wrong clock — which is the
 * whole trouble with an instant. Day numbers that have run past the end of
 * their month are rolled forward by the calendar, through UTC, which has no
 * daylight saving to get in the way.
 */
const isoDay = ({ y, m, d }) => {
  const day = new Date(Date.UTC(y, m, d));
  return `${day.getUTCFullYear()}-${two(day.getUTCMonth() + 1)}-${two(day.getUTCDate())}`;
};

/**
 * The instant the current period shuts, or null without a rule.
 *
 * Exported for the editor, which has to be able to say what a cutoff set on
 * somebody else's clock comes to on yours. "Sunday 19:00 New York" is not a
 * fact anybody can act on until it reads as two o'clock on Monday morning.
 */
export const nextClose = (rule, at) => {
  const r = normalisePeriod(rule);
  if (!r || !Number.isFinite(at)) return null;
  return r.kind === PERIOD.WEEKLY ? nextWeekly(r, at) : nextMonthly(r, at);
};

/**
 * When money for work recorded at `at` should arrive, or null without a rule.
 *
 * `date` is the payday as the rule's own clock names it, and it is the
 * answer: it is what gets printed and what "has it passed yet" is asked of.
 * A payday stamped as an instant — midnight on the client's clock — and then
 * printed on this device's clock read a day early wherever the client is east
 * of here: a Wednesday payday in Kolkata is Tuesday evening in Cairo, so it
 * showed Tuesday and dropped off a day before it came.
 *
 * `at` is that midnight as an instant, kept for putting paydays from
 * different clocks in order and for nothing else.
 */
export const paydayFor = (rule, at) => {
  const r = normalisePeriod(rule);
  if (!r || !Number.isFinite(at)) return null;
  const day = paydayOf(r, at);
  return { date: isoDay(day), at: stamp(day, 0, r.zone) };
};

/** The payday as an instant alone: midnight on the rule's clock. */
export const nextPayout = (rule, at) => paydayFor(rule, at)?.at ?? null;

/**
 * Which calendar day it is at `at` on the rule's own clock, written the way
 * a payday's `date` is, so the two can be compared directly.
 *
 * A payday has passed once this clock has moved past its day. Asking this
 * device's clock instead dropped an eastern client's payday on the morning
 * it was due.
 */
export const dayOnClock = (rule, at) => {
  if (!Number.isFinite(at)) return null;
  return isoDay(dayOf(at, normalisePeriod(rule)?.zone ?? null));
};

const ordinal = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

const clock = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}`
  + `:${String(minutes % 60).padStart(2, "0")}`;

/** A zone named the way somebody would say it: the last path segment, with
 *  the underscores the IANA database spells it with taken back out. */
export const zoneLabel = (zone) =>
  String(zone ?? "").split("/").pop().replace(/_/g, " ");

/**
 * The time of day the period closes, where there is one worth printing.
 *
 * Silent for a plain midnight cutoff on the local clock, so a rule that has
 * never been given a time reads exactly as it did before it could have one.
 * A zone always prints its time, even midnight: once another clock is in play
 * the hour is the whole point.
 */
const closing = (r) => {
  if (!r.closesAt && !r.zone) return "";
  const time = ` at ${clock(r.closesAt)}`;
  return r.zone ? `${time} ${zoneLabel(r.zone)} time` : time;
};

/** The rule in words, for the editor. A schedule you cannot read back is a
 *  schedule you cannot tell you have set up wrong. */
export const describePeriod = (rule) => {
  const r = normalisePeriod(rule);
  if (!r) return "";
  if (r.kind === PERIOD.WEEKLY) {
    const later = r.after === 0 ? "the following" : `the ${ordinal(r.after + 1)}`;
    return `Work in before ${weekdayName(r.cutoff)}${closing(r)}`
      + ` is paid ${later} ${weekdayName(r.payday)}.`;
  }
  const later = r.after === 0 ? "" : ` ${r.after} month${r.after === 1 ? "" : "s"} later`;
  return `Work in before the ${ordinal(r.cutoff)}${closing(r)}`
    + ` is paid on the ${ordinal(r.payday)}${later}.`;
};

/**
 * A rule in the shape it is KEPT in: normalised like `normalisePeriod`, except
 * that the zone stays the name it was given, whether or not this device knows
 * it.
 *
 * A zone this browser has never heard of is still the client's clock. It may
 * have been set on another device, or in a browser with a newer list of
 * zones, and dropping it on the way back into the ledger erased it for every
 * device the next time anything here was saved. Working dates out is a
 * separate question, and that falls back to this device's clock.
 */
export const storedPeriod = (rule) => {
  const r = normalisePeriod(rule);
  if (!r) return null;
  return { ...r, zone: String(rule.zone ?? "").trim() || null };
};

/**
 * Whether two rules say the same thing, however each was written down — a
 * stored rule and the same rule read back out of the editor's boxes must not
 * count as two different schedules. Zones are compared by the names kept,
 * so two unknown ones are not mistaken for each other.
 */
export const samePeriod = (a, b) =>
  JSON.stringify(storedPeriod(a)) === JSON.stringify(storedPeriod(b));

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

/** The same rule as it is kept, zone and all, for the editor: what it shows
 *  is what it saves back, so it must be what is stored. */
export const storedPeriodFor = (state, project) =>
  storedPeriod(findCompany(state, project?.company ?? "")?.payPeriod);

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
  const period = storedPeriod(rule);
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
