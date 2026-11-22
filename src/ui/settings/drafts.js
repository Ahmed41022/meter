import { formOf } from "./form.js";

/**
 * Unsaved settings that outlive the panel. Held in module scope, not in the
 * component, so a draft survives closing the panel and leaving the project, and
 * so the window can be asked to stay open while one exists.
 */
/**
 * Settings typed and not yet saved, by project, kept outside the panel.
 *
 * The panel goes away whenever it is closed or its project is left, and a
 * draft held only in its own state would go with it: a rename typed in, then
 * "← All projects", and the project is back to its old name with nothing
 * said. These boxes used to save as focus left them, so leaving straight
 * after typing is an easy habit to have. Kept here, the draft is waiting when
 * the panel opens again, the closed panel's header says it is there, and
 * closing the window asks first.
 */
const drafts = new Map();

/** Whether a project has settings typed and not saved. */
export const unsavedSettings = (projectId) => drafts.has(projectId);

/** Whether any project has, so an update knows to wait before reloading. */
export const anyUnsavedSettings = () => drafts.size > 0;

/**
 * The window is about to go, and every draft with it, so the browser is asked
 * to check with the user first. Inside the desktop app the shell hears the
 * same objection and asks in a dialog of its own (desktop/unsaved.js), since
 * Electron on its own would just refuse to close and say nothing.
 */
const askBeforeLeaving = (e) => {
  e.preventDefault();
  e.returnValue = true; // how older browsers were asked the same thing
};
let asking = false;
export const keepDraft = (projectId, draft) => {
  if (draft) drafts.set(projectId, draft);
  else drafts.delete(projectId);
  const ask = drafts.size > 0;
  if (ask === asking) return;
  window[ask ? "addEventListener" : "removeEventListener"]("beforeunload", askBeforeLeaving);
  asking = ask;
};

/**
 * The panel as the project stands now, with a kept draft laid back over it.
 *
 * Only the fields that were edited come back. Every other one is read
 * afresh, so a change that arrived in the meantime — from the other device,
 * say — is not quietly undone by the next Save.
 */
export const restored = (project, payPeriod) => {
  const fresh = formOf(project, payPeriod);
  const kept = drafts.get(project.id);
  if (!kept) return fresh;
  const edited = (key) => JSON.stringify(kept.form[key]) !== JSON.stringify(kept.saved[key]);
  return Object.fromEntries(
    Object.keys(fresh).map((key) => [key, edited(key) ? kept.form[key] : fresh[key]]),
  );
};
