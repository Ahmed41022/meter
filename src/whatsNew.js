/**
 * What each release brought, in the words its message uses.
 *
 * Newest first, and only what somebody using the app would notice: the whole
 * list is the changelog's. `at` is the day of the release, and it decides who
 * is told: somebody whose ledger began after it never saw the app without it,
 * so for them it is not new. A release with nothing to tell has no entry, and
 * then there is no message.
 */
export const RELEASES = [
  {
    version: "1.5.0",
    at: "2026-11-24",
    news: [
      ["Goals", "Set daily, weekly or monthly goals for all your work, a company or a project, in time or money. Each says its pace and how its last periods went. They are on Today."],
      ["Parallel tasks", "A project can let several of its tasks run at once, and beside other projects. Turn it on in the project's settings."],
      ["Life beside work", "Starting a life activity no longer stops the work meter."],
      ["Minimum time", "Give a task the least time it has to take and its clock counts down."],
      ["How it pays", "Move a project between by the hour and per task in its settings."],
      ["Faster payments", "The payment history opens many times faster on a long record."],
    ],
  },
];

const parts = (v) => String(v ?? "").split(".").map((n) => Number.parseInt(n, 10));
const isVersion = (v) => /^\d+\.\d+\.\d+$/.test(String(v ?? ""));

/** Whether `a` is a later version than `b`. */
export const isLater = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/**
 * The releases to tell about, newest first: up to the running `version`, later
 * than the last one `seen`, and from after the ledger `began` (the earliest
 * moment on record, or null for an empty one). With nothing seen yet only the
 * running version's news is told, not the app's whole life.
 */
export const newsFor = ({ version, seen, began }, releases = RELEASES) => {
  if (!isVersion(version) || began === null) return [];
  const running = releases.filter((r) => !isLater(r.version, version));
  const unseen = isVersion(seen) ? running.filter((r) => isLater(r.version, seen)) : running.slice(0, 1);
  return unseen.filter((r) => began < Date.parse(`${r.at}T00:00:00Z`));
};
