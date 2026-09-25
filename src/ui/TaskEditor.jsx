import { wordsFor } from "./words.js";
import { useState } from "react";
import { formatMoney } from "../domain/money.js";
import { taskRateInput } from "../domain/tasks.js";

/**
 * Rename, reprice or remove one task. The rate field is deliberately optional:
 * empty means "value each session at the rate it recorded", which is the
 * default and the honest one until you know what you're actually being paid.
 */
export default function TaskEditor({
  task, currency, projectRate, projectPrice = null, sessionCount,
  onSave, onDelete, onCancel, words = wordsFor(false),
}) {
  const [label, setLabel] = useState(task.label);
  // Shown back as it was meant, so "30%" does not reappear as 4.92 and turn a
  // rule into a number the next time anyone opens this.
  const [rate, setRate] = useState(taskRateInput(task));
  const [price, setPrice] = useState(task.price == null ? "" : String(task.price));
  const [confirming, setConfirming] = useState(false);
  const piece = projectPrice !== null;

  const save = () => onSave({
    label: label.trim() || task.label,
    rate: rate.trim() === "" ? null : rate,
    price: price.trim() === "" ? null : price,
  });

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
      {piece && (
        <label className="field">
          <span className="eyebrow">Per accepted item ({currency})</span>
          <input className="inp" type="number" min="0" step="any" value={price}
                 placeholder={`empty = ${formatMoney(Math.round(projectPrice * 100), currency)}, the project&apos;s price`}
                 onChange={(e) => setPrice(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && save()} />
        </label>
      )}
      <label className="field">
        <span className="eyebrow">Rate for this task ({currency})</span>
        <input className="inp" value={rate}
               placeholder={`empty = as recorded (${formatMoney(Math.round(projectRate * 100), currency)}/hr now) · or 30%`}
               onChange={(e) => setRate(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && save()} />
      </label>
      <div className="hint" style={{ marginBottom: 0 }}>
        Setting a rate reprices every session filed under this task, including ones already
        finished. Useful when the rate you&apos;re actually paid is settled after the work.
        The recorded hours never change. A percentage — <strong>30%</strong> — stays a
        percentage, so it keeps following the base rate instead of going stale when it moves.
        Leave a box empty to use the project&apos;s figure; type <strong>0</strong> to say this
        task pays nothing, which is a different answer.
      </div>
      <div className="controls">
        <button className="btn primary" onClick={save}>Save</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
        <button className="btn danger" onClick={() => setConfirming(true)}>Delete</button>
      </div>
    </div>
  );
}
