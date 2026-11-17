import { useEffect, useRef, useState } from "react";
import { elapsedMs, isRunning, lastActivityAt, startedAt } from "../domain/time.js";
import {
  formatDuration, formatMoney, formatShortDuration, moneyParts,
} from "../domain/money.js";
import { acceptsTime, companyOf, isDone, isOffClock, isPaused } from "../domain/projects.js";
import { wordsFor } from "./words.js";
import { paceGoal, periodBoundary } from "../domain/goals.js";
import { effectiveRate, goalValue } from "../domain/performance.js";
import { isCancelled, isPerTask, isPieceOnly, priceFor } from "../domain/earnings.js";
import { isIdle, KIND, sessionCents, utilisation } from "../domain/sessions.js";
import { pricer } from "../domain/terms.js";
import { ORDER, findTask, rateFor, taskLabel, taskTotals } from "../domain/tasks.js";
import TaskPrompt from "./TaskPrompt.jsx";
import SettlePrompt from "./SettlePrompt.jsx";
import TaskList from "./project/TaskList.jsx";
import Ledger from "./project/Ledger.jsx";
import { date, time } from "./project/format.js";

import { GoalBar } from "./parts.jsx";
import { StatTile } from "./charts.jsx";
import Settings, { unsavedSettings } from "./Settings.jsx";
import Objectives from "./Objectives.jsx";
import Earnings from "./Earnings.jsx";

const MS_PER_HOUR = 3_600_000;

export default function ProjectView({
  project, sessions, idleSessions, current, now,
  onStart, onPause, onResume, onStop, onSettle, onDeleteSession, onPatch, onDeleteProject,
  onSetTerms, onSetOwnLimit,
  onAssign, onSaveTask, onDeleteTask, onCorrect, onRevertCorrection,
  projects = [], onSetStatus,
  earnings = [], onAddEarning, onRemoveEarning, onSetPayState, onSetPayStateMany,
  onSetEarningTasks, onSubmitTasks, onAnswerTasks, onReopenTasks, onRewardTasks,
  payPeriod = null, companies = [], onSetPayPeriod,
  objectives = [], today, onAddObjective, onToggleObjective, onFocusObjective,
  onRemoveObjective, onEditObjective,
  findOverlaps, onAddManual, focusSession = null,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prompt, setPrompt] = useState(null);         // {kind} | {reassign:true}
  // Which session is being asked "what did this earn?". Set when a piece-rate
  // meter stops, and settable again later from any row — acceptance lands days
  // after the work, so the answer often is not known at stop time.
  const [settling, setSettling] = useState(null);
  const [ledgerOpen, setLedgerOpen] = useState(null); // null = follow the default
  const [filterTask, setFilterTask] = useState(null); // UNASSIGNED, a taskId, or null
  const [selected, setSelected] = useState([]);       // session ids picked for re-filing
  const [pickedTasks, setPickedTasks] = useState([]); // task ids picked for settling
  // How the task list reads. Most-earned-first to begin with, as it always
  // was; the other orders answer questions that one cannot.
  const [order, setOrder] = useState(ORDER.PAY);
  const [orderDesc, setOrderDesc] = useState(true);
  const [editingTask, setEditingTask] = useState(null);
  const focusRow = useRef(null);

  /**
   * Sent here by a warning that named a session. The ledger collapses itself
   * once it is long, and a filter may be on — both of which would hide the
   * one row the reader was just promised.
   */
  useEffect(() => {
    if (!focusSession) return;
    setLedgerOpen(true);
    setFilterTask(null);
  }, [focusSession]);

  useEffect(() => {
    // Optional-called: `scrollIntoView` is missing in some environments —
    // jsdom has none — and bringing a row into view is not worth taking the
    // page down for. The highlight alone still finds it.
    if (focusSession) focusRow.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [focusSession]);

  /**
   * Re-filing the running session is a question about THAT session. Once it
   * has stopped there is nothing left to re-file, and a prompt left open would
   * keep the Start buttons hidden behind a Save with no session to save to.
   */
  useEffect(() => {
    if (prompt?.reassign && !current) setPrompt(null);
  }, [prompt, current]);
  const running = current && isRunning(current);
  const idling = current ? isIdle(current) : false;

  const shownMs = current ? elapsedMs(current, now) : 0;
  const currency = current?.currency ?? project.currency;
  const offClock = isOffClock(project);
  // Two different questions. `piece` decides what the money figures are
  // allowed to say, and a project paying ten an hour plus seventy on
  // acceptance is still hourly. `settles` decides whether accepted items can
  // be recorded at all, which that project certainly can.
  const piece = isPieceOnly(project);
  const settles = isPerTask(project);
  const w = wordsFor(offClock);
  // The rate each sitting is valued at, and a share of it for time over its
  // task's limit. Every money figure on the page asks this, so none of them
  // can disagree with the Overview about what a sitting came to.
  const price = pricer([project], [...sessions, ...idleSessions]);
  const whole = (s) => sessionCents(s, -Infinity, Infinity, now, price);
  const { head, tail } = moneyParts(current ? whole(current) : 0, currency);

  const minuteInHour = Math.floor((shownMs % MS_PER_HOUR) / 60_000);
  const hoursBilled = Math.floor(shownMs / MS_PER_HOUR);

  /**
   * What a sitting is worth here, which is nothing once it has been rejected.
   *
   * The hours are a separate question and keep their own totals: the work was
   * done, it simply was not paid for. Every money figure in the app draws the
   * same line, so a rejected batch reduces what you earned without pretending
   * you were not at the desk.
   */
  const moneyOf = (s) => (isCancelled(s) ? 0 : whole(s));

  const totalCents = sessions.reduce((a, s) => a + moneyOf(s), 0);
  const totalMs = sessions.reduce((a, s) => a + elapsedMs(s, now), 0);

  const idleMs = idleSessions.reduce((a, s) => a + elapsedMs(s, now), 0);
  const idleCents = idleSessions.reduce((a, s) => a + moneyOf(s), 0);
  const share = utilisation(totalMs, idleMs);

  // A goal saved as money before the project moved off the clock would render
  // a figure that can never move. Off the clock every goal reads as time.
  const asTime = (goal) => (goal && offClock ? { ...goal, type: "time" } : goal);
  const sessionGoal = asTime(project.sessionGoal);
  const overallGoal = asTime(project.overallGoal);
  /**
   * The goal counts the time that actually fell INSIDE its period, not every
   * session that happened to start there. A session running 23:30 Sunday to
   * 00:30 Monday belongs half to each week, and crediting it whole to the week
   * it began in is what used to make this figure disagree with the very same
   * week on the Overview, which derives everything by overlap. Lifetime has no
   * boundaries, so its window is everything.
   *
   * Asked of `goalValue`, the same question the Overview's Targets ask, so a
   * money goal counts what the headline counts: settled money, the clock's and
   * the money no clock measured alike.
   */
  const goalWindow = overallGoal && overallGoal.period !== "lifetime"
    ? { from: periodBoundary(overallGoal.period, now, 0), to: periodBoundary(overallGoal.period, now, 1) }
    : { from: 0, to: Infinity };
  const overallValue = overallGoal
    ? goalValue(overallGoal, project, sessions, earnings, goalWindow.from, goalWindow.to, now, price)
    : 0;

  const rawTaskRows = taskTotals(project, [...sessions, ...idleSessions], now, price);
  const hasTasks = rawTaskRows.some((r) => r.taskId);

  /**
   * Whether tasks here can be moved through their life, which is a different
   * question and a much broader one.
   *
   * Any task can be handed in, turned down or reopened, whatever the project
   * pays and however. Gating this on the money meant a project paid once
   * accepted but with no extra reward — the ordinary shape, an hourly rate
   * and a review — offered no way to submit or accept anything at all, and
   * that work on a flat hourly project could never be marked rejected.
   *
   * Off the clock is the exception: there is no money to settle or cancel
   * there, so the whole lifecycle would be ceremony.
   */
  const canSettle = !offClock && hasTasks;

  const stopped = !acceptsTime(project);
  /** A stopped project with nothing open has no meter to show: the money
   *  reads $0.00 for ever and the rail counts out an hour that will never
   *  start. What it came to is the panel below. */
  const bare = stopped && !current;
  const company = companyOf(project);
  /** The span the project actually ran, taken from the work rather than from
   *  when it was created or marked done — a project made in March and first
   *  worked in June ran from June. */
  const allSessions = [...sessions, ...idleSessions];
  const ranFrom = allSessions.length
    ? Math.min(...allSessions.map((s) => startedAt(s))) : null;
  const ranTo = allSessions.length
    ? Math.max(...allSessions.map((s) => s.closedAt ?? lastActivityAt(s) ?? startedAt(s))) : null;
  const closingRate = effectiveRate(totalCents, totalMs);
  const goalUnit = (v) => (overallGoal?.type === "money"
    ? formatMoney(Math.round(v * 100), currency) : formatShortDuration(v * 60_000));

  return (
    <>
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
            <span className={`state${running ? (idling ? " idling" : " on") : ""}`}>
              {running ? (idling ? "Idling" : "Running") : current ? "Paused" : "Stopped"}
            </span>
          )}
        </div>

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
          <button className="task-chip" onClick={() => setPrompt({ reassign: true })}>
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
            key={prompt.reassign ? `move:${current?.id}` : `start:${prompt.kind}`}
            project={project} words={w}
            initialTaskId={prompt.reassign ? current?.taskId : null}
            confirmLabel={
              prompt.reassign ? "Save" : prompt.kind === KIND.IDLE ? "Start idle" : w.start
            }
            onCancel={() => setPrompt(null)}
            onConfirm={(pick) => {
              if (prompt.reassign) onAssign([current.id], pick);
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

      {/* What it came to. A finished project is no longer a thing to pace, so
          the goal reads as an outcome and the panel reports the whole run
          rather than this week's slice of it. */}
      {isDone(project) && (
        <div className="sec">
          <div className="sec-head">
            <span className="eyebrow">What it came to</span>
            {ranFrom !== null && (
              <span className="eyebrow">
                {date(ranFrom)} – {date(ranTo)}{new Date(ranTo).getFullYear() !== new Date().getFullYear()
                  ? ` ${new Date(ranTo).getFullYear()}` : ""}
              </span>
            )}
          </div>
          <div className="panel">
            {allSessions.length === 0 ? (
              <div className="empty">No time was ever recorded against this one.</div>
            ) : (
              <div className="tiles closing">
                {!offClock && (
                  <StatTile label="Earned" value={formatMoney(totalCents, currency)} />
                )}
                <StatTile label={offClock ? "Tracked" : "Billed"}
                          value={formatShortDuration(totalMs)}
                          sub={idleMs > 0 ? `${formatShortDuration(idleMs)} idle` : null} />
                {!offClock && closingRate !== null && (
                  <StatTile label="An hour came to" value={`${formatMoney(closingRate, currency)}/hr`}
                            sub={share === null ? null : `${Math.round(share * 100)}% of desk time billed`} />
                )}
                {overallGoal && (
                  <StatTile label="Goal"
                            value={overallValue >= overallGoal.target ? "Met" : "Short"}
                            sub={`${goalUnit(overallValue)} of ${goalUnit(overallGoal.target)}`} />
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {!isDone(project) && (sessionGoal || overallGoal) && (
        <div className="sec">
          <div className="sec-head"><span className="eyebrow">Goals</span></div>
          <div className="panel">
            {sessionGoal && (
              <GoalBar label="This session" type={sessionGoal.type} target={sessionGoal.target}
                       currency={currency}
                       value={sessionGoal.type === "money"
                         ? (current ? whole(current) : 0) / 100
                         : shownMs / 60000} />
            )}
            {overallGoal && (
              <GoalBar
                label={overallGoal.period === "lifetime" ? "All time"
                     : overallGoal.period === "week" ? "This week" : "This month"}
                type={overallGoal.type} target={overallGoal.target} currency={project.currency}
                value={overallValue} pace={paceGoal(overallGoal, overallValue, now)} />
            )}
          </div>
        </div>
      )}

      {!offClock && (
        <Earnings project={project} earnings={earnings} now={now}
                  onAdd={onAddEarning} onRemove={onRemoveEarning}
                  onSetTasks={onSetEarningTasks} payPeriod={payPeriod}
                  onSetPayState={onSetPayState} />
      )}

      {/* On a finished project the list is a record, not a plan — shown when
          there is something to show, and with nothing new to add. */}
      {(!isDone(project) || objectives.some((o) => o.projectId === project.id)) && (
      <Objectives
        project={project} objectives={objectives} words={w} readOnly={isDone(project)}
        sessions={[...sessions, ...idleSessions]} now={now} today={today}
        onAdd={onAddObjective} onToggle={onToggleObjective}
        onFocus={onFocusObjective} onRemove={onRemoveObjective} onEdit={onEditObjective} />
      )}

      {hasTasks && (
        <TaskList
          project={project} sessions={sessions} idleSessions={idleSessions} now={now}
          earnings={earnings} w={w} offClock={offClock} piece={piece} settles={settles}
          canSettle={canSettle} rawTaskRows={rawTaskRows} order={order} setOrder={setOrder}
          orderDesc={orderDesc} setOrderDesc={setOrderDesc} pickedTasks={pickedTasks}
          setPickedTasks={setPickedTasks} editingTask={editingTask}
          setEditingTask={setEditingTask} filterTask={filterTask} setFilterTask={setFilterTask}
          setLedgerOpen={setLedgerOpen} setSelected={setSelected} onSaveTask={onSaveTask}
          onDeleteTask={onDeleteTask} onSetOwnLimit={onSetOwnLimit} onSubmitTasks={onSubmitTasks}
          onAnswerTasks={onAnswerTasks} onReopenTasks={onReopenTasks}
          onRewardTasks={onRewardTasks} onSetPayStateMany={onSetPayStateMany}
        />
      )}

      {share !== null && idleMs > 0 && !offClock && (
        <div className="sec">
          <div className="sec-head"><span className="eyebrow">Time at the desk</span></div>
          <div className="panel">
            <div className="util">
              <span className="eyebrow">Billed</span>
              <span className="util-pct">{Math.round(share * 100)}%</span>
            </div>
            <div className="split">
              <div className="split-billed" style={{ width: `${share * 100}%` }} />
              <div className="split-idle" style={{ width: `${(1 - share) * 100}%` }} />
            </div>
            <div className="split-legend">
              <span className="legend-item">
                <span className="swatch" style={{ background: "var(--jade)" }} />
                {formatShortDuration(totalMs)} billed
              </span>
              <span className="legend-item">
                <span className="swatch" style={{ background: "var(--amber)" }} />
                {formatShortDuration(idleMs)} idle ·{" "}
                {formatMoney(idleCents, project.currency)} unearned
              </span>
            </div>
          </div>
        </div>
      )}

      <Ledger
        project={project} sessions={sessions} idleSessions={idleSessions} now={now} price={price}
        whole={whole} totalCents={totalCents} totalMs={totalMs} currency={currency}
        offClock={offClock} piece={piece} settles={settles} stopped={stopped} w={w}
        earnings={earnings} findOverlaps={findOverlaps} focusSession={focusSession}
        focusRow={focusRow} ledgerOpen={ledgerOpen} setLedgerOpen={setLedgerOpen}
        filterTask={filterTask} setFilterTask={setFilterTask} selected={selected}
        setSelected={setSelected} setEditingTask={setEditingTask} setSettling={setSettling}
        onSetPayStateMany={onSetPayStateMany} onAssign={onAssign} onCorrect={onCorrect}
        onRevertCorrection={onRevertCorrection} onDeleteSession={onDeleteSession}
        onAddManual={onAddManual}
      />

      <div className="sec">
        <div className="sec-head">
          <span className="eyebrow">
            Settings
            {/* A draft outlives the closed panel, so the closed panel says it
                is holding one. Nothing else on the page would. */}
            {!settingsOpen && unsavedSettings(project.id) && <span className="tag">Unsaved</span>}
          </span>
          <button className="linkbtn" onClick={() => setSettingsOpen((v) => !v)}>
            {settingsOpen ? "Close" : "Open"}
          </button>
        </div>
        {settingsOpen && (
          <Settings project={project} projects={projects} onPatch={onPatch} onSetTerms={onSetTerms}
                    onDeleteProject={onDeleteProject} onSetStatus={onSetStatus}
                    payPeriod={payPeriod} companies={companies}
                    onSetPayPeriod={onSetPayPeriod} now={now}
                    hasRunningSession={!!running} />
        )}
      </div>
    </>
  );
}
