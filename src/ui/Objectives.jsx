import { useState } from "react";
import { formatShortDuration } from "../domain/money.js";
import {
  actualMs, estimateFromHours, estimateRatio, isDone, isToday, orderObjectives, progress,
} from "../domain/objectives.js";
import { tasksFor } from "../domain/tasks.js";

/**
 * What you mean to get done, beside what it actually took.
 *
 * The estimate line is the point of putting this inside a timer rather than in
 * a to-do app: a plain checklist can tell you an item is finished, and only
 * this one can tell you it took half again as long as you thought.
 */

/** Over by more than a tenth reads as over; under by more than a tenth as
 *  under. The band in between is "about right", because calling a five-minute
 *  overrun a failure would make the signal worthless. */
const verdict = (ratio) => {
  if (ratio === null) return null;
  if (ratio > 1.1) return { tone: "over", text: `${Math.round(ratio * 100)}% of estimate` };
  if (ratio < 0.9) return { tone: "under", text: `${Math.round(ratio * 100)}% of estimate` };
  return { tone: "on", text: "on estimate" };
};

function Row({ objective, tasks, sessions, now, today, onToggle, onFocus, onRemove, onEdit }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    text: objective.text,
    hours: objective.estimateMs ? String(objective.estimateMs / 3_600_000) : "",
    taskId: objective.taskId ?? "",
  });
  const spent = actualMs(objective, sessions, now);
  const v = verdict(estimateRatio(objective.estimateMs, spent));
  const picked = isToday(objective, today);

  const save = () => {
    onEdit(objective.id, {
      text: draft.text,
      estimateMs: estimateFromHours(draft.hours),
      taskId: draft.taskId || null,
    });
    setEditing(false);
  };
  const set = (key) => (e) => setDraft((f) => ({ ...f, [key]: e.target.value }));

  if (editing) {
    return (
      <div className="obj-form">
        <label className="field">
          <span className="eyebrow">What needs doing</span>
          <input className="inp" autoFocus value={draft.text} onChange={set("text")}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") save();
                   if (e.key === "Escape") setEditing(false);
                 }} />
        </label>
        <div className="pair">
          <label className="field">
            <span className="eyebrow">Estimate (hours)</span>
            <input className="inp" type="number" min="0" step="any" value={draft.hours}
                   placeholder="none" onChange={set("hours")}
                   onKeyDown={(e) => e.key === "Enter" && save()} />
          </label>
          {/* Relinking lives here because the usual order is backwards: you
              write the objective first and only create the task when you
              actually start timing it. */}
          <label className="field">
            <span className="eyebrow">Track under</span>
            <select className="inp" value={draft.taskId} onChange={set("taskId")}>
              <option value="">Not timed</option>
              {tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
        </div>
        {tasks.length === 0 && (
          <div className="hint">
            No tasks on this project yet. Start the meter and name one, then come back and
            this objective can report the hours against it.
          </div>
        )}
        <div className="controls">
          <button className="btn primary" onClick={save}>Save</button>
          <button className="btn ghost" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className={"obj" + (isDone(objective) ? " done" : "")}>
      <label className="obj-check">
        <input type="checkbox" checked={isDone(objective)}
               onChange={() => onToggle(objective.id)}
               aria-label={`Mark ${objective.text} ${isDone(objective) ? "not done" : "done"}`} />
        <span className="obj-text">{objective.text}</span>
      </label>

      <div className="obj-meta">
        {objective.estimateMs && <span>est {formatShortDuration(objective.estimateMs)}</span>}
        {spent !== null && <span>spent {formatShortDuration(spent)}</span>}
        {v && <span className={`obj-verdict ${v.tone}`}>{v.text}</span>}
        {spent === null && !objective.estimateMs && <span className="obj-untimed">not timed</span>}
      </div>

      <div className="obj-actions">
        <button className="linkish" onClick={() => setEditing(true)}>edit</button>
        {!isDone(objective) && (
          <button className="linkish" aria-pressed={picked}
                  onClick={() => onFocus(objective.id, picked ? null : today)}>
            {picked ? "on today" : "today"}
          </button>
        )}
        <button className="x" aria-label={`Remove ${objective.text}`}
                onClick={() => onRemove(objective.id)}>×</button>
      </div>
    </div>
  );
}

export default function Objectives({
  project, objectives, sessions, now, today, words,
  onAdd, onToggle, onFocus, onRemove, onEdit,
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ text: "", hours: "", taskId: "" });
  const tasks = tasksFor(project);
  const rows = orderObjectives(objectives);
  const { done, total } = progress(objectives);

  const submit = () => {
    if (!form.text.trim()) return;
    onAdd({
      text: form.text,
      estimateMs: estimateFromHours(form.hours),
      taskId: form.taskId || null,
    });
    setForm({ text: "", hours: "", taskId: "" });
    setAdding(false);
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <div className="sec">
      <div className="sec-head">
        <span className="eyebrow">{words.objectives}</span>
        <span className="eyebrow">{total ? `${done} of ${total} done` : ""}</span>
      </div>
      <div className="panel">
        {rows.length === 0 && !adding && <div className="empty">{words.noObjectives}</div>}

        {rows.map((o) => (
          <Row key={o.id} objective={o} tasks={tasks} sessions={sessions} now={now}
               today={today} onToggle={onToggle} onFocus={onFocus}
               onRemove={onRemove} onEdit={onEdit} />
        ))}

        {adding ? (
          <div className="obj-form">
            <label className="field">
              <span className="eyebrow">What needs doing</span>
              <input className="inp" autoFocus value={form.text} placeholder="e.g. finish the report"
                     onChange={set("text")}
                     onKeyDown={(e) => {
                       if (e.key === "Enter") submit();
                       if (e.key === "Escape") setAdding(false);
                     }} />
            </label>
            <div className="pair">
              <label className="field">
                <span className="eyebrow">Estimate (hours)</span>
                <input className="inp" type="number" min="0" step="any" value={form.hours}
                       placeholder="optional" onChange={set("hours")}
                       onKeyDown={(e) => e.key === "Enter" && submit()} />
              </label>
              {/* Linking is what lets the row report time spent. Offered even
                  with no tasks yet, so the field is somewhere you have already
                  looked once one exists. */}
              <label className="field">
                <span className="eyebrow">Track under</span>
                <select className="inp" value={form.taskId} onChange={set("taskId")}
                        disabled={tasks.length === 0}>
                  <option value="">{tasks.length ? "Not timed" : "No tasks yet"}</option>
                  {tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              </label>
            </div>
            <div className="controls">
              <button className="btn primary" onClick={submit}>Add</button>
              <button className="btn ghost" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="linkish obj-add" onClick={() => setAdding(true)}>
            + {words.newObjective}
          </button>
        )}
      </div>
    </div>
  );
}
