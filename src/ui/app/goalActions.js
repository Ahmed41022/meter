import {
  addGoal, editGoal, moveGoal, pauseGoal, removeGoal, restoreGoal, resumeGoal,
} from "../../domain/workGoals.js";
import { askToNotify } from "../notify.js";
import { uid } from "./shared.js";

/** What Today does to the goals for work. */
export function goalActions({ commit, flash }) {
  return {
    onAddGoal: (fields) => {
      commit((s) => addGoal(s, fields, Date.now(), uid()));
      // Asked while the person is clicking: the goal is met with nobody there.
      askToNotify();
    },
    onEditGoal: (id, fields) => commit((s) => editGoal(s, id, fields, Date.now())),
    onMoveGoal: (id, by) => commit((s) => moveGoal(s, id, by)),
    onPauseGoal: (id) => {
      commit((s) => pauseGoal(s, id, Date.now()));
      flash("Goal paused.", "Undo", () => commit((s) => resumeGoal(s, id, Date.now())));
    },
    onResumeGoal: (id) => commit((s) => resumeGoal(s, id, Date.now())),
    onRemoveGoal: (id) => {
      commit((s) => removeGoal(s, id, Date.now()));
      flash("Goal deleted.", "Undo", () => commit((s) => restoreGoal(s, id)));
    },
  };
}
