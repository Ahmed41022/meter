import { useState } from "react";
import { elapsedMs, startedAt } from "../domain/time.js";
import { earningsCents, formatMoney, formatShortDuration } from "../domain/money.js";
import { wasCorrected } from "../domain/sessions.js";
import { rateFor } from "../domain/tasks.js";
import { Clashes } from "./ManualSession.jsx";

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
export default function SessionEditor({
  session, project, findOverlaps = () => [], onSave, onRevert, onCancel,
}) {
  const recordedEnd = session.closedAt ?? startedAt(session);
  const [from, setFrom] = useState(toInput(startedAt(session)));
  const [to, setTo] = useState(toInput(recordedEnd));
  const [confirmed, setConfirmed] = useState(false);

  const start = fromInput(from);
  const end = fromInput(to);
  const readable = start !== null && end !== null;
  /**
   * An end at or before the start is a slip to point out, not one to repair.
   * Swapping the two quietly would turn a 09:00–11:00 session whose end was
   * moved to 08:00 into 08:00–09:00, an hour nobody worked and nobody asked
   * for. The domain still orders the pair whatever it is handed, as a net.
   */
  const backwards = readable && end <= start;
  const valid = readable && !backwards;

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

  /**
   * Other records the corrected time would lie across, asked of the blocks
   * it would actually record rather than of start to end, since a break kept
   * between them double-counts nothing. The session itself is left out: it
   * is the thing being moved. Anything else under it would be counted twice,
   * so it is named, and Save waits for the same "anyway" Add time asks for.
   */
  const clashes = [];
  for (const block of preview?.segments ?? []) {
    for (const other of findOverlaps(block)) {
      if (other.id !== session.id && !clashes.some((c) => c.id === other.id)) clashes.push(other);
    }
  }
  const blocked = clashes.length > 0 && !confirmed;

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
                 onChange={(e) => { setFrom(e.target.value); setConfirmed(false); }} />
        </label>
        <label className="field">
          <span className="eyebrow">Ended</span>
          <input className="inp" type="datetime-local" value={to}
                 onChange={(e) => { setTo(e.target.value); setConfirmed(false); }} />
        </label>
      </div>

      <div className="preview">
        <span className="eyebrow">Will record</span>
        <div className="preview-line">
          <span className="preview-now">
            {valid
              ? `${formatShortDuration(nowMs)} · ${formatMoney(earningsCents(rate, nowMs), session.currency)}`
              : "—"}
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

      {backwards && (
        <div className="hint warn" role="alert" style={{ marginTop: 14 }}>
          {end === start
            ? "It ends the minute it starts, so it would record nothing."
            : "It ends before it starts."}
          {" "}Put the end after the start to save it.
        </div>
      )}

      {clashes.length > 0 && (
        <Clashes clashes={clashes} confirmed={confirmed} onConfirm={setConfirmed}
                 anyway="Save it anyway" />
      )}

      <div className="hint" style={{ marginTop: 14 }}>
        {wasCorrected(session)
          ? "This was corrected before. What the meter originally recorded is still kept."
          : "What the meter recorded is kept, so this can always be put back."}
      </div>

      <div className="controls">
        <button className="btn primary" disabled={!valid || blocked}
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
