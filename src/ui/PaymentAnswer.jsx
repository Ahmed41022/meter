import { useState } from "react";
import { formatMoney } from "../domain/money.js";

/** A payday is a date on the client's clock, "2026-10-07", and is printed as
 *  exactly that date. Read through UTC, which no device is ever off by: read
 *  through this device's clock, a Wednesday in Kolkata came out as Tuesday in
 *  Cairo. */
export const payDay = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
  timeZone: "UTC", weekday: "short", day: "numeric", month: "long",
});

const CHOICES = {
  paid: "Paid in full",
  partial: "Not yet / partly",
  cancelled: "Cancelled",
};

/** Typed money to cents, or null for anything that is not a sum of money. */
const toCents = (text) => {
  if (String(text).trim() === "") return null;
  const n = Math.round(Number(text) * 100);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * What happened to one payment, asked in the one way wherever it is asked: the
 * notice that appears once a payday has passed, and an opened row of Upcoming
 * payments.
 *
 *   Paid in full   the amount that came, prefilled with what is owed. Typing a
 *                  different one is how $101 against $100 is recorded; the
 *                  difference goes into the earnings as an adjustment.
 *   Not yet/partly what has come so far, and the day the rest is expected.
 *   Cancelled      says the money comes off the earnings, and asks no more.
 *
 * `dismissLabel` names the way out: Later on the notice, which comes back
 * tomorrow, Cancel where the form was opened by hand. `choices` narrows it: a future payment can only be marked paid. The form
 * only collects; what is saved, and the Undo, are the caller's.
 */
export default function PaymentAnswer({ row, clock, choices, start = null, dismissLabel = "Cancel", onSave, onCancel }) {
  const [choice, setChoice] = useState(start ?? (choices.length === 1 ? choices[0] : null));
  const [amount, setAmount] = useState(String(row.cents / 100));
  const [soFar, setSoFar] = useState("0");
  const [date, setDate] = useState(clock.next ?? "");
  const owed = row.cents;
  const money = (c) => formatMoney(c, row.currency);

  if (choice === null) {
    return (
      <div className="payact">
        {choices.map((c) => (
          <button key={c} className="btn ghost" onClick={() => setChoice(c)}>{CHOICES[c]}</button>
        ))}
        {onCancel && <button className="btn ghost" onClick={onCancel}>{dismissLabel}</button>}
      </div>
    );
  }

  const got = toCents(choice === "paid" ? amount : soFar);
  let problem = null;
  let fields = null;
  if (choice === "paid") {
    if (got === null || got === 0) problem = "Type what came.";
    else fields = { outcome: "paid", receivedNow: got };
  } else if (choice === "partial") {
    if (got === null) problem = "Type what has come so far, or 0.";
    else if (got >= owed) problem = `That is all of it: choose Paid in full instead.`;
    else if (!date || date < (clock.today ?? "")) problem = "Pick today or a later day.";
    else fields = { outcome: "partial", receivedNow: got, movedTo: date };
  } else {
    fields = { outcome: "cancelled" };
  }

  return (
    <div className="payform">
      {choices.length > 1 && (
        <div className="payact">
          {choices.map((c) => (
            <button key={c} className={"btn " + (c === choice ? "primary" : "ghost")}
                    aria-pressed={c === choice} onClick={() => setChoice(c)}>
              {CHOICES[c]}
            </button>
          ))}
        </div>
      )}
      {choice === "paid" && (
        <label className="field">
          <span className="eyebrow">Received ({row.currency})</span>
          <input className="inp" type="number" step="any" min="0" value={amount}
                 onChange={(e) => setAmount(e.target.value)} />
          {got !== null && got > 0 && got !== owed && (
            <span className="hint">
              That is {money(Math.abs(got - owed))} {got > owed ? "more" : "less"} than the{" "}
              {money(owed)} expected. The difference goes into your earnings as an adjustment.
            </span>
          )}
        </label>
      )}
      {choice === "partial" && (
        <>
          <label className="field">
            <span className="eyebrow">Received so far ({row.currency})</span>
            <input className="inp" type="number" step="any" min="0" value={soFar}
                   onChange={(e) => setSoFar(e.target.value)} />
          </label>
          <label className="field">
            <span className="eyebrow">The rest is expected on</span>
            <input className="inp" type="date" aria-label="New payday" min={clock.today ?? undefined}
                   value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </>
      )}
      {choice === "cancelled" && (
        <p className="hint" style={{ marginTop: 0 }}>
          This payment is not coming. The {money(owed)} comes off your earnings; the hours stay.
        </p>
      )}
      {problem && <span className="hint warn" role="alert">{problem}</span>}
      <div className="payact">
        <button className="btn primary" disabled={fields === null} onClick={() => onSave(fields)}>Save</button>
        {onCancel && <button className="btn ghost" onClick={onCancel}>{dismissLabel}</button>}
      </div>
    </div>
  );
}
