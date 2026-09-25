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

/**
 * A project is active, paused or done, and never two of those at once.
 *
 * One field rather than a `paused` and a `done` flag, because two booleans can
 * express a state that does not exist and then every reader has to decide what
 * a project marked both means. Absent reads as active, so nothing written
 * before this existed changed meaning.
 *
 * Paused and done differ in intent, not in bookkeeping: both leave the Targets
 * panel and both refuse a new meter, because a goal you are not working
 * towards is noise and a stopped project should not quietly resume. What
 * separates them is what you are saying — "not now" keeps the project in
 * place, "finished" files it away with a closing summary.
 *
 * Neither hides a minute of history. The hours happened and the money was
 * real, so both stay in the breakdowns, the calendar and every earnings total
 * for the periods they actually worked.
 */
export const statusOf = (project) => project?.status ?? "active";
export const isActive = (project) => statusOf(project) === "active";
export const isPaused = (project) => statusOf(project) === "paused";
export const isDone = (project) => statusOf(project) === "done";

/** Can a meter be started on it? The one question both non-active states
 *  answer the same way, kept in one place so no caller has to remember that
 *  it is two of them. */
export const acceptsTime = (project) => isActive(project);

export const activeProjects = (projects) => projects.filter(isActive);
export const finishedProjects = (projects) => projects.filter(isDone);

/** `at` is stamped so a done project can report the range it ran. Returning to
 *  active clears both fields rather than leaving a stale date behind. */
export const setStatus = (state, id, status, now) =>
  patchProject(state, id, status === "active"
    ? { status: null, statusAt: null }
    : { status, statusAt: now });

/**
 * Who the work is for. Free text rather than a record of its own: a company is
 * a name until it needs to carry something, and this can become a real entity
 * later without touching a single stored project — the name is the key either
 * way. Absent and empty both read as no company.
 */
export const companyOf = (project) => {
  const name = (project?.company ?? "").trim();
  return name || null;
};

/** Every company named so far, for the suggestion list. Case-insensitively
 *  deduplicated so "Northwind" and "northwind" don't become two clients, keeping
 *  whichever spelling was used first. */
export const companiesIn = (projects) => {
  const seen = new Map();
  for (const project of projects) {
    const name = companyOf(project);
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
};

export const addProject = (
  state,
  { name, rate, currency, offClock = false, perTask = null, paysOnAcceptance = false },
  now,
  id,
) => ({
  ...state,
  projects: [
    ...state.projects,
    {
      id,
      name: name.trim(),
      // Zero on work paid per item, and correct: the clock earns nothing there,
      // the accepted items do. Money is derived from rate x elapsed, so a rate
      // invented to satisfy a form would show income that never arrived.
      currentRate: rate,
      currency,
      createdAt: now,
      sessionGoal: null,
      overallGoal: null,
      ...(offClock ? { offClock: true } : {}),
      // Absent unless asked for, like every other field added after the fact.
      ...(perTask ? { perTask } : {}),
      ...(paysOnAcceptance ? { paysOnAcceptance: true } : {}),
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

/** `needsRate` is false for something off the clock, which has nothing to
 *  charge — demanding a rate there is what drove people to type 0.00001. */
/**
 * `model` says which price the form was asking for, because the two are not
 * interchangeable: work paid per accepted item has no meaningful hourly rate to
 * demand up front, and insisting on one forced every such project to be created
 * as a lie and corrected afterwards.
 */
export const validateProject = ({ name, rate, perTask }, { needsRate = true, model = "hourly" } = {}) => {
  if (!name || !name.trim()) return "Give it a name.";
  if (!needsRate) return null;
  if (model === "perTask") {
    const each = Number(perTask);
    if (!Number.isFinite(each) || each <= 0) return "What does one task pay? A number above zero.";
    return null;
  }
  const parsed = Number(rate);
  if (!Number.isFinite(parsed) || parsed <= 0) return "The rate needs to be a number above zero.";
  return null;
};

/**
 * Fold a name to what a person typing it means.
 *
 * Separators are not meaningful in these names — the same body of work has been
 * filed as "pair review", "extensions-pair-review" and "pair_SQL" — so spaces,
 * underscores and hyphens all collapse to one space. Anyone who types
 * "env building" is looking for `orion_env_building`, and a plain substring
 * match would not find it.
 */
const fold = (s) => (s ?? "").toLowerCase().replace(/[\s_-]+/g, " ").trim();

/** An empty query matches everything, rather than nothing: a cleared search box
 *  should show the list again, not an empty one. */
export const matchesQuery = (project, query) => {
  const q = fold(query);
  if (!q) return true;
  return fold(project?.name).includes(q) || fold(companyOf(project)).includes(q);
};

/** The company is searched too: with forty projects under one client, "northwind"
 *  is a question a reader will actually ask. */
export const searchProjects = (projects, query) =>
  (projects ?? []).filter((p) => matchesQuery(p, query));
