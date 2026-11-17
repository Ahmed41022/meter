import {
  addObjective, editObjective, focusObjective, removeObjective, restoreObjective, toggleObjective,
} from "../../domain/objectives.js";
import { uid } from "./shared.js";

/** What the project page does to its objectives. */
export function objectiveActions({ commit, flash, project }) {
  return {
    onAddObjective: (fields) =>
      commit((s) => addObjective(s, project.id, fields, Date.now(), uid())),
    onToggleObjective: (id) => commit((s) => toggleObjective(s, id, Date.now())),
    onEditObjective: (id, patch) => commit((s) => editObjective(s, id, patch)),
    onFocusObjective: (id, key) => commit((s) => focusObjective(s, id, key)),
    onRemoveObjective: (id) => {
      commit((s) => removeObjective(s, id, Date.now()));
      flash("Removed.", "Undo", () => commit((s) => restoreObjective(s, id)));
    },
  };
}
