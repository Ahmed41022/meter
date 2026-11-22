import { useState } from "react";
import { formatMoney } from "../../domain/money.js";
import { KIND_WORD } from "../Earnings.jsx";

/** A line's words, as the panel has always printed them: the kind first and
 *  the task after, "Bonus · batch 4417", or a shared reward and its count. */
export const lineText = (t) => (t.kind === "reward" ? `${t.label} · ${t.covers} tasks`
  : `${t.part === "hours" ? "Hours" : KIND_WORD[t.part] ?? "Other"}${
    t.kind === "extra"
      ? [t.label, t.taskLabel].filter(Boolean).map((x) => ` · ${x}`).join("")
      : ` · ${t.label}`}`);

/** One line's name as the panel prints it, and the project it is on. Shared
 *  with the read-only history, so a line reads the same wherever it is shown. */
export function LineName({ t }) {
  return (
    <span className="payline-name">
      {/* A task's money is a line for each kind of it, so the kind leads
          and the task follows: "Bonus · batch 4417". A shared reward
          says how many tasks it covers, because that is what tells it
          from a task. */}
      {t.kind === "reward" ? lineText(t) : (
        <>
          <span className="payline-kind">
            {t.part === "hours" ? "Hours" : KIND_WORD[t.part] ?? "Other"}
          </span>
          {t.kind === "extra"
            ? [t.label, t.taskLabel].filter(Boolean).map((x) => ` · ${x}`).join("")
            : ` · ${t.label}`}
        </>
      )}
      <span className="payline-of"> · {t.project}</span>
    </span>
  );
}

/**
 * The lines behind one opened payday, each of which can be picked, and what
 * can be done with those picked: marked paid, or moved to another day. A
 * client can pay three tasks of a payday and hold the fourth back, and this is
 * where that is said, line by line, while the payment as a whole is answered
 * below as before.
 *
 * Not on a payment already partly received: its figure is the rest of what was
 * expected on the day it was answered, not the sum of its lines, and taking a
 * line out of it would leave that figure saying something it no longer means.
 *
 * Which lines are picked lives here, and is forgotten when the row closes.
 * `onMarkLines` answers false when it refused, and the choice then stays.
 */
export default function PayLines({ row, clock, onMarkLines }) {
  const [picked, setPicked] = useState([]);
  const [moveTo, setMoveTo] = useState(null);
  const canPick = !row.partial && Boolean(onMarkLines);
  // Kept to the lines still on the row: it is worked out again every minute.
  const chosen = row.tasks.filter((t) => picked.includes(t.key));
  const toggle = (key) => setPicked((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  const done = () => { setPicked([]); setMoveTo(null); };
  const sum = chosen.reduce((total, t) => total + t.cents, 0);
  const from = clock.today;
  const ok = moveTo !== null && moveTo !== "" && moveTo >= from;

  return (
    <>
      {row.tasks.map((t) => (
        <div className="payline" key={t.key}>
          {canPick && (
            <input type="checkbox" className="row-check" checked={picked.includes(t.key)}
                   aria-label={`Select ${lineText(t)}`} onChange={() => toggle(t.key)} />
          )}
          <LineName t={t} />
          <span className="payline-amt">{formatMoney(t.cents, row.currency)}</span>
        </div>
      ))}
      {row.partial && (
        <p className="hint" style={{ margin: "6px 0 0" }}>
          Part of this payment has come, so it is answered as a whole.
        </p>
      )}
      {canPick && chosen.length > 0 && (
        <div className="payact" role="group" aria-label="Selected lines">
          <span className="selbar-count">
            {chosen.length} selected · {formatMoney(sum, row.currency)}
          </span>
          {moveTo === null ? (
            <>
              <button className="btn primary"
                      onClick={() => { if (onMarkLines(row, chosen, { received: true }) !== false) done(); }}>
                Mark paid
              </button>
              <button className="btn ghost" onClick={() => setMoveTo(clock.next ?? from)}>
                Move…
              </button>
              <button className="btn ghost" onClick={done}>Clear</button>
            </>
          ) : (
            <>
              <input className="inp" type="date" aria-label="Move selected to" min={from}
                     value={moveTo} onChange={(e) => setMoveTo(e.target.value)} />
              <button className="btn primary" disabled={!ok}
                      onClick={() => { if (onMarkLines(row, chosen, { payday: moveTo }) !== false) done(); }}>
                Move
              </button>
              <button className="btn ghost" onClick={() => setMoveTo(null)}>Cancel</button>
              {!ok && <span className="hint warn" role="alert">Pick today or a later day.</span>}
            </>
          )}
        </div>
      )}
    </>
  );
}
