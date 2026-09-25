import { useState } from "react";
import { formatMoney } from "../domain/money.js";
import { tasksFor } from "../domain/tasks.js";
import { perTask, priceFor } from "../domain/earnings.js";

/**
 * What a stretch of tracked time actually produced.
 *
 * Piece-rate work is not paid for the sitting, it is paid for what the sitting
 * produced — and those are different prices for different things. One session
 * can yield an accepted task at one price and an accepted changelist at
 * another, or just the changelist, so this asks for a list rather than a
 * number.
 *
 * It files what you claim, not what you have been given: each line starts
 * PENDING, because acceptance happens days later and recording it as money in
 * hand would make a month look paid when it is only submitted.
 */
const NONE = "__none__";

const blank = (taskId) => ({ key: Math.random().toString(36).slice(2), taskId, units: "1" });

export default function SettlePrompt({ project, session, onConfirm, onCancel }) {
  const tasks = tasksFor(project);
  const [rows, setRows] = useState([blank(session?.taskId ?? NONE)]);

  const taskFor = (id) => (id === NONE ? null : tasks.find((t) => t.id === id) ?? null);
  const priceOf = (id) => priceFor(project, taskFor(id));
  const centsOf = (row) => {
    const each = priceOf(row.taskId);
    const n = Number(row.units);
    if (each === null || !Number.isFinite(n) || n <= 0) return 0;
    return Math.round(each * 100 * n);
  };

  const total = rows.reduce((sum, r) => sum + centsOf(r), 0);
  const patch = (key, change) =>
    setRows(rows.map((r) => (r.key === key ? { ...r, ...change } : r)));

  const confirm = () => onConfirm(
    rows
      .map((r) => ({ taskId: r.taskId === NONE ? null : r.taskId, units: Number(r.units), cents: centsOf(r) }))
      .filter((r) => r.cents > 0)
  );

  return (
    <div className="prompt">
      <span className="eyebrow">What did this earn?</span>
      <p className="hint" style={{ marginTop: 10 }}>
        Filed as pending until you mark it paid. Nothing here changes the hours.
      </p>

      {rows.map((row) => (
        <div className="settle-row" key={row.key}>
          <label className="field settle-what">
            <span className="eyebrow">For</span>
            <select className="inp" value={row.taskId}
                    onChange={(e) => patch(row.key, { taskId: e.target.value })}>
              <option value={NONE}>
                {perTask(project) === null
                  ? "No price set"
                  : `The project's price · ${formatMoney(Math.round(perTask(project) * 100), project.currency)}`}
              </option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                  {priceFor(project, t) !== null
                    && ` · ${formatMoney(Math.round(priceFor(project, t) * 100), project.currency)}`}
                </option>
              ))}
            </select>
          </label>
          <label className="field settle-many">
            <span className="eyebrow">How many</span>
            <input className="inp" type="number" min="0" step="1" value={row.units}
                   onChange={(e) => patch(row.key, { units: e.target.value })}
                   onKeyDown={(e) => {
                     if (e.key === "Enter") confirm();
                     if (e.key === "Escape") onCancel();
                   }} />
          </label>
          <span className="settle-sum">{formatMoney(centsOf(row), project.currency)}</span>
          {rows.length > 1 && (
            <button className="x" aria-label="Remove line"
                    onClick={() => setRows(rows.filter((r) => r.key !== row.key))}>×</button>
          )}
        </div>
      ))}

      {/* Both can be true at once: the task was accepted and so was the
          changelist, for the same sitting, at two different prices. */}
      <button className="linkish" onClick={() => setRows([...rows, blank(NONE)])}>
        Add another
      </button>

      <p className="settle-total">
        Total <strong>{formatMoney(total, project.currency)}</strong>
      </p>

      <div className="controls">
        <button className="btn primary" disabled={total === 0} onClick={confirm}>Record it</button>
        <button className="btn ghost" onClick={onCancel}>
          {session ? "Not yet" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
