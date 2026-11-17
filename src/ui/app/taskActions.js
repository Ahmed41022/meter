import { TASK, isAccepted, isRejected, setAnsweredAt, setSubmittedAt } from "../../domain/taskState.js";
import { answerTasks, reopenTasks, submitTasks } from "../../domain/settle.js";
import { isOpen } from "../../domain/time.js";
import { liveSessions } from "../../domain/sessions.js";
import { paysOnAcceptance } from "../../domain/earnings.js";
import {
  findTask, removeTask, renameTask, setTaskNote, setTaskPrice, setTaskRate,
} from "../../domain/tasks.js";
import { unlinkTask } from "../../domain/objectives.js";
import { uid } from "./shared.js";

/**
 * What the project page does to tasks: edit and delete them, and move them
 * through their life by handing in, answering and reopening. Each one says in
 * a toast what it did, with an Undo.
 */
export function taskActions({ commit, flash, stateRef, project }) {
  return {
    onSaveTask: (taskId, { label, rate, price, note, submittedAt, answeredAt }) =>
      commit((s) => setAnsweredAt(
        setSubmittedAt(
          setTaskNote(
            setTaskPrice(
              setTaskRate(renameTask(s, project.id, taskId, label),
                          project.id, taskId, rate),
              project.id, taskId, price),
            project.id, taskId, note),
          project.id, taskId, submittedAt),
        project.id, taskId, answeredAt)),
    onDeleteTask: (taskId) => {
      const snapshot = stateRef.current;
      // Objectives pointing at the task are unfiled with it, so the
      // intent survives even though the bucket does not.
      commit((s) => unlinkTask(removeTask(s, project.id, taskId), taskId));
      flash("Task deleted. Its sessions moved to “No task”.", "Undo",
            () => commit(() => snapshot));
    },
    /* Handing work in. A meter still running on the work stops at the
       click, the hours stop forever, and they move by the
       project's own rule — counted as earned where it pays as worked,
       pending where it pays once accepted — and the acceptance reward
       is filed pending: a fresh one, or the one the task already had,
       re-priced, so a task handed in twice is never paid twice. All of
       it moves inside `submitTasks`, so no route can leave a task
       marked submitted whose sessions never moved with it.

       The project is re-read from the state being committed rather
       than taken from this render: two clicks in quick succession
       would otherwise price the second against a stale task list. */
    onSubmitTasks: (taskIds, at) => {
      const snapshot = stateRef.current;
      const wasOpen = new Set(liveSessions(snapshot.sessions).filter(isOpen).map((s) => s.id));
      commit((s) => {
        const live = s.projects.find((p) => p.id === project.id);
        return live ? submitTasks(s, live, taskIds, Date.now(), uid, at) : s;
      });
      // Submitting stops a meter left going on the work, and the
      // running bar vanishing without a word would look like a fault.
      const stopped = stateRef.current.sessions.some((s) => wasOpen.has(s.id) && !isOpen(s));
      const one = taskIds.length === 1;
      // What submitting did depends on how the project pays, and the
      // two outcomes are not close enough to share a sentence. Neither
      // calls the hours settled: a rejection can still take them back.
      flash(`${taskIds.length} task${one ? "" : "s"} submitted. `
            + (stopped ? `The meter on ${one ? "it" : "them"} is stopped. ` : "")
            + (paysOnAcceptance(project)
              ? `The clock is closed; nothing is earned until ${one ? "it is" : "they are"} accepted.`
              : "The clock is closed and the hours count as earned, unless "
                + `${one ? "it is" : "they are"} rejected.`),
            "Undo", () => commit(() => snapshot));
    },
    onAnswerTasks: (taskIds, answer, at) => {
      const snapshot = stateRef.current;
      commit((s) => {
        const live = s.projects.find((p) => p.id === project.id);
        return live ? answerTasks(s, live, taskIds, answer, at ?? Date.now()) : s;
      });
      const one = taskIds.length === 1;
      const count = `${taskIds.length} task${one ? "" : "s"}`;
      // "Own" because a reward shared across a batch is not paid or
      // cancelled by answering one task in it.
      flash(
        answer === TASK.ACCEPTED
          ? `${count} accepted. ${one ? "Its hours and its own reward are" : "Their hours and their own rewards are"} paid.`
          : `${count} rejected. ${one ? "Its" : "Their"} money is cancelled and the hours `
            + "stay on the record; answering Accepted puts the money back.",
        "Undo", () => commit(() => snapshot),
      );
    },
    /* Reopening an answered task takes back what the answer did: its
       hours and its own reward are pending until it is accepted again,
       so an acceptance reopened by mistake stops counting at once.
       A task that was only handed in had no answer to take back, and
       its money stays where it is. The toast says which happened,
       because the two look the same on the button. */
    onReopenTasks: (taskIds) => {
      const snapshot = stateRef.current;
      const before = snapshot.projects.find((p) => p.id === project.id) ?? project;
      const answered = taskIds.filter((id) => {
        const task = findTask(before, id);
        return isAccepted(task) || isRejected(task);
      }).length;
      commit((s) => {
        const live = s.projects.find((p) => p.id === project.id);
        return live ? reopenTasks(s, live, taskIds, Date.now()) : s;
      });
      const one = taskIds.length === 1;
      flash(`${taskIds.length} task${one ? "" : "s"} reopened. ${one ? "It takes" : "They take"} time again`
            + (answered === 0
              ? "; the money is as it was."
              : answered === taskIds.length
                ? `, and ${one ? "its" : "their"} money is pending until `
                  + `${one ? "it is" : "they are"} accepted again.`
                : `. The ${answered} that had an answer ${answered === 1 ? "has its" : "have their"}`
                  + " money pending until accepted again."),
            "Undo", () => commit(() => snapshot));
    },
  };
}
