import { elapsedMs, isRunning, startedAt } from "../../domain/time.js";
import { formatDuration, formatMoney, moneyParts } from "../../domain/money.js";
import { companyOf, isDone, isPaused } from "../../domain/projects.js";
import { allowsParallel } from "../../domain/concurrency.js";
import { priceFor } from "../../domain/earnings.js";
import { KIND } from "../../domain/sessions.js";
import { findTask, rateFor, taskLabel } from "../../domain/tasks.js";
import TaskPrompt from "../TaskPrompt.jsx";
import SettlePrompt from "../SettlePrompt.jsx";
import { time } from "./format.js";

const MS_PER_HOUR = 3_600_000;

/**
 * The meter itself: the project's name and rate, the running figures, the
 * minute rail, the prompts that hang off starting and stopping, and the
 * controls. Its two questions, which task a start is for and which session is
 * being asked what it earned, stay with the page, because the ledger also sets
 * one and an effect there clears the other.
 */
export default function ProjectFace({
  project, current, running, idling, stopped, offClock, piece, settles, w, currency,
  shownMs, whole, sessions, idleSessions, prompt, setPrompt, settling, setSettling,
  onStart, onPause, onResume, onStop, onSettle, onAssign, onSetStatus,
  meter = null, openMeters = [], onShowMeter, onMakeMain, takenTasks, takenByOthers, now,
}) {
  const { head, tail } = moneyParts(current ? whole(current) : 0, currency);

  const minuteInHour = Math.floor((shownMs % MS_PER_HOUR) / 60_000);
  const hoursBilled = Math.floor(shownMs / MS_PER_HOUR);

  /** A stopped project with nothing open has no meter to show: the money
   *  reads $0.00 for ever and the rail counts out an hour that will never
   *  start. What it came to is the panel below. */
  const bare = stopped && !current;
  const company = companyOf(project);
  const behind = Boolean(running && meter?.background);
  const stateWord = running
    ? (idling ? "Idling" : behind ? "Working in background" : "Running")
    : current ? "Paused" : "Stopped";

  return (
    <div className={"face" + (idling ? " idle" : "")}>
      <div className="face-top">
        <div>
          <div className="plate-name">
            {project.name}
            {isPaused(project) && <span className="tag">Paused</span>}
            {isDone(project) && <span className="tag">Done</span>}
          </div>
          {company && <div className="plate-for">{company}</div>}
          <div className="plate-rate">
            {offClock ? "off the clock · not counted as work" : piece ? <>
              {priceFor(project, current ? findTask(project, current.taskId) : null) !== null
                ? `${formatMoney(Math.round(priceFor(project, current ? findTask(project, current.taskId) : null) * 100), currency)} per accepted item`
                : "no price set"}
              {current?.taskId && findTask(project, current.taskId)?.price != null && " · task price"}
            </> : <>
              {formatMoney(Math.round((current ? rateFor(project, current) : project.currentRate) * 100), currency)} per hour
              {current && rateFor(project, current) !== current.rate && " · task rate"}
              {current && rateFor(project, current) === current.rate
                && current.rate !== project.currentRate && " · rate locked for this session"}
            </>}
          </div>
        </div>
        {!bare && (
          <span className={`state${running && !behind ? (idling ? " idling" : " on") : ""}`}>
            {stateWord}
          </span>
        )}
      </div>

      {/* Several tasks at once: which of them the figures below are about. */}
      {openMeters.length > 1 && (
        <div className="meters" role="group" aria-label="Open meters on this project">
          {openMeters.map(({ session: s, background }) => (
            <button key={s.id} type="button" aria-pressed={s.id === current?.id}
                    className={"meter-pick" + (s.id === current?.id ? " on" : "")}
                    onClick={() => onShowMeter(s.id)}>
              <span className="meter-pick-name">{s.taskId ? taskLabel(project, s.taskId) : w.noTask}</span>
              <span className="meter-pick-time">{formatDuration(elapsedMs(s, now))}</span>
              {!isRunning(s) ? <span className="tag">paused</span>
                : background && <span className="tag">in background</span>}
            </button>
          ))}
        </div>
      )}

      {/* An off-clock project has no earnings to show, and a huge 0.00 reads
          as a broken meter. The elapsed time is the figure that matters.
          Piece-rate work is the same case for a different reason: the money
          is not known until an item is accepted, and pretending otherwise
          would put a confident zero where the truth is "not yet". */}
      {!bare && <div className="money">
        {offClock || piece
          ? <span className="money-head">{formatDuration(shownMs)}</span>
          : <>
              <span className="money-head">{head}</span>
              {tail !== null && <span className="money-tail">{tail}</span>}
            </>}
      </div>}

      {idling && <div className="money-label">Not billed — idle time at this project&apos;s rate</div>}

      {current && (
        <button className="task-chip" onClick={() => setPrompt({ reassign: current.id })}>
          {w.taskCap} · {current.taskId ? taskLabel(project, current.taskId) : "none"} · change
        </button>
      )}

      {!bare && <div className="clock">
        {/* Where the headline figure is already this duration — off the
            clock, or paid per item — repeating it here prints the same
            number twice. */}
        {!offClock && !piece && <span className="clock-main">{formatDuration(shownMs)}</span>}
        <span className="clock-note">
          {current
            ? `started ${time(startedAt(current))}`
            : offClock ? "not tracking" : "meter is stopped"}
        </span>
      </div>}

      {/* Minute rail: one mark per minute of the current billable hour. It
          counts out an hour you are going to charge for — so off the clock,
          or paid per accepted item, there is no such hour to count. */}
      {!offClock && !piece && !bare && <>
      <div className="rail" aria-hidden="true">
        {Array.from({ length: 60 }, (_, i) => (
          <span key={i} className={
            "tick"
            + (i < minuteInHour ? " filled" : "")
            + (i === minuteInHour && running ? " head" : "")
            + (i % 15 === 0 && i >= minuteInHour ? " q" : "")
          } />
        ))}
      </div>
      <div className="rail-legend">
        <span className="eyebrow">
          {hoursBilled > 0
            ? `${hoursBilled} full hour${hoursBilled === 1 ? "" : "s"} billed`
            : "minutes into this hour"}
        </span>
        <span className="eyebrow">{minuteInHour}/60</span>
      </div>
      </>}

      {/* Every editor on this page is keyed by the thing it edits. A form
          seeds its boxes once, when it first appears, so the same instance
          handed a different session or task would go on showing the first
          one's values, and Save would write them onto the second. A new key
          is a new form, seeded from what it now edits. */}
      {settling && (
        <SettlePrompt
          key={settling}
          project={project}
          session={[...sessions, ...idleSessions].find((x) => x.id === settling) ?? null}
          onCancel={() => setSettling(null)}
          onConfirm={(lines) => { onSettle(settling, lines); setSettling(null); }}
        />
      )}

      {prompt && !settling && (
        <TaskPrompt
          key={prompt.reassign ? `move:${prompt.reassign}` : `start:${prompt.kind}`}
          project={project} words={w}
          taken={!allowsParallel(project) ? undefined : prompt.reassign ? takenByOthers : takenTasks}
          initialTaskId={prompt.reassign ? current?.taskId : null}
          confirmLabel={
            prompt.reassign ? "Save" : prompt.kind === KIND.IDLE ? "Start idle" : w.start
          }
          onCancel={() => setPrompt(null)}
          onConfirm={(pick) => {
            if (prompt.reassign) onAssign([prompt.reassign], pick);
            else onStart(prompt.kind, pick);
            setPrompt(null);
          }}
        />
      )}

      <div className="controls">
        {!current && !prompt && !stopped && (
          <>
            <button className="btn primary" onClick={() => setPrompt({ kind: KIND.BILLED })}>
              {w.start}
            </button>
            {/* Billed against idle is a question about what to invoice.
                Off the clock there is nothing to invoice, so the split would
                be a distinction without a difference. */}
            {!offClock && (
              <button className="btn ghost" onClick={() => setPrompt({ kind: KIND.IDLE })}>
                Start idle
              </button>
            )}
          </>
        )}
        {running && (
          <>
            <button className="btn ghost" onClick={onPause}>Pause</button>
            <button className="btn primary"
                    onClick={() => {
                      const id = current?.id ?? null;
                      onStop();
                      if (settles && id) setSettling(id);
                    }}>
              {idling ? "Stop idling" : w.stop}
            </button>
          </>
        )}
        {/* A project that allows parallel tasks can start another beside them. */}
        {current && !prompt && !stopped && allowsParallel(project) && (
          <button className="btn ghost" onClick={() => setPrompt({ kind: KIND.BILLED })}>
            Start another task
          </button>
        )}
        {meter?.canBeMain && (
          <button className="btn ghost" onClick={onMakeMain}>Make it the main task</button>
        )}
        {!current && !prompt && stopped && (
          <button className="btn primary" onClick={() => onSetStatus("active")}>
            {isDone(project) ? "Reopen this project" : "Set it running again"}
          </button>
        )}
        {/* Whatever is already open can always be finished — stopping a
            project refuses NEW time, it does not strand a session that was
            running when you stopped it. Only the new-session button goes. */}
        {current && !running && (
          <>
            <button className="btn primary" onClick={onResume}>Resume</button>
            {!stopped && (
              <button className="btn ghost"
                      onClick={() => onStart(idling ? KIND.IDLE : KIND.BILLED, { taskId: current.taskId })}>
                {offClock ? "New entry" : "New session"}
              </button>
            )}
          </>
        )}
      </div>

      {stopped && (
        <div className="hint" style={{ marginTop: 14, marginBottom: 0 }}>
          {isDone(project)
            ? "This project is done, so it won't take new time. Everything it recorded is still here."
            : "This project is on hold, so it won't take new time. Nothing it recorded has changed."}
        </div>
      )}

      {/* Switching kind is always explicit. Auto-starting the other timer
          would attribute time to the wrong bucket with no trace of why. */}
      {running && !offClock && (
        <div className="controls">
          <button className="btn ghost"
                  onClick={() => onStart(idling ? KIND.BILLED : KIND.IDLE, { taskId: current.taskId })}>
            {idling ? "Back to work" : "Switch to idle"}
          </button>
        </div>
      )}
    </div>
  );
}
