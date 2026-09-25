import { useState } from "react";
import { wordsFor } from "./words.js";
import { tasksFor } from "../domain/tasks.js";
import { isPerTask, perTask } from "../domain/earnings.js";
import { formatMoney } from "../domain/money.js";

const NONE = "__none__";

/**
 * Asks which task before the meter starts. The choice is an explicit
 * either/or — an existing task or a new one — because that is the moment a
 * mistyped label would otherwise create a duplicate task nobody notices until
 * the report is wrong.
 */
export default function TaskPrompt({
  project, initialTaskId = null, confirmLabel = "Start", onConfirm, onCancel,
  words = wordsFor(false),
}) {
  const tasks = tasksFor(project);
  const [mode, setMode] = useState(tasks.length ? "existing" : "new");
  const [taskId, setTaskId] = useState(initialTaskId ?? NONE);
  const [draft, setDraft] = useState("");
  // What this task is worth, asked here because here is where the task comes
  // into existence. Setting it afterwards meant editing the project's rate to
  // get one task priced differently, which repriced everything else.
  const [pay, setPay] = useState("");
  const piece = isPerTask(project);

  const confirm = () => {
    if (mode === "new") {
      const clean = draft.trim();
      return onConfirm(clean ? { label: clean, pay: pay.trim() } : { taskId: null });
    }
    onConfirm({ taskId: taskId === NONE ? null : taskId });
  };

  return (
    <div className="prompt">
      <span className="eyebrow">{words.whichTask}</span>

      <div className="modes" role="tablist">
        <button role="tab" aria-selected={mode === "existing"}
                className={"seg-btn" + (mode === "existing" ? " on" : "")}
                disabled={!tasks.length}
                onClick={() => setMode("existing")}>
          {words.existing}{tasks.length ? ` (${tasks.length})` : ""}
        </button>
        <button role="tab" aria-selected={mode === "new"}
                className={"seg-btn" + (mode === "new" ? " on" : "")}
                onClick={() => setMode("new")}>
          {words.newTask}
        </button>
      </div>

      {mode === "existing" ? (
        <label className="field">
          <span className="eyebrow">{words.taskCap}</span>
          <select className="inp" value={taskId} autoFocus
                  onChange={(e) => setTaskId(e.target.value)}>
            <option value={NONE}>{words.noTask}</option>
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

      {mode === "new" && (
        <label className="field">
          <span className="eyebrow">{piece ? "Per accepted item" : "Rate"}</span>
          <input className="inp" value={pay}
                 placeholder={piece
                   ? `empty = ${formatMoney(Math.round(perTask(project) * 100), project.currency)}, the project's price`
                   : `empty = ${formatMoney(Math.round((project.currentRate ?? 0) * 100), project.currency)}/hr · or 30%`}
                 onChange={(e) => setPay(e.target.value)}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") confirm();
                   if (e.key === "Escape") onCancel();
                 }} />
          {!piece && (
            <span className="hint" style={{ marginTop: 8, display: "block" }}>
              A percentage stays a percentage: work paid at 30% of the base follows
              the base when it changes, instead of going stale the day it moves.
            </span>
          )}
        </label>
      )}

      <div className="controls">
        <button className="btn primary" onClick={confirm}>{confirmLabel}</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
