import {
  addProject, patchProject, removeProject, setStatus,
} from "../../domain/projects.js";
import { repriceHourlyRewards } from "../../domain/settle.js";
import { setPayPeriod } from "../../domain/payPeriod.js";
import { SCOPE, setOwnLimit, setProjectRate, setTaskLimit } from "../../domain/terms.js";
import { setOwnMinimum } from "../../domain/minimum.js";
import { askToNotify } from "../notify.js";
import { uid } from "./shared.js";

/**
 * What the project page does to the project itself: its pay schedule, its
 * fields, its terms, its status, and deleting it.
 */
export function projectActions({ commit, flash, stateRef, project, setOpenProjectId }) {
  return {
    /* Keyed by company name rather than by project: every project
       under one client shares the schedule, which is the point. */
    onSetPayPeriod: (company, rule) =>
      commit((s) => setPayPeriod(s, company, rule, Date.now())),
    onPatch: (patch) => {
      commit((s) => patchProject(s, project.id, patch));
      // Asked while the person is clicking: see onSetTerms.
      if (patch.taskMinMs > 0 && patch.taskMinMs !== project.taskMinMs) askToNotify();
    },
    onSetTerms: ({ rate, limit }, scope) => {
      const snapshot = stateRef.current;
      const at = Date.now();
      commit((s) => {
        let next = rate ? setProjectRate(s, project.id, rate, scope) : s;
        if (limit) {
          next = setTaskLimit(next, project.id, limit, scope, at);
          // A bonus already written for a task handed in was priced
          // from the old limit; reaching the past, it follows the new.
          if (scope === SCOPE.ALL) next = repriceHourlyRewards(next, project.id, at);
        }
        return next;
      });
      // Asked here, while the person is clicking: the crossing itself
      // happens with nobody at the keyboard, when a browser will not ask.
      if (limit?.ms) askToNotify();
      // Reaching the past moves figures already reported, so it can be
      // taken back as one step.
      if (scope === SCOPE.ALL) {
        flash("Repriced the whole project.", "Undo", () => commit(() => snapshot));
      }
    },
    onSetOwnLimit: (taskId, ms) => commit((s) => setOwnLimit(s, project.id, taskId, ms)),
    onSetOwnMinimum: (taskId, ms) => {
      commit((s) => setOwnMinimum(s, project.id, taskId, ms));
      if (ms > 0) askToNotify();
    },
    onSetStatus: (status) => {
      commit((s) => setStatus(s, project.id, status, Date.now()));
      if (status !== "active") {
        flash(status === "done" ? "Marked done." : "Paused.", "Undo",
          () => commit((s) => setStatus(s, project.id, "active", Date.now())));
      }
    },
    onDeleteProject: () => {
      const snapshot = stateRef.current;
      commit((s) => removeProject(s, project.id, Date.now()));
      setOpenProjectId(null);
      flash("Project removed.", "Undo", () => commit(() => snapshot));
    },
  };
}

/**
 * Adding a project, from the lists. `schedule` is a payday for a client that
 * has none yet, set from the create card: one write with the project, so an
 * Undo or a sync never sees the project without it.
 */
export function projectListActions({ commit }) {
  return {
    onAdd: (fields, schedule = null) => commit((s) => {
      const at = Date.now();
      const next = addProject(s, fields, at, uid());
      return schedule && fields.company?.trim() ? setPayPeriod(next, fields.company, schedule, at) : next;
    }),
  };
}
