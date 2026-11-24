import { isOffClock } from "./projects.js";
import { isPieceOnly } from "./earnings.js";
import { SCOPE, repriceSessions } from "./terms.js";
import { repriceRewards } from "./settle.js";

/**
 * How a project pays: by the hour, or per accepted task.
 *
 * Not a field. A project paid per task is one with a price and no hourly rate
 * (`isPieceOnly`), so changing the model is a change to the rate, the reward
 * and what the work already recorded is worth, all at once. It is one function
 * for that reason: half of it leaves a project paying both ways, or neither.
 */
export const MODEL = { HOURLY: "hourly", PER_TASK: "perTask" };

export const modelOf = (project) => (isPieceOnly(project) ? MODEL.PER_TASK : MODEL.HOURLY);

/**
 * A project moved to the other model, or the state untouched where the figures
 * would not make one: a price or a rate that is not above zero, a project off
 * the clock, or one already there.
 *
 * Per task: no hourly rate, no hourly bonus, and paid once accepted, which is
 * what a project created that way is. By the hour: the rate, with whichever
 * reward was asked for on top, and none unless it was. When it pays is left as
 * it stands: work waiting on an answer goes on waiting, so nothing is counted
 * as earned by changing a setting.
 *
 * How far it reaches is the question a new rate asks (`setProjectRate`). From
 * now on, tasks still open take the new terms, hours already on them included;
 * tasks handed in and work under no task keep what they were recorded at.
 * Everywhere, every hour on the project takes them, and every handed-in task's
 * acceptance pay is worked out again: the line this app wrote is priced afresh
 * or taken off, and one is written where the new terms pay and there is none.
 * A task with a rate of its own keeps it, and so does an amount typed by hand.
 */
export const setPayModel = (state, projectId, terms, scope, now, nextId) => {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project || isOffClock(project) || modelOf(project) === terms.model) return state;
  const perTask = terms.model === MODEL.PER_TASK;
  const above = (v) => Number.isFinite(v) && v > 0;
  if (!above(perTask ? terms.perTask : terms.rate)) return state;
  const rate = perTask ? 0 : terms.rate;
  const patch = perTask
    ? { currentRate: 0, perTask: terms.perTask, bonusPerHour: null, paysOnAcceptance: true }
    : {
      currentRate: rate,
      // One reward or the other, never both.
      perTask: above(terms.perTask) && !above(terms.bonusPerHour) ? terms.perTask : null,
      bonusPerHour: above(terms.bonusPerHour) ? terms.bonusPerHour : null,
    };
  const next = {
    ...repriceSessions(state, project, rate, scope),
    projects: state.projects.map((p) => (p.id === projectId ? { ...p, ...patch } : p)),
  };
  return scope === SCOPE.ALL ? repriceRewards(next, projectId, now, nextId) : next;
};
