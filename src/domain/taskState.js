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
 * each session. What the money does at each step is `settle.js`'s to do; in
 * short:
 *
 *  - SUBMITTED  handed in, and waiting on somebody else's decision. The hours
 *               count as earned where the project pays as worked and stay
 *               pending where it pays once accepted; the acceptance reward is
 *               pending either way. None of it is final — a rejection still
 *               takes it all back.
 *  - ACCEPTED   the decision came back yes. The hours and the task's own
 *               reward are paid, in the run for the period the answer fell in.
 *  - CANCELLED  it came back no, and reads "rejected". The hours stay on the
 *               record and in every time figure; their money and the reward
 *               are cancelled. Work that was done and then rejected is a fact
 *               about how the month went, not an error to erase.
 *
 * Reopening clears the state, and on an answered task puts its money back to
 * pending until it is accepted again.
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
 * clearing the state and both its dates rather than leaving a stale one
 * behind, the same way returning a project to active does. What a move does
 * to the money is `settle.js`'s business; this only records where the task is.
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
            delete copy.submittedAt;
            return copy;
          }
          copy.state = next;
          copy.stateAt = now;
          /**
           * When the work went in, kept apart from when it was answered.
           *
           * Two dates, because they answer different questions and can be a
           * fortnight apart. The answer (`stateAt`) decides which pay run a
           * task's money is in. The hand-in is the record of delivery — what
           * a bonus window or a query about a slow review turns on, and what
           * dates a reward shared across a batch where the project pays as
           * worked. One field would be overwritten by the answer and lose
           * the day the work went in.
           *
           * Set once and then left alone, so an answer never moves it; an
           * answer to a task never marked submitted stamps it, since the work
           * had gone in by then. A task reopened and handed in again starts a
           * new one, which is right: it is genuinely going in on a different
           * day.
           */
          if (next === TASK.SUBMITTED) copy.submittedAt = now;
          else if (copy.submittedAt == null) copy.submittedAt = now;
          return copy;
        }),
      };
    }),
  };
};

export const setTaskState = (state, projectId, taskId, next, now) =>
  setTaskStateMany(state, projectId, [taskId], next, now);

/** Edits one field of one task, and only where the task has a state at all —
 *  neither of these dates means anything on work still being done. */
const patchStated = (state, projectId, taskId, field, at) => (!Number.isFinite(at) ? state : {
  ...state,
  projects: state.projects.map((p) => {
    if (p.id !== projectId) return p;
    return {
      ...p,
      tasks: (p.tasks ?? []).map((t) => (
        t.id !== taskId || taskState(t) === null ? t : { ...t, [field]: at }
      )),
    };
  }),
});

/**
 * Corrects the day the work went in, after the fact.
 *
 * Needed because the app used to stamp the moment you ticked the box. It does
 * not decide a task's own payday — the answer does — but it is the record of
 * when the work was delivered, which is what a bonus window or a query about
 * a slow review turns on, and it dates a reward shared across a batch on a
 * project paid as worked. A date taken from the clock was simply untrue.
 */
export const setSubmittedAt = (state, projectId, taskId, at) =>
  patchStated(state, projectId, taskId, "submittedAt", at);

/**
 * Corrects the day the answer came back.
 *
 * This is the date that decides which pay run the money is in, so it is the
 * one worth being able to put right. An acceptance read on Friday and ticked
 * off on Monday has crossed a cutoff, and nothing but you knows when the
 * review actually landed.
 *
 * It moves a forecast and never an amount: what the task earned was settled
 * when it was answered, and saying so a day later does not re-earn it.
 */
export const setAnsweredAt = (state, projectId, taskId, at) =>
  patchStated(state, projectId, taskId, "stateAt", at);
