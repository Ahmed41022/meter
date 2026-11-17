import {
  addManualSession, assignTaskToMany, correctSession, deleteSession, overlappingSessions,
  pauseSession, restoreSession, resumeSession, revertCorrection, startSession, stopSession,
} from "../../domain/sessions.js";
import { acceptsTime, isDone } from "../../domain/projects.js";
import { addTask, taskLabel } from "../../domain/tasks.js";
import { closedTaskNote } from "../TaskPrompt.jsx";
import { payFields, resolveTaskPick, uid } from "./shared.js";

/**
 * What the project page does to sessions: start, pause, resume and stop the
 * meter, remove, re-file and correct sittings, add time by hand, and look for
 * overlaps. Called on every render, as the inline handlers were, and handed to
 * the view by spreading, so each view prop is the same function as before.
 */
export function sessionActions({ commit, flash, stateRef, device, project, current }) {
  return {
    onStart: (kind, pick) => {
      const taskId = resolveTaskPick(project, pick, (st, id, label, pay, note) =>
        addTask(st, project.id, { id, label, note, ...payFields(project, pay) }, Date.now()));
      commit((s) => startSession(
        taskId.prepare(s), project,
        { now: Date.now(), id: uid(), kind, taskId: taskId.id, device }));
    },
    onPause: () => commit((s) => pauseSession(s, current.id, Date.now())),
    onResume: () => commit((s) => resumeSession(s, current.id, Date.now(), device)),
    onStop: () => commit((s) => stopSession(s, current.id, Date.now())),
    onDeleteSession: (id) => {
      commit((s) => deleteSession(s, id, Date.now()));
      flash("Session removed.", "Undo", () => commit((s) => restoreSession(s, id)));
    },
    onAssign: (sessionIds, pick) => {
      const chosen = resolveTaskPick(project, pick, (st, id, label, pay, note) =>
        addTask(st, project.id, { id, label, note, ...payFields(project, pay) }, Date.now()));
      commit((s) => assignTaskToMany(chosen.prepare(s), sessionIds, chosen.id));
    },
    onCorrect: (sessionId, window_) => {
      const snapshot = stateRef.current;
      commit((s) => correctSession(s, sessionId, window_, Date.now()));
      flash("Session corrected.", "Undo", () => commit(() => snapshot));
    },
    onRevertCorrection: (sessionId) =>
      commit((s) => revertCorrection(s, sessionId)),
    /* Named, not linked. You meet this warning mid-form, and a link
       that threw the half-typed entry away to show you the clash
       would cost more than it told you — so it says which record it
       is instead, and you decide. */
    findOverlaps: (window_) => overlappingSessions(stateRef.current, window_).map((s) => {
      const owner = stateRef.current.projects.find((x) => x.id === s.projectId);
      return {
        ...s,
        projectName: owner?.name ?? "a removed project",
        taskName: s.taskId ? taskLabel(owner, s.taskId) : null,
      };
    }),
    /* The domain turns typed-in time away from a project that has
       stopped and from a task already handed in, quietly, by handing
       the ledger back untouched. "Time added." over that would lose
       the hour without a word, so the toast says what really
       happened, and the answer tells the form whether to close. */
    onAddManual: (entry) => {
      const before = stateRef.current;
      const next = addManualSession(before, project, entry, Date.now(), uid());
      if (next === before) {
        const why = !acceptsTime(project)
          ? `This project is ${isDone(project) ? "done" : "on hold"}, so it won't take new time.`
          : closedTaskNote(project, entry.taskId) ?? "A block needs an end after its start.";
        flash(`Nothing was added. ${why}`);
        return false;
      }
      commit(() => next);
      flash("Time added.");
      return true;
    },
  };
}
