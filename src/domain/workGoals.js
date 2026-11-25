import { companyOf, fold, isActive, isOffClock } from "./projects.js";
import { performanceIn } from "./performance.js";
import { pace, paceState, periodBoundary, weekdayOf } from "./goals.js";
import { dayGoalState, isDayGoal } from "./dayGoal.js";
import { dayLeft, dayTurn, metersOn, recentRate, todayOf } from "./hoursLeft.js";
import { prefOf } from "./prefs.js";

/**
 * Goals for work: so much time, or so much money, every day, week or month,
 * over all work, one company or one project.
 *
 * A record is `{ id, type, currency?, period, scope, terms, order, pauses,
 * createdAt, deletedAt }`. `scope` is `{ kind: "all" }`, `{ kind: "company",
 * company }` or `{ kind: "project", projectId }`.
 *
 * `terms` is a HISTORY of `{ from, target, days }`: the target, in the units
 * every goal here is kept in (minutes, or whole currency units), and the
 * weekdays it applies to, Monday 1 to Sunday 7. A change adds an entry dated
 * from the start of the day it is made, and a period is judged by the last
 * entry that began before the period ended. So raising a target today never
 * turns last week's met goal into a missed one. What a goal measures, over
 * what and how often, are not terms: change one and it is a different question
 * about the past, so its history starts again.
 *
 * Nothing here is carried over. A missed day is not owed by the next one; a
 * weekly goal is the one that says what a week should come to.
 *
 * Like the rest of `domain/`, nothing here reads the clock or storage.
 */
export const PERIODS = ["day", "week", "month"];
export const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];
/** How many finished periods a goal's results look back over. */
export const RESULTS = 5;
/** And how far they look for them, past days off and pauses. */
const LOOK_BACK = { day: 60, week: 26, month: 24 };
/** The one goal there was before there were several, kept as a preference. */
const FIRST = "goal:day";

const validScope = (s) => s?.kind === "all"
  || (s?.kind === "company" && typeof s.company === "string" && s.company.trim() !== "")
  || (s?.kind === "project" && typeof s.projectId === "string");
const cleanDays = (days) => {
  const kept = EVERY_DAY.filter((d) => (days ?? EVERY_DAY).includes(d));
  return kept.length ? kept : null;
};

/** What a form hands over, as a goal's fields, or null where it is not one. */
export const readGoal = ({ type, target, currency, period, scope, days }) => {
  const kept = cleanDays(days);
  const measure = type === "money" ? { type, currency } : { type };
  if (!isDayGoal({ ...measure, target }) || !PERIODS.includes(period) || !validScope(scope) || !kept) return null;
  return { ...measure, target, period, scope, days: kept };
};

const usable = (g) =>
  g && PERIODS.includes(g.period) && validScope(g.scope) && Array.isArray(g.terms) && g.terms.length > 0
  && isDayGoal({ type: g.type, currency: g.currency, target: g.terms.at(-1)?.target });

/** The old daily goal as a goal, for as long as nobody has changed it. Its id
 *  is fixed, so two devices that take it over make one record, not two. */
const inherited = (state) => {
  if ((state?.goals ?? []).some((g) => g.id === FIRST)) return null;
  const old = prefOf(state, "dayGoal");
  if (!old) return null;
  const set = (state.prefs ?? []).find((r) => r.id === "dayGoal");
  const at = set?.updatedAt ?? set?.createdAt ?? 0;
  return {
    id: FIRST, type: old.type, ...(old.currency ? { currency: old.currency } : {}), period: "day",
    scope: { kind: "all" }, terms: [{ from: periodBoundary("day", at, 0), target: old.target, days: EVERY_DAY }],
    order: 0, pauses: [], createdAt: at, deletedAt: null,
  };
};

const all = (state) => {
  const old = inherited(state);
  return old ? [...(state?.goals ?? []), old] : state?.goals ?? [];
};

/** Every goal there is, in the owner's order. One this build cannot read is
 *  left alone and not shown. */
export const liveGoals = (state) => all(state)
  .filter((g) => !g.deletedAt && usable(g))
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);

export const isPausedGoal = (goal) => (goal.pauses ?? []).some((p) => p.to === null);

/** The calendar day an instant is on, as the instant it begins. Terms are dated
 *  by it, whenever the owner's day turns over, so moving that moves no terms. */
const calendarDay = (t) => periodBoundary("day", t, 0);

/** The terms in force for a period that ends at `to`. */
export const termsAt = (goal, to, turn = 0) => {
  const last = calendarDay(periodBoundary("day", to - 1, 0, turn));
  return [...goal.terms].reverse().find((t) => calendarDay(t.from) <= last) ?? goal.terms[0];
};

/* ── changing them ────────────────────────────────────────────────────────── */

/** Takes the old daily goal over before anything is changed beside it. */
const adopt = (state) => {
  const old = inherited(state);
  return { ...state, goals: old ? [...(state.goals ?? []), old] : state.goals ?? [] };
};
const edit = (state, id, fn) => {
  const next = adopt(state);
  return { ...next, goals: next.goals.map((g) => (g.id === id ? fn(g) : g)) };
};
/** The day it is for the owner, as its calendar day. */
const startOfDay = (state, now) =>
  calendarDay(periodBoundary("day", now, 0, dayTurn(prefOf(state, "dayEndsAt"))));

export const addGoal = (state, fields, now, id) => {
  const goal = readGoal(fields);
  if (!goal) return state;
  const { target, days, ...rest } = goal;
  const next = adopt(state);
  const order = Math.max(-1, ...next.goals.filter((g) => !g.deletedAt).map((g) => g.order ?? 0)) + 1;
  return {
    ...next,
    goals: [...next.goals, {
      id, ...rest, terms: [{ from: startOfDay(state, now), target, days }], order, pauses: [], createdAt: now, deletedAt: null,
    }],
  };
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const editGoal = (state, id, fields, now) => {
  const goal = readGoal(fields);
  if (!goal) return state;
  return edit(state, id, (g) => {
    const { target, days, type, currency = null, period, scope } = goal;
    const entry = { from: startOfDay(state, now), target, days };
    const asks = (x) => [x.type, x.currency ?? null, x.period, x.scope];
    if (!same(asks(g), asks(goal))) {
      const next = { ...g, type, period, scope, terms: [entry], pauses: (g.pauses ?? []).filter((p) => p.to === null) };
      if (currency) next.currency = currency; else delete next.currency;
      return next;
    }
    const last = g.terms.at(-1);
    if (last.target === target && same(last.days, days)) return g;
    // Changed twice in a day, the last one is the day's.
    return { ...g, terms: [...g.terms.filter((t) => t.from < entry.from), entry] };
  });
};

export const removeGoal = (state, id, now) => edit(state, id, (g) => ({ ...g, deletedAt: now }));
export const restoreGoal = (state, id) => edit(state, id, (g) => ({ ...g, deletedAt: null }));

/** A paused goal asks nothing, and the periods it was paused in are in no
 *  result. Paused and resumed on one day, it was not paused. */
export const pauseGoal = (state, id, now) => edit(state, id, (g) => (isPausedGoal(g) ? g
  : { ...g, pauses: [...(g.pauses ?? []), { from: now, to: null }] }));
export const resumeGoal = (state, id, now) => edit(state, id, (g) => ({
  ...g,
  pauses: (g.pauses ?? [])
    .map((p) => (p.to === null ? { ...p, to: now } : p))
    .filter((p) => startOfDay(state, p.from) !== startOfDay(state, p.to)),
}));

/** Moves a goal one place up (-1) or down (1) the list. */
export const moveGoal = (state, id, by) => {
  const list = liveGoals(state);
  const at = list.findIndex((g) => g.id === id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= list.length) return state;
  const ids = list.map((g) => g.id);
  [ids[at], ids[to]] = [ids[to], ids[at]];
  const place = new Map(ids.map((x, i) => [x, i]));
  const next = adopt(state);
  return {
    ...next,
    goals: next.goals.map((g) => (place.has(g.id) && g.order !== place.get(g.id) ? { ...g, order: place.get(g.id) } : g)),
  };
};

/* ── reading them ─────────────────────────────────────────────────────────── */

/** The work projects a goal covers. Off the clock is never work. */
export const coveredBy = (goal, projects) => (projects ?? []).filter((p) => {
  if (p.deletedAt || isOffClock(p)) return false;
  if (goal.scope.kind === "project") return p.id === goal.scope.projectId;
  if (goal.scope.kind === "company") return fold(companyOf(p)) === fold(goal.scope.company);
  return true;
});

/**
 * Whether a goal is one to work towards now: not paused, and with a project
 * running to work on. A project on hold or done takes its own goal off the
 * screens, and so does the last one of a company's to stop; the goal is kept,
 * and is back when one runs again. Everything that shows or announces goals
 * asks here, so none of them shows one the others do not.
 */
export const hasOpenWork = (goal, projects) =>
  goal.scope.kind === "all" || coveredBy(goal, projects).some(isActive);
export const isGoing = (goal, projects) => !isPausedGoal(goal) && hasOpenWork(goal, projects);

/** Whose goal it is, in words. */
export const coverWords = (goal, projects) => {
  if (goal.scope.kind === "all") return "All work";
  if (goal.scope.kind === "company") return goal.scope.company;
  return (projects ?? []).find((p) => p.id === goal.scope.projectId && !p.deletedAt)?.name ?? "A removed project";
};

/**
 * What a goal counts in [from, to). All work is counted as the headline counts
 * it, every session that is not off the clock, so a session whose project has
 * gone is still time that was worked.
 */
const recordsOf = (goal, ctx) => {
  const off = new Set(ctx.projects.filter(isOffClock).map((p) => p.id));
  const mine = goal.scope.kind === "all" ? null : new Set(coveredBy(goal, ctx.projects).map((p) => p.id));
  const counts = (x) => (mine ? mine.has(x.projectId) : !off.has(x.projectId));
  return { sessions: ctx.sessions.filter(counts), earnings: ctx.earnings.filter(counts) };
};

const measure = (goal, totals, target, ctx) =>
  dayGoalState({ type: goal.type, currency: goal.currency, target }, totals, ctx);
const reading = (goal, terms, ctx, from, to, { sessions, earnings } = recordsOf(goal, ctx)) => measure(
  goal, performanceIn(sessions, from, to, ctx.now, ctx.rateOf, earnings), terms.target, ctx);

/** What an hour on a money goal's work has been earning, or null: also where
 *  some of it was in money that could not be counted. */
const rateFor = (goal, ctx, { sessions, earnings }) => recentRate(sessions, earnings, ctx.now, ctx.rateOf, (t) => {
  const at = measure(goal, t, 1, ctx);
  return { value: Object.keys(at.uncounted).length ? 0 : at.value, ms: t.billedMs };
});

/**
 * Where a goal stands in the period now is in. `ctx` is `{ projects, sessions,
 * earnings, rateOf, now, fxOn, rates, endsAt }`, live records only; `endsAt` is
 * when the owner's day ends (hoursLeft.js).
 *
 * `off` is a daily goal on a day it does not apply to: nothing is asked, and
 * what is done anyway still counts. Weeks and months carry a pace, over the
 * days they apply to. `today` is today's part of it, against what is left of
 * the day (`todayOf`), or null on a day off and where there is none.
 */
export const goalStanding = (goal, ctx) => {
  const day = dayLeft(ctx.now, ctx.endsAt);
  const turn = dayTurn(ctx.endsAt);
  const daily = goal.period === "day";
  const from = periodBoundary(goal.period, ctx.now, 0, turn);
  const to = periodBoundary(goal.period, ctx.now, 1, turn);
  const terms = termsAt(goal, to, turn);
  const records = recordsOf(goal, ctx);
  const at = reading(goal, terms, ctx, from, to, records);
  const rest = !terms.days.includes(weekdayOf(ctx.now, turn));
  const pacing = daily ? null : pace({ target: terms.target, from, to, days: terms.days, turn }, at.value, ctx.now);
  return {
    ...at, from, to, terms, off: daily && rest, pacing, state: paceState(pacing),
    today: rest || at.met ? null : todayOf({
      type: goal.type, target: terms.target, value: at.value,
      valueToday: daily ? at.value : reading(goal, terms, ctx, day.from, day.to, records).value,
      pacing, day, meters: metersOn(records.sessions), now: ctx.now,
      perHour: goal.type === "money" ? rateFor(goal, ctx, records) : null,
    }),
  };
};

/**
 * How the last finished periods went, newest first: `{ from, met }`, at most
 * `RESULTS` of them.
 *
 * Only periods the goal was there for, whole: not the one it was set part way
 * through, nor any it was paused in. A day off counts only where the goal was
 * met on it anyway, so resting is never a miss.
 */
export const goalResults = (goal, ctx) => {
  const since = goal.terms[0].from;
  const turn = dayTurn(ctx.endsAt);
  const records = recordsOf(goal, ctx);
  const out = [];
  for (let n = -1; n >= -LOOK_BACK[goal.period] && out.length < RESULTS; n -= 1) {
    const from = periodBoundary(goal.period, ctx.now, n, turn);
    const to = periodBoundary(goal.period, ctx.now, n + 1, turn);
    if (calendarDay(from) < since) break;
    if ((goal.pauses ?? []).some((p) => p.from < to && (p.to ?? Infinity) > from)) continue;
    const terms = termsAt(goal, to, turn);
    const { met } = reading(goal, terms, ctx, from, to, records);
    if (!met && goal.period === "day" && !terms.days.includes(weekdayOf(from, turn))) continue;
    out.push({ from, met });
  }
  return out;
};
