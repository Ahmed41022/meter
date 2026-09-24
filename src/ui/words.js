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
