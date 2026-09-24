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

function Row({ objective, sessions, now, today, onToggle, onFocus, onRemove }) {
  const spent = actualMs(objective, sessions, now);
  const v = verdict(estimateRatio(objective.estimateMs, spent));
  const picked = isToday(objective, today);

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
  project, objectives, sessions, now, today, words, onAdd, onToggle, onFocus, onRemove,
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
          <Row key={o.id} objective={o} sessions={sessions} now={now} today={today}
               onToggle={onToggle} onFocus={onFocus} onRemove={onRemove} />
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
              {/* Linking is what lets the row report time spent. Without a task
                  there is nothing to measure it against, so the field is only
                  offered once the project actually has tasks. */}
              {tasks.length > 0 && (
                <label className="field">
                  <span className="eyebrow">Track under</span>
                  <select className="inp" value={form.taskId} onChange={set("taskId")}>
                    <option value="">Not timed</option>
                    {tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </label>
              )}
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
