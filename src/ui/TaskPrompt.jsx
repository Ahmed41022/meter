import { useState } from "react";
import { tasksFor } from "../domain/tasks.js";

const NONE = "__none__";

/**
 * Asks which task before the meter starts. The choice is an explicit
 * either/or — an existing task or a new one — because that is the moment a
 * mistyped label would otherwise create a duplicate task nobody notices until
 * the report is wrong.
 */
export default function TaskPrompt({
  project, initialTaskId = null, confirmLabel = "Start", onConfirm, onCancel,
}) {
  const tasks = tasksFor(project);
  const [mode, setMode] = useState(tasks.length ? "existing" : "new");
  const [taskId, setTaskId] = useState(initialTaskId ?? NONE);
  const [draft, setDraft] = useState("");

  const confirm = () => {
    if (mode === "new") {
      const clean = draft.trim();
      return onConfirm(clean ? { label: clean } : { taskId: null });
    }
    onConfirm({ taskId: taskId === NONE ? null : taskId });
  };

  return (
    <div className="prompt">
      <span className="eyebrow">Which task?</span>

      <div className="seg" role="tablist">
        <button role="tab" aria-selected={mode === "existing"}
                className={"seg-btn" + (mode === "existing" ? " on" : "")}
                disabled={!tasks.length}
                onClick={() => setMode("existing")}>
          Existing{tasks.length ? ` (${tasks.length})` : ""}
        </button>
        <button role="tab" aria-selected={mode === "new"}
                className={"seg-btn" + (mode === "new" ? " on" : "")}
                onClick={() => setMode("new")}>
          New task
        </button>
      </div>

      {mode === "existing" ? (
        <label className="field">
          <span className="eyebrow">Task</span>
          <select className="inp" value={taskId} autoFocus
                  onChange={(e) => setTaskId(e.target.value)}>
            <option value={NONE}>No task</option>
            {tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
      ) : (
        <label className="field">
          <span className="eyebrow">Name it</span>
          <input className="inp" autoFocus value={draft} placeholder="e.g. 1234"
                 onChange={(e) => setDraft(e.target.value)}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") confirm();
                   if (e.key === "Escape") onCancel();
                 }} />
          <span className="hint" style={{ marginTop: 8, display: "block" }}>
            Reusing a name you already have keeps it as one task.
          </span>
        </label>
      )}

      <div className="controls">
        <button className="btn primary" onClick={confirm}>{confirmLabel}</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
