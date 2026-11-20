import { useState } from "react";
import { formatMoney } from "../domain/money.js";
import { findTask, tasksFor } from "../domain/tasks.js";
import {
  EARNING, PAY, isCancelled, isPending, isPieceOnly, perTask, perTaskCents, priceFor,
  tasksOf,
} from "../domain/earnings.js";
import { nextPaydays } from "../domain/payPeriod.js";
import {
  EARNINGS_ORDERS, currenciesOf, groupOrder, opensDescending, orderByMoney, orderByNumber,
} from "../domain/order.js";
import SortBar from "./SortBar.jsx";

/** The value a "no task" option carries. A select cannot hold null, and ""
 *  is indistinguishable from an unset control. */
const NONE = "__none__";

const KINDS = [
  [EARNING.PIECE, "Per accepted item"],
  [EARNING.BONUS, "Bonus"],
  [EARNING.ADJUSTMENT, "Adjustment"],
];
/** What each kind of earning is called, here and on the Overview's paydays. */
export const KIND_WORD = Object.fromEntries(KINDS);

const day = (t) => new Date(t).toLocaleDateString(undefined, {
  day: "numeric", month: "short", year: "numeric",
});
/** A payday, "2026-11-18", as the client's calendar names it: read through UTC
 *  so this device's zone cannot move it a day. */
const payDay = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
  timeZone: "UTC", weekday: "short", day: "numeric", month: "short",
});
/** How many paydays after the default are offered as "Another payday". */
const OTHER_PAYDAYS = 6;
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
export default function Earnings({
  project, earnings, now, onAdd, onRemove, onSetPayState, onSetTasks, payPeriod = null,
  defaultSort = "newest",
}) {
  const [adding, setAdding] = useState(false);
  // Which row is having its task changed. One at a time: a select on every
  // row would turn a list you read into a form you have to be careful in.
  const [filing, setFiling] = useState(null);
  const blank = (kind) => ({
    amount: "", kind, at: toInput(now), units: "", taskId: NONE, note: "",
    // Where the money lands: "next" leaves the payday to the schedule, "paid"
    // says it already has, "other" is the date in `payday`.
    when: "next", payday: "",
  });
  const [form, setForm] = useState(() => blank(EARNING.PIECE));
  const tasks = tasksFor(project);
  /** What one accepted item is worth under whatever task is picked, or null
   *  where there is no such price and a count means nothing on its own. */
  const chosen = form.taskId === NONE ? null : findTask(project, form.taskId);
  const each = priceFor(project, chosen);

  // A pick on the bar, or null to follow the synced default; lasts until the
  // page is left.
  const [picked, setPicked] = useState(null);
  const sort = picked ?? { key: defaultSort, desc: opensDescending(defaultSort) };
  /**
   * Newest by date, or by amount. Amount is grouped by currency, the
   * project's own first (every other one by code), and inside a group it is
   * SIGNED: the biggest money in comes first and a deduction comes last,
   * which is the reading of "biggest first" that puts the largest payment at
   * the top and the largest loss at the bottom. Pending and cancelled lines
   * stay where they are and are ranked by their amount like the rest.
   */
  const figures = (e) => ({ [e.currency]: e.cents });
  const rows = sort.key === "amount"
    ? orderByMoney(earnings, figures, {
      desc: sort.desc,
      groups: groupOrder(currenciesOf(earnings, figures), { [project.currency]: 1 }),
    })
    : orderByNumber(earnings, (e) => e.at, sort.desc);
  const settled = rows.filter((e) => !isPending(e) && !isCancelled(e))
    .reduce((a, e) => a + e.cents, 0);
  const pending = rows.filter(isPending).reduce((a, e) => a + e.cents, 0);

  const amount = Math.round(Number(form.amount) * 100);
  // Midday, so a date typed in cannot land on the wrong side of a day
  // boundary in a zone where local midnight does not exist.
  const at = new Date(`${form.at}T12:00`).getTime();
  /**
   * Money with no day counts in no period at all: the week reads short by
   * exactly that amount, and a spreadsheet dates it 1970. A date box cleared
   * by accident is the usual way there, so Add waits for a day.
   */
  const dated = Number.isFinite(at);
  const valid = Number.isFinite(amount) && amount !== 0 && dated;

  /*
   * The paydays on offer, real dates and nothing vaguer: the one the schedule
   * gives money added on this day, then the six after it. Only where the
   * company has a schedule — without one there is nothing to date, and the
   * money counts in the earnings the moment it is added.
   */
  const paydays = dated && payPeriod ? nextPaydays(payPeriod, at, OTHER_PAYDAYS + 1) : [];
  // Money with no task already has the first of them as its default. Money
  // tied to a task rides the TASK's payday by default, which is not that one,
  // so for it every date is a real alternative, the first included.
  const others = form.taskId === NONE ? paydays.slice(1) : paydays;
  // Re-derived from the day typed, so a date changed after picking one cannot
  // leave a payday that is no longer offered.
  const other = others.find((p) => p.date === form.payday) ?? others[0] ?? null;

  const submit = () => {
    if (!valid) return;
    const units = Number(form.units);
    onAdd({
      cents: amount,
      kind: form.kind,
      at,
      units: Number.isFinite(units) && units > 0 ? units : null,
      taskIds: form.taskId === NONE ? [] : [form.taskId],
      note: form.note,
      // Only a payday somebody picked is written. The default stays absent so
      // it follows the schedule.
      ...(paydays.length && form.when === "other" && other ? { payday: other.date } : {}),
      ...(paydays.length && form.when === "paid" ? { received: true } : {}),
    });
    setForm(blank(form.kind));
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
      {rows.length > 1 && (
        <SortBar label="Order the earnings by" orders={EARNINGS_ORDERS} order={sort.key}
                 desc={sort.desc} opensDesc={opensDescending}
                 onChange={(key, desc) => setPicked({ key, desc })} />
      )}
      <div className="panel">
        {rows.length === 0 && !adding && (
          <div className="empty">
            Nothing yet. Add what this project paid that no timer watched — an amount per
            accepted item, a bonus, an adjustment.
          </div>
        )}

        {rows.map((e) => {
          const ids = tasksOf(e);
          /* The name is the point. Without it every row here is an amount and
             a date, which is exactly as much as a bank statement tells you —
             and the question being asked of this list is "which task has been
             paid for", which an amount cannot answer. */
          const named = ids.length > 1
            ? `${ids.length} tasks`
            : ids.length === 1 ? (findTask(project, ids[0])?.label ?? "deleted task") : null;
          return (
          <div className={`ern${isCancelled(e) ? " cancelled" : ""}`} key={e.id}>
            <span className="ern-main">
              <span className="ern-amt">{formatMoney(e.cents, e.currency)}</span>
              <span className="ern-meta">
                {day(e.at)}
                {" · "}
                {/* A batch is never re-filed from here. Offering a single
                    picker over fifty tasks would quietly discard forty-nine. */}
                {onSetTasks && tasks.length > 0 && ids.length <= 1 ? (
                  <button className={"linkish" + (named ? "" : " faintish")}
                          onClick={() => setFiling(filing === e.id ? null : e.id)}>
                    {named ?? "no task"}
                  </button>
                ) : (named ?? "no task")}
                {" · "}{KIND_WORD[e.kind] ?? e.kind}
                {e.units ? ` · ${e.units} × ${formatMoney(Math.round(e.cents / e.units), e.currency)}` : ""}
                {e.note ? ` · ${e.note}` : ""}
              </span>
              {filing === e.id && (
                <select className="inp mini" autoFocus value={ids[0] ?? NONE}
                        aria-label="Which task this is for"
                        onChange={(ev) => {
                          onSetTasks(e.id, ev.target.value === NONE ? [] : [ev.target.value]);
                          setFiling(null);
                        }}>
                  <option value={NONE}>No task</option>
                  {tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
              )}
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
          );
        })}

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
                {!dated && (
                  <span className="hint warn" role="alert" style={{ marginTop: 8, display: "block" }}>
                    Pick the day it was earned. Without one it counts in no week or month.
                  </span>
                )}
              </label>
              <label className="field">
                <span className="eyebrow">How many items</span>
                <input className="inp" type="number" min="0" step="1"
                       placeholder={each === null ? "optional" : "6"}
                       value={form.units}
                       onChange={(e) => {
                         const units = e.target.value;
                         // Where there is a price per item, a count IS the
                         // amount, so typing one fills it in. Editing the
                         // amount afterwards stands: a capped or part-paid batch
                         // is exactly the case you would want to overrule.
                         const priced = perTaskCents(project, units, chosen);
                         setForm((f) => ({
                           ...f, units,
                           amount: priced === null ? f.amount : String(priced / 100),
                         }));
                       }} />
              </label>
            </div>
            {tasks.length > 0 && (
              <label className="field">
                <span className="eyebrow">Which task</span>
                <select className="inp" value={form.taskId}
                        onChange={(e) => {
                          const taskId = e.target.value;
                          // Re-price against the task just picked, so choosing
                          // the task after typing the count does not leave an
                          // amount computed from the wrong one.
                          const task = taskId === NONE ? null : findTask(project, taskId);
                          const priced = perTaskCents(project, form.units, task);
                          setForm((f) => ({
                            ...f, taskId,
                            amount: priced === null ? f.amount : String(priced / 100),
                          }));
                        }}>
                  <option value={NONE}>
                    {perTask(project) === null ? "No task" : "No task · the project's price"}
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
            )}
            {paydays.length > 0 && (
              <div className="field">
                <span className="eyebrow">When is it paid?</span>
                <select className="inp" aria-label="When is it paid?" value={form.when}
                        onChange={(e) => setForm({ ...form, when: e.target.value })}>
                  <option value="next">
                    {form.taskId === NONE ? `Next payday — ${payDay(paydays[0].date)}`
                      : "With its task's payday"}
                  </option>
                  <option value="paid">Already paid</option>
                  {others.length > 0 && <option value="other">Another payday</option>}
                </select>
                {form.when === "other" && other && (
                  <select className="inp" style={{ marginTop: 8 }} aria-label="Which payday"
                          value={other.date}
                          onChange={(e) => setForm({ ...form, payday: e.target.value })}>
                    {others.map((p) => <option key={p.date} value={p.date}>{payDay(p.date)}</option>)}
                  </select>
                )}
              </div>
            )}
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
