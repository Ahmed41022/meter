import { useState } from "react";
import { earningsCents, formatMoney, formatShortDuration } from "../domain/money.js";
import { KIND } from "../domain/sessions.js";
import { tasksFor } from "../domain/tasks.js";
import { takesTime } from "../domain/taskState.js";
import { closedTaskNote } from "./TaskPrompt.jsx";

const pad = (n) => String(n).padStart(2, "0");

/** datetime-local speaks local wall clock both ways; epoch integers stay the
 *  storage format either side of this boundary. */
const toInput = (epoch) => {
  const d = new Date(epoch);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromInput = (value) => {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
};

const when = (t) => new Date(t).toLocaleString(undefined, {
  weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});

/**
 * The records a typed-in window would count a second time, named so they can
 * be found, with the one box that says the overlap is meant.
 *
 * Shared by the two forms that write a window by hand — adding time and
 * correcting a session — because those are the only ways the same wall-clock
 * hour can come to be counted twice, and they should say so in the same words.
 */
export function Clashes({ clashes, confirmed, onConfirm, anyway }) {
  return (
    <div className="clash">
      <span className="eyebrow">Already accounted for</span>
      <p>
        This overlaps {clashes.length} record{clashes.length === 1 ? "" : "s"} you have
        already got. Two records over the same hour count it twice and inflate both the
        hours and the money.
      </p>
      <ul>
        {clashes.slice(0, 4).map((s) => (
          <li key={s.id}>
            {s.projectName ? `${s.projectName} · ` : ""}
            {s.taskName ? `${s.taskName} · ` : ""}
            {when(s.segments[0].startedAt)}
            {s.closedAt ? ` → ${when(s.closedAt)}` : " · still running"}
          </li>
        ))}
      </ul>
      <label className="clash-ok">
        <input type="checkbox" checked={confirmed}
               onChange={(e) => onConfirm(e.target.checked)} />
        {anyway}
      </label>
    </div>
  );
}

/**
 * Time you worked but didn't time.
 *
 * Two things make this more than a form. The preview shows the figure before
 * it is committed, because a block you type in goes straight into the money
 * with nothing having watched it. And it checks the window against every other
 * record: the meter physically cannot produce two overlapping sessions, so a
 * window typed in by hand — here, or in a correction — is the only way the
 * same wall-clock hour could be counted twice, and it is worth saying out loud
 * rather than silently accepting.
 */
export default function ManualSession({ project, offClock, now, findOverlaps, onSave, onCancel }) {
  const hourAgo = now - 3_600_000;
  const [from, setFrom] = useState(toInput(hourAgo));
  const [to, setTo] = useState(toInput(now));
  const [kind, setKind] = useState(KIND.BILLED);
  const [taskId, setTaskId] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  // Only work still being done. A task handed in takes no more hours, so
  // offering one here would record nothing while the form said it had.
  const tasks = tasksFor(project).filter(takesTime);
  // A task picked here and then handed in from the task list while this form
  // was still open. The form says so, rather than letting Add time go nowhere.
  const closed = taskId ? closedTaskNote(project, taskId) : null;
  const start = fromInput(from);
  const end = fromInput(to);
  const lo = start !== null && end !== null ? Math.min(start, end) : null;
  const hi = start !== null && end !== null ? Math.max(start, end) : null;
  const valid = lo !== null && hi !== null && hi > lo;

  const ms = valid ? hi - lo : 0;
  const clashes = valid ? findOverlaps({ startedAt: lo, endedAt: hi }) : [];
  const blocked = clashes.length > 0 && !confirmed;

  const rate = project.currentRate;
  const future = valid && hi > now;

  return (
    <div className="prompt">
      <span className="eyebrow">Add time you didn&apos;t track</span>

      <div className="pair" style={{ marginTop: 14 }}>
        <label className="field">
          <span className="eyebrow">Started</span>
          <input className="inp" type="datetime-local" value={from} autoFocus
                 onChange={(e) => { setFrom(e.target.value); setConfirmed(false); }} />
        </label>
        <label className="field">
          <span className="eyebrow">Ended</span>
          <input className="inp" type="datetime-local" value={to}
                 onChange={(e) => { setTo(e.target.value); setConfirmed(false); }} />
        </label>
      </div>

      {(tasks.length > 0 || closed || !offClock) && (
        <div className="pair">
          {(tasks.length > 0 || closed) && (
            <label className="field">
              <span className="eyebrow">{offClock ? "Activity" : "Task"}</span>
              <select className="inp" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                <option value="">{offClock ? "Unsorted" : "No task"}</option>
                {tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
          )}
          {/* Off the clock there is nothing to bill, so there is no billed
              against idle question to answer. */}
          {!offClock && (
            <label className="field">
              <span className="eyebrow">Counts as</span>
              <select className="inp" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value={KIND.BILLED}>Billable work</option>
                <option value={KIND.IDLE}>Idle time</option>
              </select>
            </label>
          )}
        </div>
      )}

      <div className="preview">
        <span className="eyebrow">Will record</span>
        <div className="preview-line">
          <span className="preview-now">
            {valid ? formatShortDuration(ms) : "—"}
            {valid && !offClock && kind === KIND.BILLED
              && ` · ${formatMoney(earningsCents(rate, ms), project.currency)}`}
          </span>
          {valid && !offClock && kind === KIND.BILLED && (
            <span className="preview-note">at {formatMoney(Math.round(rate * 100), project.currency)}/hr</span>
          )}
        </div>
      </div>

      {valid && !offClock && (
        <div className="hint" style={{ marginTop: 12 }}>
          It takes the rate the project charges now — there is no record of what it charged
          back then. If that work was priced differently, a task rate can still correct it.
        </div>
      )}

      {future && (
        <div className="hint" style={{ marginTop: 12 }}>
          That ends in the future. Allowed, but it will count as time already spent.
        </div>
      )}

      {closed && (
        <div className="hint warn" role="alert" style={{ marginTop: 12 }}>
          {closed} Choose another, or none.
        </div>
      )}

      {clashes.length > 0 && (
        <Clashes clashes={clashes} confirmed={confirmed} onConfirm={setConfirmed}
                 anyway="Add it anyway" />
      )}

      <div className="controls">
        <button className="btn primary" disabled={!valid || blocked || !!closed}
                onClick={() => onSave({ startedAt: lo, endedAt: hi, kind, taskId: taskId || null })}>
          Add time
        </button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
