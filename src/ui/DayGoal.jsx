import { useState } from "react";
import { dayGoalState, isDayGoal } from "../domain/dayGoal.js";
import { currenciesByValue } from "../domain/performance.js";
import { formatMoney } from "../domain/money.js";
import { hoursText, readHours } from "../domain/minimum.js";
import { useCurrency } from "./CurrencyContext.jsx";
import { CURRENCIES } from "./NewProject.jsx";
import { GoalBar, goalFormatter } from "./parts.jsx";
import { rateDay } from "./fxMoney.js";

const MINUTE = 60_000;
/** A money target as typed, a decimal comma included, or NaN. */
const readMoney = (text) => Number(String(text).trim().replace(",", "."));

/** The goal's boxes, seeded each time they open. Saving an empty target takes
 *  the goal off, which is also what Remove is for. */
function Form({ goal, currencies, fallback, onSave, onCancel }) {
  const [type, setType] = useState(goal?.type ?? "time");
  const [hours, setHours] = useState(goal?.type === "time" ? hoursText(goal.target * MINUTE) : "");
  const [amount, setAmount] = useState(goal?.type === "money" ? String(goal.target) : "");
  const [currency, setCurrency] = useState(goal?.currency ?? fallback);
  const next = type === "time"
    ? { type, target: (readHours(hours) ?? NaN) / MINUTE }
    : { type, target: amount.trim() ? readMoney(amount) : NaN, currency };
  const ok = isDayGoal(next);
  const save = () => ok && onSave(next);
  const onKey = (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") onCancel();
  };
  return (
    <div className="daygoal-form">
      <div className="modes" role="tablist" aria-label="What the daily goal measures">
        {[["time", "Time worked"], ["money", "Money earned"]].map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={type === key}
                  className={"seg-btn" + (type === key ? " on" : "")} onClick={() => setType(key)}>
            {label}
          </button>
        ))}
      </div>
      {type === "time" ? (
        <label className="field">
          <span className="eyebrow">Hours a day</span>
          <input className="inp" inputMode="decimal" autoFocus value={hours} placeholder="6"
                 onChange={(e) => setHours(e.target.value)} onKeyDown={onKey} />
        </label>
      ) : (
        <div className="pair">
          <label className="field">
            <span className="eyebrow">Amount a day</span>
            <input className="inp" inputMode="decimal" autoFocus value={amount} placeholder="200"
                   onChange={(e) => setAmount(e.target.value)} onKeyDown={onKey} />
          </label>
          <label className="field">
            <span className="eyebrow">Currency</span>
            <select className="inp" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
      )}
      <div className="hint">
        Counts every work project together, money still waiting on an answer included. Idle time
        and life activities don&apos;t count.
      </div>
      <div className="controls">
        <button className="btn primary" disabled={!ok} onClick={save}>Save goal</button>
        {goal && <button className="btn ghost" onClick={() => onSave(null)}>Remove goal</button>}
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * The goal for a day's work as a whole, at the head of Today: how far along
 * the day is, what is left, and the boxes to set it. `totals` is the day's own
 * `performanceIn`, the figures the heading below it prints, so the two cannot
 * disagree about what was worked.
 */
export default function DayGoal({ goal, totals, onSave }) {
  const [editing, setEditing] = useState(false);
  const { choice, fxOn, rates, favourites } = useCurrency();
  const fallback = choice === "earned" ? favourites[0] ?? "USD" : choice;
  const state = dayGoalState(goal, totals, { fxOn, rates });
  const show = goal ? goalFormatter(goal.type, goal.currency) : null;
  const uncounted = state ? currenciesByValue(state.uncounted) : [];

  if (!state && !editing) {
    return (
      <div className="sec">
        <div className="sec-head"><span className="eyebrow">Daily goal</span></div>
        <div className="panel">
          <button className="linkish obj-add first" onClick={() => setEditing(true)}>+ Set a daily goal</button>
        </div>
      </div>
    );
  }
  return (
    <div className="sec">
      <div className="sec-head">
        <span className="eyebrow">Daily goal</span>
        {!editing && <button className="linkbtn" onClick={() => setEditing(true)}>Change</button>}
      </div>
      <div className="panel daygoal">
        {editing ? (
          <Form goal={isDayGoal(goal) ? goal : null} fallback={fallback}
                currencies={[...new Set([goal?.currency, fallback, ...favourites, ...CURRENCIES].filter(Boolean))]}
                onSave={(g) => { onSave(g); setEditing(false); }} onCancel={() => setEditing(false)} />
        ) : (
          <>
            <GoalBar label={goal.type === "time" ? "Time worked today" : "Earned today"}
                     type={goal.type} target={state.target} value={state.value} currency={goal.currency} />
            <div className={"goal-pace " + (state.met ? "met" : "even")}>
              {state.met ? (state.over > 0 ? `Met · ${show(state.over)} over` : "Met") : `${show(state.toGo)} to go`}
              {state.approx && ` · estimated at ${rateDay(state.date)} rates`}
              {uncounted.length > 0
                && ` · not counting ${uncounted.map(([c, cents]) => formatMoney(cents, c)).join(" and ")}, which needs live rates`}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
