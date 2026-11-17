import { KIND, startSession } from "../../domain/sessions.js";
import {
  addTodo, clearDone, editTodo, removeTodo, restoreTodos, toggleTodo,
} from "../../domain/todos.js";
import { uid } from "./shared.js";

/** What the Today screen does: the to-do list, and starting a session on a project. */
export function todayActions({ commit, flash, stateRef, projects, device, openProject }) {
  return {
    onAddTodo: (fields) => commit((s) => addTodo(s, fields, Date.now(), uid())),
    onToggleTodo: (id) => commit((s) => toggleTodo(s, id, Date.now())),
    onEditTodo: (id, patch) => commit((s) => editTodo(s, id, patch)),
    onRemoveTodo: (id) => {
      commit((s) => removeTodo(s, id, Date.now()));
      flash("Removed.", "Undo", () => commit((s) => restoreTodos(s, [id])));
    },
    onClearDone: () => {
      // The ids are taken from the state the clear is made on, so
      // Undo puts back those and not one removed by hand earlier.
      const at = Date.now();
      const { ids } = clearDone(stateRef.current, at);
      if (ids.length === 0) return;
      commit((s) => clearDone(s, at).state);
      flash("Cleared.", "Undo", () => commit((s) => restoreTodos(s, ids)));
    },
    onStart: (projectId, taskId, kind) => {
      const owner = projects.find((p) => p.id === projectId);
      if (!owner) return;
      commit((s) => startSession(s, owner, {
        now: Date.now(), id: uid(), kind: kind ?? KIND.BILLED, taskId, device,
      }));
      openProject(projectId);
    },
  };
}
