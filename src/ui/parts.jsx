import { elapsedMs, lastActivityAt, startedAt } from "../domain/time.js";
import { earningsCents, formatMoney, formatShortDuration } from "../domain/money.js";
import { goalProgress, isGoalMet } from "../domain/goals.js";

const time = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const date = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export function GoalBar({ label, type, target, value, currency }) {
  const pct = goalProgress(value, target) * 100;
  const show = (v) =>
    type === "money" ? formatMoney(Math.round(v * 100), currency) : formatShortDuration(v * 60000);
  return (
    <div className="goal">
      <div className="goal-top">
        <span className="eyebrow">{label}</span>
        <span className="goal-val">{show(value)} / {show(target)}</span>
      </div>
      <div className="bar">
        <div className={"bar-fill" + (isGoalMet(value, target) ? " done" : "")}
             style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * Shown when a session was left running past its last heartbeat. The numbers
 * are spelled out because the whole point is letting the user see what the
 * phantom hours would have cost before choosing.
 */
export function RecoveryBanner({ session, project, onStopAtLastTick, onKeepRunning, onDelete, now }) {
  const last = lastActivityAt(session);
  const trimmed = {
    ...session,
    segments: session.segments.map((s) => (s.endedAt == null ? { ...s, endedAt: last } : s)),
  };
  const gapMs = elapsedMs(session, now);
  const keptMs = elapsedMs(trimmed, last);
  return (
    <div className="banner">
      <span className="eyebrow">Meter left running</span>
      <p>
        <strong>{project?.name || "A project"}</strong> started at {time(startedAt(session))} and
        last ticked at {time(last)} on {date(last)}. Counting the whole gap bills{" "}
        {formatMoney(earningsCents(session, gapMs), session.currency)} for {formatShortDuration(gapMs)};
        stopping at the last tick bills{" "}
        {formatMoney(earningsCents(trimmed, keptMs), session.currency)} for {formatShortDuration(keptMs)}.
      </p>
      <div className="controls">
        <button className="btn primary" onClick={onStopAtLastTick}>Stop at {time(last)}</button>
        <button className="btn ghost" onClick={onKeepRunning}>Keep counting</button>
        <button className="btn danger" onClick={onDelete}>Delete it</button>
      </div>
    </div>
  );
}

export function Notice({ title, children }) {
  return (
    <div className="banner">
      <span className="eyebrow">{title}</span>
      <p>{children}</p>
    </div>
  );
}

export function Toast({ message, action, onAction }) {
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      {action && <button className="linkbtn" onClick={onAction}>{action}</button>}
    </div>
  );
}
