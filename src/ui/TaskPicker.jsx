import { useState } from "react";
import { tasksFor } from "../domain/tasks.js";

const NEW = "__new__";
const NONE = "__none__";

/**
 * Picking from the list is the normal path; typing only happens when the task
 * genuinely doesn't exist yet. That ordering is what stops a mistyped label
 * from silently becoming a second task with its own totals.
 */
export default function TaskPicker({ project, value, onPick, disabled, label = "Task" }) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const tasks = tasksFor(project);

  const commitDraft = () => {
    const clean = draft.trim();
    if (!clean) return setCreating(false);
    onPick({ label: clean });
    setDraft("");
    setCreating(false);
  };

  if (creating) {
    return (
      <div className="picker">
        <label className="field">
          <span className="eyebrow">New task</span>
          <input className="inp" autoFocus value={draft} placeholder="e.g. 1234"
                 onChange={(e) => setDraft(e.target.value)}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") commitDraft();
                   if (e.key === "Escape") { setDraft(""); setCreating(false); }
                 }} />
        </label>
        <button className="btn primary" style={{ flex: "0 0 auto" }} onClick={commitDraft}>Add</button>
        <button className="btn ghost" style={{ flex: "0 0 auto" }}
                onClick={() => { setDraft(""); setCreating(false); }}>Cancel</button>
      </div>
    );
  }

  return (
    <div className="picker">
      <label className="field">
        <span className="eyebrow">{label}</span>
        <select className="inp" value={value ?? NONE} disabled={disabled}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === NEW) return setCreating(true);
                  onPick({ taskId: v === NONE ? null : v });
                }}>
          <option value={NONE}>No task</option>
          {tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          <option value={NEW}>+ New task…</option>
        </select>
      </label>
    </div>
  );
}
