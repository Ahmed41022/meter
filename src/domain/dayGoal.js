import { conversion } from "./fxDisplay.js";
import { convertFigures } from "./fx.js";

/**
 * A goal for a day of work, over every project together.
 *
 * `{ type: "time", target }` in minutes, or `{ type: "money", target,
 * currency }` in whole units of that currency: the units a project's goal is
 * kept in, so the same bar draws both. It is a preference (prefs.js), so it is
 * the same on every device, and null when there is none.
 *
 * What counts is what counts for a project's goal (`goalValue`): billed time,
 * and money earned that day whether it has been answered yet or not. Cancelled
 * money, idle time and anything off the clock count for nothing.
 */
const isCode = (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v);

export const isDayGoal = (g) =>
  g !== null && typeof g === "object" && Number.isFinite(g.target) && g.target > 0
  && (g.type === "time" || (g.type === "money" && isCode(g.currency)));

/**
 * Where the day stands. `totals` is `performanceIn` over the day, for work
 * only; `fx` is `{ fxOn, rates }`.
 *
 * A money goal is in one currency and a day can be worked in several. With
 * live rates the rest is converted and the figure is an estimate (`approx`, at
 * the rates of `date`). Without one that is needed, only the goal's own
 * currency counts and the others are named in `left`, because two currencies
 * are never added as if they were one.
 */
export const dayGoalState = (goal, totals, { fxOn = false, rates = null } = {}) => {
  if (!isDayGoal(goal)) return null;
  if (goal.type === "time") return standing(goal, totals.billedMs / 60_000);
  const figures = { ...totals.billedCents };
  for (const [code, cents] of Object.entries(totals.pendingCents)) {
    figures[code] = (figures[code] ?? 0) + cents;
  }
  const others = Object.fromEntries(
    Object.entries(figures).filter(([code, cents]) => code !== goal.currency && cents !== 0));
  if (Object.keys(others).length === 0) return standing(goal, (figures[goal.currency] ?? 0) / 100);
  if (conversion(figures, { choice: goal.currency, fxOn, rates }).ok) {
    const { cents } = convertFigures(figures, goal.currency, rates);
    if (cents !== null) return { ...standing(goal, cents / 100), approx: true, date: rates.date };
  }
  return { ...standing(goal, (figures[goal.currency] ?? 0) / 100), uncounted: others };
};

const standing = (goal, value) => ({
  value,
  target: goal.target,
  toGo: Math.max(0, goal.target - value),
  over: Math.max(0, value - goal.target),
  met: value >= goal.target,
  approx: false,
  date: null,
  uncounted: {},
});
