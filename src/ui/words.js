/**
 * The same machinery reads very differently depending on what it is timing.
 *
 * "Ledger", "task", "billed" and "Stop and save" are accounting words. Applied
 * to sleep or an evening of play they are not just odd, they are wrong — they
 * invite you to read the panel as money when the whole point of marking a
 * project off the clock was that it isn't.
 *
 * Only the labels differ. The records, the timer, the segments and every
 * figure underneath are identical, which is why this is a lookup in the UI
 * layer and not a second code path through the domain.
 */
import { startedAt } from "../domain/time.js";

const WORK = {
  task: "task",
  taskCap: "Task",
  byTask: "By task",
  noTask: "No task",
  whichTask: "Which task?",
  newTask: "New task",
  editTask: "Edit task",
  existing: "Existing",
  ledger: "Ledger",
  start: "Start the meter",
  stop: "Stop and save",
  emptyLedger: "No sessions yet. Start the meter and this fills in.",
  emptyFiltered: "No sessions filed under this task yet.",
  assign: "Assign to task",
  objectives: "Objectives",
  newObjective: "New objective",
  noObjectives: "Nothing planned yet. Add what you mean to get done.",
  projectNoun: "project",
  deleteTaskWarning: (n) => `${n} session${n === 1 ? "" : "s"} will move to “No task”.`,
};

const OFF_CLOCK = {
  task: "activity",
  taskCap: "Activity",
  byTask: "By activity",
  noTask: "Unsorted",
  whichTask: "Which activity?",
  newTask: "New activity",
  editTask: "Edit activity",
  existing: "Existing",
  ledger: "History",
  start: "Start tracking",
  stop: "Stop",
  emptyLedger: "Nothing tracked yet. Start the timer and this fills in.",
  emptyFiltered: "Nothing logged under this activity yet.",
  assign: "Move to activity",
  objectives: "To-do",
  newObjective: "New to-do",
  noObjectives: "Nothing on the list. Add something you want to get to.",
  projectNoun: "area",
  deleteTaskWarning: (n) => `${n} entr${n === 1 ? "y" : "ies"} will move to “Unsorted”.`,
};

export const wordsFor = (offClock) => (offClock ? OFF_CLOCK : WORK);

/** "today" / "yesterday" / "3 days ago" — nobody says "0 days ago". */
export const daysWord = (days) =>
  days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;

/** How much work is at stake, as a thing rather than a number: "41 records",
 *  and "1 record" rather than "1 records". */
export const countWord = (n) => `${n} record${n === 1 ? "" : "s"}`;

const many = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const dayOf = (t) =>
  new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * A whole ledger in one line — what it holds and the span it covers — so two
 * can be told apart before one replaces the other: "2 projects, 41 sessions
 * and 3 payments, from 4 Jan 2025 to 5 Oct 2026".
 *
 * Only live records count. A backup carries what was deleted as tombstones,
 * and counting those would describe a ledger nobody has ever seen.
 */
export const ledgerWords = (state) => {
  const live = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && !r.deletedAt);
  const projects = live(state?.projects).length;
  const sessions = live(state?.sessions);
  const earnings = live(state?.earnings);
  if (!projects && !sessions.length && !earnings.length) return "nothing at all";
  const parts = [many(projects, "project"), many(sessions.length, "session")];
  if (earnings.length) parts.push(many(earnings.length, "payment"));
  const held = `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  // Reduced rather than spread into Math.min, which would pass every record
  // as an argument and fail on a long enough ledger.
  const times = [...sessions.map(startedAt), ...earnings.map((e) => e.at)].filter(Number.isFinite);
  if (!times.length) return held;
  const first = dayOf(times.reduce((a, b) => Math.min(a, b)));
  const last = dayOf(times.reduce((a, b) => Math.max(a, b)));
  return `${held}, ${first === last ? `on ${first}` : `from ${first} to ${last}`}`;
};
