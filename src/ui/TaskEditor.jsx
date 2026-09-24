import { wordsFor } from "./words.js";
import { useState } from "react";
import { formatMoney } from "../domain/money.js";

/**
 * Rename, reprice or remove one task. The rate field is deliberately optional:
 * empty means "value each session at the rate it recorded", which is the
 * default and the honest one until you know what you're actually being paid.
 */
export default function TaskEditor({ task, currency, projectRate, sessionCount, onSave, onDelete, onCancel, words = wordsFor(false) }) {
  const [label, setLabel] = useState(task.label);
  const [rate, setRate] = useState(task.rate == null ? "" : String(task.rate));
  const [confirming, setConfirming] = useState(false);

  const save = () => onSave({ label: label.trim() || task.label, rate: rate.trim() === "" ? null : rate });

  if (confirming) {
    return (
      <div className="prompt">
        <span className="eyebrow">Delete {task.label}?</span>
        <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
          {sessionCount === 0
            ? "Nothing is filed under it."
            : `${sessionCount} session${sessionCount === 1 ? "" : "s"} will move to “No task”. The hours and the
               time recorded stay exactly as they are — only the filing changes.`}
          {" "}You&apos;ll get one chance to undo.
        </p>
        <div className="controls">
          <button className="btn danger" onClick={onDelete}>Yes, delete it</button>
          <button className="btn ghost" onClick={() => setConfirming(false)}>Keep it</button>
        </div>
      </div>
    );
  }

  return (
    <div className="prompt">
      <span className="eyebrow">{words.editTask}</span>
      <label className="field">
        <span className="eyebrow">Name</span>
        <input className="inp" value={label} autoFocus onChange={(e) => setLabel(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && save()} />
      </label>
      <label className="field">
        <span className="eyebrow">Rate for this task ({currency})</span>
        <input className="inp" type="number" min="0" step="any" value={rate}
               placeholder={`empty = as recorded (${formatMoney(Math.round(projectRate * 100), currency)}/hr now)`}
               onChange={(e) => setRate(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && save()} />
      </label>
      <div className="hint" style={{ marginBottom: 0 }}>
        Setting a rate reprices every session filed under this task, including ones already
        finished. Useful when the rate you&apos;re actually paid is settled after the work.
        The recorded hours never change.
      </div>
      <div className="controls">
        <button className="btn primary" onClick={save}>Save</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
        <button className="btn danger" onClick={() => setConfirming(true)}>Delete</button>
      </div>
    </div>
  );
}
