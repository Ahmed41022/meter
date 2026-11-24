import { elapsedMs } from "../domain/time.js";
import { formatDuration, formatMoney, formatShortDuration } from "../domain/money.js";
import { rateFor, taskLabel } from "../domain/tasks.js";
import { isOffClock } from "../domain/projects.js";
import { isIdle, sessionCents } from "../domain/sessions.js";
import { isPieceOnly } from "../domain/earnings.js";
import { countdownMs, hoursText, minimumOf } from "../domain/minimum.js";

/**
 * What is running, from wherever you are.
 *
 * Until now the only way to see a live meter was to be standing on its
 * project, which meant the Overview could show a day's earnings while saying
 * nothing about the session adding to them as you read it.
 *
 * One strip per meter. Where several run at once the main one comes first, and
 * work running behind it says it is working in the background.
 *
 * It renders nothing at all when nothing is running. A strip that is always
 * there, saying "not tracking", is furniture — and this one sits above every
 * screen in the app, so it has to earn the row it occupies.
 */
export default function RunningBar({
  project, session, now, elsewhere = false, runningOn = null, onOpen, onStop,
  background = false, several = false, onMakeMain = null, sessions = [],
  price = (s) => rateFor(project, s),
}) {
  if (!project || !session) return null;

  const ms = elapsedMs(session, now);
  const idling = isIdle(session);
  // A task with a minimum counts down to it, over every sitting it has had;
  // once there, the strip goes back to how long this sitting is.
  const least = minimumOf(project, session, sessions, now);
  const toGo = least !== null && least.leftMs > 0;
  const off = isOffClock(project);
  // Money is the point of the strip on billed work, and a lie on the rest:
  // idle time is not earnings, off-clock work has none, and piece-rate work
  // does not know what it made until an item is accepted.
  const showMoney = !idling && !off && !isPieceOnly(project);
  // A task held to a time limit says how much of it is left at full pay, and
  // once it is past it, what the time now pays.
  const terms = showMoney ? price.terms?.(session) : null;
  // The words in `more` go on a phone, where the strip has no room for them.
  const more = (text) => <span className="runbar-limit-more">{text}</span>;
  const limitTag = terms?.at == null ? null
    : terms.at > now ? <>{formatShortDuration(terms.at - now)} left{more(" at full pay")}</>
      : <>over{more(" the limit")} · {Math.round(terms.factor * 100)}%</>;

  return (
    <div className={"runbar" + (idling ? " idling" : "") + (background ? " behind" : "")
      + (several || least ? " tall" : "")}>
      <span className="runbar-dot" aria-hidden="true" />
      <button className="runbar-what" onClick={() => onOpen(project.id)}>
        <span className="runbar-name">{project.name}</span>
        {session.taskId && (
          <span className="runbar-task">{taskLabel(project, session.taskId)}</span>
        )}
      </button>
      <span className="runbar-time"
            title={least ? `${formatDuration(ms)} this session, ${formatDuration(least.doneMs)} of ${hoursText(least.ms)}h on the task` : undefined}>
        {formatDuration(toGo ? countdownMs(least.leftMs) : ms)}
      </span>
      {least && (
        <span className="runbar-limit">
          {toGo ? <>to go{more(` of ${hoursText(least.ms)}h`)}</> : <>{hoursText(least.ms)}h min met</>}
        </span>
      )}
      {showMoney && (
        <span className="runbar-amt">
          {formatMoney(sessionCents(session, -Infinity, Infinity, now, price), session.currency)}
        </span>
      )}
      {limitTag && (
        <span className={"runbar-limit" + (terms.at > now ? "" : " over")}>{limitTag}</span>
      )}
      {idling && <span className="runbar-tag">idle</span>}
      {/* A task whose clock ticks beside the one being worked. */}
      {background && (
        <span className="runbar-tag quiet" title="Working in background">
          {more("Working in ")}background
        </span>
      )}
      {/* Said out loud, because the strip is otherwise indistinguishable from
          a meter running here, and Stop reaches across either way. Named when
          that device has said so lately (Meter Sync's presence), which also
          says it is still there; otherwise only that it is another one. */}
      {elsewhere && (
        <span className="runbar-tag" title={runningOn ? `Started on ${runningOn}` : "Started on another device"}>
          {runningOn ? `on ${runningOn}` : "on another device"}
        </span>
      )}
      {onMakeMain && (
        <button className="linkish runbar-main" onClick={onMakeMain}>Make main</button>
      )}
      <button className="runbar-stop" onClick={onStop}>Stop</button>
    </div>
  );
}
