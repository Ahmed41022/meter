/**
 * `currentRate` is the DEFAULT FOR THE NEXT SESSION, not the rate of work
 * already recorded. Sessions snapshot their own rate at creation. Using one
 * field for both jobs is the bug this separation exists to prevent.
 */

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
