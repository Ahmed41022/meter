import { useState } from "react";
import { formatMoney } from "../domain/money.js";
import {
  EARNING, PAY, isCancelled, isPending, isPieceOnly, perTask, perTaskCents,
} from "../domain/earnings.js";

const KINDS = [
  [EARNING.PIECE, "Per accepted item"],
  [EARNING.BONUS, "Bonus"],
  [EARNING.ADJUSTMENT, "Adjustment"],
];
const KIND_WORD = Object.fromEntries(KINDS);

const day = (t) => new Date(t).toLocaleDateString(undefined, {
  day: "numeric", month: "short", year: "numeric",
});
const pad = (n) => String(n).padStart(2, "0");
const toInput = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * Money this project earned that no clock measured.
 *
 * Deliberately its own panel rather than rows in the ledger. The ledger is a
 * record of time — every row there has a duration, a rate and a start, and it
 * is what the hours are derived from. A $3,000 payment for six accepted tasks
 * has none of those, and putting it in the same list would mean every reader of
 * the ledger has to remember that some rows do not mean what the columns say.
 */
export default function Earnings({ project, earnings, now, onAdd, onRemove, onSetPayState }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    amount: "", kind: EARNING.PIECE, at: toInput(now), units: "", note: "",
  });
  /** What one accepted item is worth here, or null where the project has no
   *  such price and a count means nothing on its own. */
  const each = perTask(project);

  const rows = [...earnings].sort((a, b) => b.at - a.at);
  const settled = rows.filter((e) => !isPending(e) && !isCancelled(e))
    .reduce((a, e) => a + e.cents, 0);
  const pending = rows.filter(isPending).reduce((a, e) => a + e.cents, 0);

  const amount = Math.round(Number(form.amount) * 100);
  const valid = Number.isFinite(amount) && amount !== 0;

  const submit = () => {
    if (!valid) return;
    const units = Number(form.units);
    onAdd({
      cents: amount,
      kind: form.kind,
      // Midday, so a date typed in cannot land on the wrong side of a day
      // boundary in a zone where local midnight does not exist.
      at: new Date(`${form.at}T12:00`).getTime(),
      units: Number.isFinite(units) && units > 0 ? units : null,
      note: form.note,
    });
    setForm({ amount: "", kind: form.kind, at: toInput(now), units: "", note: "" });
    setAdding(false);
  };

  return (
    <div className="sec">
      <div className="sec-head">
        {/* On a project paid per accepted item, ALL of the money arrives this
            way, so "earned without the clock" describes nothing and reads too
            close to the app's own "off the clock". */}
        <span className="eyebrow">{isPieceOnly(project) ? "Accepted work" : "Earned without the clock"}</span>
        <span className="eyebrow">
          {formatMoney(settled, project.currency)}
          {pending !== 0 && ` · ${formatMoney(pending, project.currency)} pending`}
        </span>
      </div>
      <div className="panel">
        {rows.length === 0 && !adding && (
          <div className="empty">
            Nothing yet. Add what this project paid that no timer watched — an amount per
            accepted item, a bonus, an adjustment.
          </div>
        )}

        {rows.map((e) => (
          <div className={`ern${isCancelled(e) ? " cancelled" : ""}`} key={e.id}>
            <span className="ern-main">
              <span className="ern-amt">{formatMoney(e.cents, e.currency)}</span>
              <span className="ern-meta">
                {day(e.at)} · {KIND_WORD[e.kind] ?? e.kind}
                {e.units ? ` · ${e.units} × ${formatMoney(Math.round(e.cents / e.units), e.currency)}` : ""}
                {e.note ? ` · ${e.note}` : ""}
              </span>
            </span>
            <span className="ern-actions">
              <select className="inp mini" value={isPending(e) ? PAY.PENDING : isCancelled(e) ? PAY.CANCELLED : PAY.PAID}
                      aria-label="Payment state"
                      onChange={(ev) => onSetPayState(e.id, ev.target.value)}>
                <option value={PAY.PAID}>Paid</option>
                <option value={PAY.PENDING}>Pending</option>
                <option value={PAY.CANCELLED}>Cancelled</option>
              </select>
              <button className="x" aria-label="Remove" onClick={() => onRemove(e.id)}>×</button>
            </span>
          </div>
        ))}

        {adding ? (
          <div className="ern-form">
            <div className="pair">
              <label className="field">
                <span className="eyebrow">Amount ({project.currency})</span>
                <input className="inp" type="number" step="any" autoFocus value={form.amount}
                       onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              </label>
              <label className="field">
                <span className="eyebrow">What for</span>
                <select className="inp" value={form.kind}
                        onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  {KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              </label>
            </div>
            <div className="pair">
              <label className="field">
                <span className="eyebrow">Date</span>
                <input className="inp" type="date" value={form.at}
                       onChange={(e) => setForm({ ...form, at: e.target.value })} />
              </label>
              <label className="field">
                <span className="eyebrow">How many items</span>
                <input className="inp" type="number" min="0" step="1"
                       placeholder={each === null ? "optional" : "6"}
                       value={form.units}
                       onChange={(e) => {
                         const units = e.target.value;
                         // Where the project has a price per item, a count IS
                         // the amount, so typing one fills it in. Editing the
                         // amount afterwards stands: a capped or part-paid batch
                         // is exactly the case you would want to overrule.
                         const priced = perTaskCents(project, units);
                         setForm((f) => ({
                           ...f, units,
                           amount: priced === null ? f.amount : String(priced / 100),
                         }));
                       }} />
              </label>
            </div>
            <label className="field">
              <span className="eyebrow">Note</span>
              <input className="inp" placeholder="optional" value={form.note}
                     onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </label>
            {valid && (
              <div className="hint" style={{ marginTop: 12, marginBottom: 0 }}>
                Adds {formatMoney(amount, project.currency)} to this project&apos;s earnings and
                nothing at all to its hours.
              </div>
            )}
            <div className="controls">
              <button className="btn primary" disabled={!valid} onClick={submit}>Add</button>
              <button className="btn ghost" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="linkish obj-add" onClick={() => setAdding(true)}>+ Add earnings</button>
        )}
      </div>
    </div>
  );
}
