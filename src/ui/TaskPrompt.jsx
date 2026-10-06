import { useState } from "react";
import { wordsFor } from "./words.js";
import {
  findTask, findTaskByLabel, taskPriceProblem, taskRateProblem, tasksFor,
} from "../domain/tasks.js";
import { TASK, takesTime, taskState } from "../domain/taskState.js";
import { isPieceOnly, perTask } from "../domain/earnings.js";
import { formatMoney } from "../domain/money.js";
import { payProblemWords } from "./TaskEditor.jsx";

const NONE = "__none__";

/** What became of a task that takes no more time, in the words its row uses:
 *  "cancelled" is how the money is stored, but the work was rejected. */
const CLOSED_WORD = {
  [TASK.SUBMITTED]: "submitted",
  [TASK.ACCEPTED]: "accepted",
  [TASK.CANCELLED]: "rejected",
};

/**
 * Why a task will not take time, in one sentence, or null when it will.
 *
 * Shared by every place that has to turn time away from a task, so that a
 * refusal is never silent and always reads the same way: which task, and
 * what became of it.
 */
export const closedTaskNote = (project, taskId) => {
  const task = findTask(project, taskId);
  if (!task || takesTime(task)) return null;
  return `“${task.label}” was ${CLOSED_WORD[taskState(task)] ?? "closed"}, so it takes no more time.`;
};

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
  // Submitted work takes no more hours, so offering it here would be a
  // choice that starts nothing and moves nothing.
  const tasks = tasksFor(project).filter(takesTime);
  const [mode, setMode] = useState(tasks.length ? "existing" : "new");
  const [taskId, setTaskId] = useState(initialTaskId ?? NONE);
  const [draft, setDraft] = useState("");
  // What this task is worth, asked here because here is where the task comes
  // into existence. Setting it afterwards meant editing the project's rate to
  // get one task priced differently, which repriced everything else.
  const [pay, setPay] = useState("");
  // Everything the label cannot hold. The label is what every report groups
  // by, so it has to stay short and stable — but an id, a link or a line
  // saying what the thing actually is has to live somewhere.
  const [note, setNote] = useState("");
  const piece = isPieceOnly(project);
  /**
   * A pay box that cannot be read, read the way the task editor reads its own
   * boxes. Anything it cannot read used to make the task with no rate or
   * price at all and say nothing, so it says what is wrong and waits.
   */
  const payIssue = mode === "new" && pay.trim()
    ? (piece ? taskPriceProblem(pay) : taskRateProblem(pay))
    : null;
  /**
   * A task already handed in, named in either box.
   *
   * A typed name resolves to the task that has it rather than minting a
   * second one, which is the point of matching names; and a task picked from
   * the list can be handed in from the task list while this is still open.
   * Either way it takes no more time, so confirming would start nothing and
   * move nothing, and a prompt that closes on a click that did nothing reads
   * as the click having worked. So it says which task and why, and stays
   * open for another choice.
   */
  const named = mode === "new"
    ? findTaskByLabel(project, draft)
    : findTask(project, taskId === NONE ? null : taskId);
  const closed = named ? closedTaskNote(project, named.id) : null;
  const refusal = closed && (
    <span className="hint warn" role="alert" style={{ marginTop: 8, display: "block" }}>
      {closed} Reopen it in the {words.byTask} list if there is more to do on it, or
      choose another.
    </span>
  );

  const confirm = () => {
    if (closed || payIssue) return;
    if (mode === "new") {
      const clean = draft.trim();
      return onConfirm(clean ? { label: clean, pay: pay.trim(), note: note.trim() } : { taskId: null });
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
            {/* Handed in while this was open, so no longer on offer, but still
                the one picked. Left out, the box would show the first option
                while the warning named this one, and choosing that first option
                would change nothing, so it could not be chosen at all. */}
            {closed && <option value={named.id} disabled>{named.label}</option>}
          </select>
          {refusal}
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
          {refusal || (
            <span className="hint" style={{ marginTop: 8, display: "block" }}>
              Reusing a name you already have keeps it as one task.
            </span>
          )}
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
          {payIssue && (
            <span className="hint warn" role="alert" style={{ marginTop: 8, display: "block" }}>
              {payProblemWords(payIssue, pay, piece)}
            </span>
          )}
          <span className="hint" style={{ marginTop: 8, display: "block" }}>
            {!piece && <>A percentage stays a percentage: work paid at 30% of the base follows
              the base when it changes, instead of going stale the day it moves. </>}
            Empty uses the project&apos;s figure; <strong>0</strong> says this task pays nothing.
          </span>
        </label>
      )}

      {mode === "new" && (
        <label className="field">
          <span className="eyebrow">Note</span>
          {/* A box, not a line. One task runs across many sittings and
              collects an id from each, so what goes here is usually a list
              that grows — and Enter has to make a new line rather than start
              the meter. */}
          <textarea className="inp note-box" rows={2} value={note}
                    placeholder="ids, a link, what it is — one per line"
                    onChange={(e) => setNote(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }} />
          <span className="hint" style={{ marginTop: 8, display: "block" }}>
            Kept on the task and shown wherever it is listed, including when you
            filter the ledger down to it. Nothing groups or matches on it, so it
            can say whatever you need it to.
          </span>
        </label>
      )}

      <div className="controls">
        <button className="btn primary" disabled={!!closed || !!payIssue} onClick={confirm}>
          {confirmLabel}
        </button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
