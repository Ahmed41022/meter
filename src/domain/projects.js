/**
 * `currentRate` is the DEFAULT FOR THE NEXT SESSION, not the rate of work
 * already recorded. Sessions snapshot their own rate at creation. Using one
 * field for both jobs is the bug this separation exists to prevent.
 */

/**
 * Some of what you track isn't work: sleep, play, time away from the desk.
 * It still wants a timer and a history, but it must never touch an earnings
 * figure, a billable share, or the project breakdown — a rate of 0.00001 hides
 * the money and leaves the hours sitting in every other total, which is worse
 * than not tracking it at all.
 *
 * The flag is absent on everything written before it existed, and absent reads
 * as work. That is unambiguous, so no schema bump: nothing about the existing
 * data changed meaning.
 */
export const isOffClock = (project) => project?.offClock === true;

/** On-the-clock projects. Deliberately the DEFAULT accessor, for the same
 *  reason `sessionsFor` returns billed sessions only: a caller that forgets
 *  about off-clock work under-reports your own time (harmless) instead of
 *  counting sleep as billable (the expensive failure). */
export const workProjects = (projects) => projects.filter((p) => !isOffClock(p));

/** Off-clock projects must always be asked for by name. */
export const offClockProjects = (projects) => projects.filter(isOffClock);

export const addProject = (state, { name, rate, currency }, now, id) => ({
  ...state,
  projects: [
    ...state.projects,
    {
      id,
      name: name.trim(),
      currentRate: rate,
      currency,
      createdAt: now,
      sessionGoal: null,
      overallGoal: null,
    },
  ],
});

export const patchProject = (state, id, patch) => ({
  ...state,
  projects: state.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)),
});

/** Removes the project and its sessions together. The caller keeps the prior
 *  state to offer an undo. */
export const removeProject = (state, id) => ({
  projects: state.projects.filter((p) => p.id !== id),
  sessions: state.sessions.filter((s) => s.projectId !== id),
});

export const validateProject = ({ name, rate }) => {
  if (!name || !name.trim()) return "Give the project a name.";
  const parsed = Number(rate);
  if (!Number.isFinite(parsed) || parsed <= 0) return "The rate needs to be a number above zero.";
  return null;
};
