/**
 * Marking single lines of a payment, rather than the payment as a whole.
 *
 * A row of Upcoming payments is one client, day and currency, and an answer in
 * `payouts` is about all of it. But a client can pay three tasks of a payday
 * and hold the fourth back, or pay a bonus early, and then the honest thing to
 * say is about those lines alone. So a line's word is kept on the record the
 * line is made of, which is where the forecast already looks:
 *
 *   an earning (a task's per-item pay, bonus or adjustment, a shared reward, a
 *   bonus naming no task) carries `received: true`, already paid and never
 *   forecast, or `payday`, a day of its own. Both fields already existed.
 *
 *   a task's HOURS have no record of their own, so the task carries the same
 *   two facts for them: `hoursReceived: true` and `hoursPayday`.
 *
 * Marking a line paid also says WHEN: `receivedOn` on an earning and
 * `hoursReceivedOn` on a task, the payday of the row it was marked on, as a day
 * on the client's clock ("2026-11-18"). The forecast drops a paid line, so
 * without it nothing would remember which payday it was part of, and the
 * history (payHistory.js) could only guess. Absent means paid, date not
 * recorded, which is every line marked before this existed. Moving a line, or
 * taking its mark off, clears it: a line that is not paid was paid on no day.
 *
 * Marking a line paid takes it off the list. Moving it puts it on the payment
 * for its new day, beside whatever else that client pays then, which is what
 * the platform will send. Neither touches the money in the earnings: a line
 * marked paid came as listed, and a different amount is said on the row.
 *
 * Absent means what it always meant, so nothing is migrated, and every change
 * is a rebuilt record so the sync stamp sees it. Undo is `readMarks` before
 * and `writeMarks` after, an edit like any other, never an old copy put back.
 *
 * Like the rest of `domain/`, nothing here reads the clock or storage.
 */
import { isDay } from "./payPeriod.js";
import { tasksFor } from "./tasks.js";

/**
 * The records a set of forecast lines is made of, each once. A task's line of
 * one kind may be several earnings added together; its hours are the task.
 */
export const lineRefs = (lines) => {
  const refs = new Map();
  for (const line of lines ?? []) {
    if (line.kind === "task" && line.part === "hours") {
      if (line.projectId && line.taskId) {
        refs.set(`hours:${line.projectId}:${line.taskId}`,
                 { type: "hours", projectId: line.projectId, taskId: line.taskId });
      }
      continue;
    }
    const ids = line.earningId ? [line.earningId] : line.earningIds ?? [];
    for (const id of ids) refs.set(`earning:${id}`, { type: "earning", id });
  }
  return [...refs.values()];
};

const findTask = (state, projectId, taskId) =>
  tasksFor((state.projects ?? []).find((p) => p.id === projectId)).find((t) => t.id === taskId);

/** Each record's marks as they are now: received or not, the day it was
 *  received on or null, and its own payday or null. A record that is not there
 *  is left out. */
export const readMarks = (state, refs) => refs.flatMap((ref) => {
  if (ref.type === "hours") {
    const task = findTask(state, ref.projectId, ref.taskId);
    if (!task) return [];
    return [{ ...ref, received: task.hoursReceived === true,
              receivedOn: isDay(task.hoursReceivedOn) ? task.hoursReceivedOn : null,
              payday: isDay(task.hoursPayday) ? task.hoursPayday : null }];
  }
  const earning = (state.earnings ?? []).find((e) => e.id === ref.id);
  if (!earning) return [];
  return [{ ...ref, received: earning.received === true,
            receivedOn: isDay(earning.receivedOn) ? earning.receivedOn : null,
            payday: isDay(earning.payday) ? earning.payday : null }];
});

/** A record with its marks set as given, or the same record where they
 *  already are, so that nothing unchanged is stamped as an edit. The day
 *  received only means anything on a received record, so it is dropped from
 *  one that is not, whatever the mark says. */
const marked = (record, receivedKey, onKey, paydayKey, { received, receivedOn, payday }) => {
  const on = received === true && isDay(receivedOn) ? receivedOn : null;
  const same = (record[receivedKey] === true) === (received === true)
    && (isDay(record[onKey]) ? record[onKey] : null) === on
    && (isDay(record[paydayKey]) ? record[paydayKey] : null) === (isDay(payday) ? payday : null);
  if (same) return record;
  const next = { ...record };
  if (received === true) next[receivedKey] = true;
  else delete next[receivedKey];
  if (on) next[onKey] = on;
  else delete next[onKey];
  if (isDay(payday)) next[paydayKey] = payday;
  else delete next[paydayKey];
  return next;
};

/** Sets each record's marks exactly as listed, as one change. */
export const writeMarks = (state, marks) => {
  const earnings = new Map();
  const hours = new Map();
  for (const m of marks) {
    if (m.type === "hours") hours.set(`${m.projectId}|${m.taskId}`, m);
    else earnings.set(m.id, m);
  }
  let next = state;
  if (earnings.size) {
    next = {
      ...next,
      earnings: (next.earnings ?? []).map((e) =>
        earnings.has(e.id) ? marked(e, "received", "receivedOn", "payday", earnings.get(e.id)) : e),
    };
  }
  if (hours.size) {
    next = {
      ...next,
      projects: (next.projects ?? []).map((p) => {
        const tasks = tasksFor(p);
        const changed = tasks.map((t) => {
          const m = hours.get(`${p.id}|${t.id}`);
          return m ? marked(t, "hoursReceived", "hoursReceivedOn", "hoursPayday", m) : t;
        });
        return changed.some((t, i) => t !== tasks[i]) ? { ...p, tasks: changed } : p;
      }),
    };
  }
  return next;
};

/**
 * Marks lines as already paid, `{ received: true, on: "2026-11-18" }`, or moves
 * them to a day of their own, `{ payday: "2026-12-02" }`, which also takes back
 * any earlier "paid". `on` is the payday of the row they were marked on; left
 * out, or not a real day, the line is paid with no day recorded, and a line
 * already marked with a day keeps it. Anything else, or a payday that is not a
 * real day, changes nothing.
 */
export const markLines = (state, lines, change) => {
  const paid = change?.received === true;
  if (!paid && !isDay(change?.payday)) return state;
  const marks = readMarks(state, lineRefs(lines)).map((m) =>
    (paid
      ? { ...m, received: true, receivedOn: isDay(change.on) ? change.on : m.received ? m.receivedOn : null }
      : { ...m, received: false, receivedOn: null, payday: change.payday }));
  return writeMarks(state, marks);
};
