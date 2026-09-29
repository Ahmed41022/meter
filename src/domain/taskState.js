/**
 * Where a task is in its life, and whether it will take any more time.
 *
 * ABSENT MEANS OPEN — still being worked, which is what every task written
 * before this existed says. Nothing already stored changed meaning, so there
 * is no migration and no version bump.
 *
 * All three named states are terminal FOR TIME. Once work is handed in the
 * hours are fixed forever: the platform priced what it received, and minutes
 * added afterwards are minutes nobody is paying for. Only the money moves
 * after that, which is why this is a state on the task rather than a flag on
 * each session.
 *
 *  - SUBMITTED  handed in. The hourly money is settled — it was worked and
 *               delivered — and only the acceptance reward is still waiting on
 *               somebody else's decision.
 *  - ACCEPTED   the decision came back yes. The reward is paid.
 *  - CANCELLED  it came back no. The hours stay, and stay paid; only the
 *               reward is cancelled. Work that was done and then rejected is
 *               a fact about how the month went, not an error to erase.
 *
 * This module imports nothing on purpose. `sessions.js` has to ask whether a
 * task still takes time, and it cannot import `tasks.js` — that file already
 * imports `sessions.js`, so the two would close a cycle. Keeping the question
 * here lets both sides ask it.
 */

export const TASK = {
  SUBMITTED: "submitted",
  ACCEPTED: "accepted",
  CANCELLED: "cancelled",
};

export const taskState = (task) => task?.state ?? null;

export const isOpenTask = (task) => taskState(task) === null;
export const isSubmitted = (task) => taskState(task) === TASK.SUBMITTED;
export const isAccepted = (task) => taskState(task) === TASK.ACCEPTED;
export const isRejected = (task) => taskState(task) === TASK.CANCELLED;

/** Whether a task will accept more hours. Every named state says no. */
export const takesTime = (task) => isOpenTask(task);

/** The same question asked of a project and a task id, for callers that hold
 *  the project rather than the task. No task at all takes time freely: work
 *  filed under nothing in particular has nothing to have been submitted. */
export const takesTimeIn = (project, taskId) => {
  if (!taskId) return true;
  const found = (project?.tasks ?? []).find((t) => t.id === taskId);
  return found ? takesTime(found) : true;
};

/**
 * Moves tasks between states, any number at once.
 *
 * Plural because that is how acceptance actually arrives — a platform reviews
 * a week of submissions and answers them together. `null` reopens a task,
 * clearing both fields rather than leaving a stale date behind, the same way
 * returning a project to active does.
 */
export const setTaskStateMany = (state, projectId, taskIds, next, now) => {
  const wanted = new Set(taskIds ?? []);
  if (wanted.size === 0) return state;
  return {
    ...state,
    projects: state.projects.map((p) => {
      if (p.id !== projectId) return p;
      return {
        ...p,
        tasks: (p.tasks ?? []).map((t) => {
          if (!wanted.has(t.id)) return t;
          const copy = { ...t };
          if (next == null) {
            delete copy.state;
            delete copy.stateAt;
          } else {
            copy.state = next;
            copy.stateAt = now;
          }
          return copy;
        }),
      };
    }),
  };
};

export const setTaskState = (state, projectId, taskId, next, now) =>
  setTaskStateMany(state, projectId, [taskId], next, now);
