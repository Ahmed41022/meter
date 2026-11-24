/**
 * Which meters may run at the same time.
 *
 * One person does one thing at a time, so one meter at a time was the rule for
 * everything. Two kinds of time break it honestly:
 *
 *  - LIFE. An off-the-clock activity is not work and never reaches an earnings
 *    figure, so it can run beside any work without counting an hour twice.
 *    Two life activities are still one at a time.
 *  - PARALLEL WORK. Some projects pay for a task's clock while something else
 *    is doing the waiting (a response generating, say), and let several run at
 *    once. A project says so with `parallelTasks`; its meters then run beside
 *    each other and beside any other project's. The one thing they cannot do
 *    is run twice on the same task, which would bill the same work to itself
 *    for the same minutes.
 *
 * Everything else is SOLO: one at a time among itself. Idle time is solo
 * whatever its project, because it says you are not working. The two
 * directions differ, though. Going idle leaves a background task's clock
 * ticking, since it is still earning; starting any work ends the idle time.
 *
 * Two questions are asked here and they read the project differently. What a
 * start DISPLACES goes by what the project allows now. Whether two records MAY
 * OVERLAP also honours `parallel`, the snapshot taken when the meter started,
 * so turning the option off later does not make last month's records wrong.
 *
 * Like the rest of `domain/`, nothing here reads the clock or storage. It
 * imports only leaves, because sessions.js and merge.js both ask it.
 */
import { isOpen, isRunning, openSegment } from "./time.js";
import { isOffClock } from "./projects.js";

const LANE = { LIFE: "life", PARALLEL: "parallel", SOLO: "solo" };

export const allowsParallel = (project) => project?.parallelTasks === true && !isOffClock(project);

const idle = (s) => s.kind === "idle";

/** What a session is for the rules; `asRecorded` honours its own snapshot. */
const laneOf = (session, project, asRecorded = false) => {
  if (isOffClock(project)) return LANE.LIFE;
  if (idle(session)) return LANE.SOLO;
  return allowsParallel(project) || (asRecorded && session.parallel === true) ? LANE.PARALLEL : LANE.SOLO;
};

/** No task is a task here: two unfiled meters are the same work twice. */
const sameWork = (a, b) =>
  a.projectId === b.projectId && (a.taskId ?? null) === (b.taskId ?? null);

const finder = (projects) => {
  const byId = new Map((projects ?? []).map((p) => [p.id, p]));
  return (session) => byId.get(session.projectId) ?? null;
};

/** Whether two records may share the same hours without being a mistake. */
export const mayOverlap = (a, b, projects) => {
  if (sameWork(a, b)) return false;
  const projectOf = finder(projects);
  const one = laneOf(a, projectOf(a), true);
  const two = laneOf(b, projectOf(b), true);
  if (one === LANE.LIFE || two === LANE.LIFE) return one !== two;
  return one === LANE.PARALLEL || two === LANE.PARALLEL;
};

/** Whether starting `next` (a session about to run) has to close `other`. */
const displaces = (next, other, projectOf) => {
  if (sameWork(next, other)) return true;
  const mine = laneOf(next, projectOf(next));
  const theirs = laneOf(other, projectOf(other));
  if (mine === LANE.LIFE || theirs === LANE.LIFE) return mine === theirs;
  if (idle(other)) return true;
  return mine === LANE.SOLO && theirs === LANE.SOLO;
};

/** The open sessions, running or paused, that starting `next` closes. */
export const displacedBy = (sessions, projects, next) => {
  const projectOf = finder(projects);
  return sessions.filter((s) =>
    !s.deletedAt && isOpen(s) && s.id !== next.id && displaces(next, s, projectOf));
};

/** Whether a start here would end a meter that is going, for the one-click
 *  starts that must never be one-click ways to stop something. */
export const wouldStop = (sessions, projects, next) =>
  displacedBy(sessions, projects, next).some(isRunning);

/** Whether meters are running that should not run together, which only a
 *  merge of two devices can produce. */
export const metersClash = (sessions, projects) => {
  const going = sessions.filter((s) => !s.deletedAt && isRunning(s));
  return going.some((a, i) => going.slice(i + 1).some((b) => !mayOverlap(a, b, projects)));
};

/**
 * The running meters, the main one first.
 *
 * The main one is what you are actually doing: the solo meter if there is one,
 * since nothing else of its kind can be going. Failing that the parallel task
 * started, resumed or made main most recently, and failing any work, the life
 * activity. Each is `{ session, project, main, background, canBeMain }`, where
 * background is work running behind the main meter; a life activity beside
 * work is neither main nor background.
 */
export const runningMeters = (sessions, projects) => {
  const projectOf = finder(projects);
  const rank = { [LANE.SOLO]: 0, [LANE.PARALLEL]: 1, [LANE.LIFE]: 2 };
  const since = (s) => Math.max(s.mainAt ?? 0, openSegment(s)?.startedAt ?? 0);
  return sessions
    .filter((s) => !s.deletedAt && isRunning(s) && projectOf(s))
    .map((session) => ({ session, project: projectOf(session), lane: laneOf(session, projectOf(session)) }))
    .sort((a, b) => rank[a.lane] - rank[b.lane] || since(b.session) - since(a.session))
    .map(({ session, project, lane }, i, all) => ({
      session,
      project,
      main: i === 0,
      background: i > 0 && lane !== LANE.LIFE,
      // Only a parallel task can take over from another: a solo meter is what
      // you are doing for as long as it runs.
      canBeMain: i > 0 && lane === LANE.PARALLEL && all[0].lane === LANE.PARALLEL,
    }));
};

/** The task ids (null for none) of a project with a meter going, leaving out
 *  one session: what another meter there may not be started on or moved to. */
export const tasksGoing = (sessions, projectId, exceptId = null) => new Set(
  sessions
    .filter((s) => !s.deletedAt && s.projectId === projectId && s.id !== exceptId && isRunning(s))
    .map((s) => s.taskId ?? null),
);
