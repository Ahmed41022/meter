import { elapsedMs, lastActivityAt, startedAt } from "../domain/time.js";
import { earningsCents, formatMoney, formatShortDuration } from "../domain/money.js";
import { goalProgress, isGoalMet, paceState } from "../domain/goals.js";
import { rateFor } from "../domain/tasks.js";

const time = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const date = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

const daysLeftWords = (n) => (n === 1 ? "last day" : `${n} days left`);

/**
 * The pacing sentence. `show` is the caller's formatter, so the same wording
 * serves a money goal and a time one without knowing which it has.
 *
 * Always in the goal's own unit and never a bare percentage: "$180 behind"
 * is something you can act on, "86% of pace" is a figure you then have to do
 * arithmetic on to use. The required daily rate is included whenever the target
 * is still open, because early in a period it is the only figure that carries
 * any information — the drift cannot yet.
 */
const paceWords = (state, p, show) => {
  if (state === "met") return p.over > 0 ? `Met · ${show(p.over)} over` : "Met";
  if (state === "missed") return `Ended ${show(p.remaining)} short`;
  const standing = state === "behind" ? `${show(-p.drift)} behind`
    : state === "ahead" ? `${show(p.drift)} ahead`
    : "On pace";
  return `${standing} · ${daysLeftWords(p.daysLeft)} · needs ${show(p.needPerDay)}/day`;
};

/** A goal's own unit. Money targets are held in currency units and time
 *  targets in minutes, and only the goal knows which it is. */
export const goalFormatter = (type, currency) => (v) =>
  type === "money" ? formatMoney(Math.round(v * 100), currency) : formatShortDuration(v * 60000);

/**
 * The bar, the pace mark and the sentence — everything about a goal except
 * what it is called.
 *
 * Split out from `GoalBar` so the project page and the Overview render one
 * pacing visual between them rather than two that could drift apart. The
 * headings differ; the reading does not.
 */
export function GoalMeter({ type, target, value, currency, pace }) {
  const pct = goalProgress(value, target) * 100;
  const show = goalFormatter(type, currency);
  const state = paceState(pace);
  /** Where the finished days say the fill should have reached. Drawn on the bar
   *  so the standing is legible before the sentence is read — the fill either
   *  reaches the mark or falls short of it. Hidden when it would sit on either
   *  end of the bar and mean nothing: nothing is owed on day one, and a period
   *  that is over is judged by its outcome, not its pace. */
  const markAt = pace && !pace.closed && !pace.met && pace.daysDone > 0
    ? Math.min(100, (pace.expected / target) * 100)
    : null;
  return (
    <>
      <div className="bar">
        <div className={"bar-fill" + (isGoalMet(value, target) ? " done" : "")}
             style={{ width: `${pct}%` }} />
        {markAt !== null && (
          <span className="bar-mark" style={{ left: `${markAt}%` }}
                title={`On pace, ${pace.daysDone} ${pace.daysDone === 1 ? "day" : "days"} in, would be ${show(pace.expected)}`} />
        )}
      </div>
      {state && <div className={`goal-pace ${state}`}>{paceWords(state, pace, show)}</div>}
    </>
  );
}

export function GoalBar({ label, type, target, value, currency, pace }) {
  const show = goalFormatter(type, currency);
  return (
    <div className="goal">
      <div className="goal-top">
        <span className="eyebrow">{label}</span>
        <span className="goal-val">{show(value)} / {show(target)}</span>
      </div>
      <GoalMeter type={type} target={target} value={value} currency={currency} pace={pace} />
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
        {formatMoney(earningsCents(rateFor(project, session), gapMs), session.currency)} for {formatShortDuration(gapMs)};
        stopping at the last tick bills{" "}
        {formatMoney(earningsCents(rateFor(project, trimmed), keptMs), session.currency)} for {formatShortDuration(keptMs)}.
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
