import { useState } from "react";
import { formatMoney } from "../domain/money.js";
import { findTask } from "../domain/tasks.js";
import { priceFor } from "../domain/earnings.js";

/**
 * Marking a batch of tasks off in one go.
 *
 * Acceptance does not arrive one task at a time. A platform reviews a week of
 * submissions and approves them together, and a payout covers everything
 * approved that month — so recording it a row at a time is not merely slow,
 * it is the wrong shape, and past thirty or forty tasks it is the reason the
 * ledger stops being kept at all.
 *
 * Two different things can be recorded here, and they are not variants of each
 * other:
 *
 *  - ACCEPTED, one line per task, each at that task's own price. This is the
 *    "$80 an hour and $10 more when it lands" case, where every task earns its
 *    own money and only the approval happened in a batch.
 *  - ONE REWARD for the whole selection, a single line naming every task in
 *    it. This is "finish fifty and we pay you X", where there is one payment
 *    and splitting it fifty ways would invent a price nobody quoted.
 *
 * Both file as pending, because approval and payment are different days.
 */
export default function TaskSettle({
  project, taskIds, owedIds, allIds, onAccept, onReward, onPay, onSelectAll, onClear,
}) {
  const [rewarding, setRewarding] = useState(false);
  const [form, setForm] = useState({ amount: "", note: "" });

  const currency = project.currency;
  const priceOf = (id) => priceFor(project, findTask(project, id));
  // A task with no price records nothing, so it is counted out of the button
  // rather than silently included in a total it will not contribute to.
  const priced = taskIds.filter((id) => priceOf(id) !== null);
  const unpriced = taskIds.length - priced.length;
  const acceptCents = priced.reduce((sum, id) => sum + Math.round(priceOf(id) * 100), 0);

  const cents = Math.round(Number(form.amount) * 100);
  const validReward = Number.isFinite(cents) && cents !== 0;

  const record = () => {
    if (!validReward) return;
    onReward({ cents, note: form.note });
    setForm({ amount: "", note: "" });
    setRewarding(false);
  };

  return (
    <>
      <div className="selbar">
        <span className="selbar-count">
          {taskIds.length} selected
          {acceptCents > 0 && ` · ${formatMoney(acceptCents, currency)}`}
        </span>
        <button className="btn primary" disabled={priced.length === 0}
                onClick={() => onAccept(priced)}>
          Accept {priced.length}
        </button>
        <button className="btn ghost" onClick={() => setRewarding((v) => !v)}>
          {rewarding ? "Cancel reward" : "One reward"}
        </button>
        {owedIds.length > 0 && (
          <button className="btn ghost" onClick={onPay}>Mark {owedIds.length} paid</button>
        )}
        {taskIds.length < allIds.length && (
          <button className="btn ghost" onClick={onSelectAll}>All {allIds.length}</button>
        )}
        <button className="btn ghost" onClick={onClear}>Clear</button>
      </div>

      {unpriced > 0 && (
        <p className="hint" style={{ marginTop: -4, marginBottom: 12 }}>
          {unpriced} of the {taskIds.length} selected {unpriced === 1 ? "has" : "have"} no
          price set, so Accept would record nothing for {unpriced === 1 ? "it" : "them"}.
          Price {unpriced === 1 ? "it" : "them"} first, or cover the whole selection with one
          reward.
        </p>
      )}

      {rewarding && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <p className="hint" style={{ marginTop: 0 }}>
            One payment covering all {taskIds.length}. Each one will read as paid for
            without being given a share of it — the money was never quoted per task.
          </p>
          <div className="pair">
            <label className="field">
              <span className="eyebrow">Amount ({currency})</span>
              <input className="inp" type="number" step="any" autoFocus value={form.amount}
                     onChange={(e) => setForm({ ...form, amount: e.target.value })}
                     onKeyDown={(e) => { if (e.key === "Enter") record(); }} />
            </label>
            <label className="field">
              <span className="eyebrow">Note</span>
              <input className="inp" placeholder="50-task milestone" value={form.note}
                     onChange={(e) => setForm({ ...form, note: e.target.value })}
                     onKeyDown={(e) => { if (e.key === "Enter") record(); }} />
            </label>
          </div>
          <div className="controls">
            <button className="btn primary" disabled={!validReward} onClick={record}>
              Record for {taskIds.length} task{taskIds.length === 1 ? "" : "s"}
            </button>
            <button className="btn ghost" onClick={() => setRewarding(false)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}
