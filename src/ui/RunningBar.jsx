import { elapsedMs } from "../domain/time.js";
import { earningsCents, formatDuration, formatMoney } from "../domain/money.js";
import { rateFor, taskLabel } from "../domain/tasks.js";
import { isOffClock } from "../domain/projects.js";
import { isIdle } from "../domain/sessions.js";
import { isPieceOnly } from "../domain/earnings.js";

/**
 * What is running, from wherever you are.
 *
 * Until now the only way to see a live meter was to be standing on its
 * project, which meant the Overview could show a day's earnings while saying
 * nothing about the session adding to them as you read it.
 *
 * It renders nothing at all when nothing is running. A strip that is always
 * there, saying "not tracking", is furniture — and this one sits above every
 * screen in the app, so it has to earn the row it occupies.
 */
export default function RunningBar({ project, session, now, onOpen, onStop }) {
  if (!project || !session) return null;

  const ms = elapsedMs(session, now);
  const idling = isIdle(session);
  const off = isOffClock(project);
  // Money is the point of the strip on billed work, and a lie on the rest:
  // idle time is not earnings, off-clock work has none, and piece-rate work
  // does not know what it made until an item is accepted.
  const showMoney = !idling && !off && !isPieceOnly(project);

  return (
    <div className={"runbar" + (idling ? " idling" : "")}>
      <span className="runbar-dot" aria-hidden="true" />
      <button className="runbar-what" onClick={() => onOpen(project.id)}>
        <span className="runbar-name">{project.name}</span>
        {session.taskId && (
          <span className="runbar-task">{taskLabel(project, session.taskId)}</span>
        )}
      </button>
      <span className="runbar-time">{formatDuration(ms)}</span>
      {showMoney && (
        <span className="runbar-amt">
          {formatMoney(earningsCents(rateFor(project, session), ms), session.currency)}
        </span>
      )}
      {idling && <span className="runbar-tag">idle</span>}
      <button className="runbar-stop" onClick={onStop}>Stop</button>
    </div>
  );
}
