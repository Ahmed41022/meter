import { useState } from "react";
import { elapsedMs, startedAt } from "../domain/time.js";
import { earningsCents, formatMoney, formatShortDuration } from "../domain/money.js";
import { wasCorrected } from "../domain/sessions.js";
import { rateFor } from "../domain/tasks.js";

const pad = (n) => String(n).padStart(2, "0");

/** datetime-local wants local wall-clock, and parses it back as local. Epoch
 *  integers stay the storage format either side of this boundary. */
const toInput = (epoch) => {
  const d = new Date(epoch);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromInput = (value) => {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * Corrects a finished session. The preview is the safeguard: pauses are kept,
 * so the resulting duration is rarely just end minus start, and you should be
 * able to see the number you're about to commit before you commit it.
 */
export default function SessionEditor({ session, project, onSave, onRevert, onCancel }) {
  const recordedEnd = session.closedAt ?? startedAt(session);
  const [from, setFrom] = useState(toInput(startedAt(session)));
  const [to, setTo] = useState(toInput(recordedEnd));

  const start = fromInput(from);
  const end = fromInput(to);
  const valid = start !== null && end !== null;

  // Mirror the domain rule rather than assuming end - start.
  const preview = valid
    ? (() => {
        const lo = Math.min(start, end), hi = Math.max(start, end);
        const ordered = [...session.segments].sort((a, b) => a.startedAt - b.startedAt);
        const rebuilt = ordered
          .map((seg, i) => ({
            startedAt: i === 0 ? lo : Math.max(seg.startedAt, lo),
            endedAt: i === ordered.length - 1 ? hi : Math.min(seg.endedAt ?? hi, hi),
          }))
          .filter((seg) => seg.endedAt > seg.startedAt);
        return { segments: rebuilt.length ? rebuilt : [{ startedAt: lo, endedAt: hi }] };
      })()
    : null;

  const rate = rateFor(project, session);
  const nowMs = preview ? elapsedMs(preview, 0) : 0;
  const wasMs = elapsedMs(session, recordedEnd);

  return (
    <div className="prompt">
      <span className="eyebrow">Correct this session</span>

      <div className="pair" style={{ marginTop: 14 }}>
        <label className="field">
          <span className="eyebrow">Started</span>
          <input className="inp" type="datetime-local" value={from}
                 onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span className="eyebrow">Ended</span>
          <input className="inp" type="datetime-local" value={to}
                 onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      <div className="preview">
        <span className="eyebrow">Will record</span>
        <div className="preview-line">
          <span className="preview-now">
            {formatShortDuration(nowMs)} · {formatMoney(earningsCents(rate, nowMs), session.currency)}
          </span>
          <span className="preview-was">
            was {formatShortDuration(wasMs)} · {formatMoney(earningsCents(rate, wasMs), session.currency)}
          </span>
        </div>
        {session.segments.length > 1 && (
          <div className="hint" style={{ marginTop: 8, marginBottom: 0 }}>
            This session has {session.segments.length} blocks with breaks between them. The breaks
            stay unbilled, so the total won&apos;t equal end minus start.
          </div>
        )}
      </div>

      <div className="hint" style={{ marginTop: 14 }}>
        {wasCorrected(session)
          ? "This was corrected before. What the meter originally recorded is still kept."
          : "What the meter recorded is kept, so this can always be put back."}
      </div>

      <div className="controls">
        <button className="btn primary" disabled={!valid}
                onClick={() => onSave({ startedAt: start, endedAt: end })}>
          Save correction
        </button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
        {wasCorrected(session) && (
          <button className="btn danger" onClick={onRevert}>Undo correction</button>
        )}
      </div>
    </div>
  );
}
