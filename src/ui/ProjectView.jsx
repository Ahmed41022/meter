import { useEffect, useRef, useState } from "react";
import { elapsedMs, isRunning } from "../domain/time.js";
import { acceptsTime, isDone, isOffClock } from "../domain/projects.js";
import { wordsFor } from "./words.js";
import { periodBoundary } from "../domain/goals.js";
import { goalValue } from "../domain/performance.js";
import { isCancelled, isPerTask, isPieceOnly } from "../domain/earnings.js";
import { isIdle, sessionCents, utilisation } from "../domain/sessions.js";
import { pricer } from "../domain/terms.js";
import { ORDER, findTask, taskTotals } from "../domain/tasks.js";
import { minimumFor } from "../domain/minimum.js";
import TaskList from "./project/TaskList.jsx";
import Ledger from "./project/Ledger.jsx";
import ProjectFace from "./project/ProjectFace.jsx";
import ClosingSummary from "./project/ClosingSummary.jsx";
import Goals from "./project/Goals.jsx";
import TimeAtDesk from "./project/TimeAtDesk.jsx";
import SettingsSection from "./project/SettingsSection.jsx";
import Objectives from "./Objectives.jsx";
import Earnings from "./Earnings.jsx";

export default function ProjectView({
  project, sessions, idleSessions, current, now,
  onStart, onPause, onResume, onStop, onSettle, onDeleteSession, onPatch, onDeleteProject,
  onSetTerms, onSetOwnLimit, onSetOwnMinimum,
  onAssign, onSaveTask, onDeleteTask, onCorrect, onRevertCorrection,
  projects = [], onSetStatus,
  earnings = [], onAddEarning, onRemoveEarning, onSetPayState, onSetPayStateMany,
  onSetEarningTasks, onSubmitTasks, onAnswerTasks, onReopenTasks, onRewardTasks,
  payPeriod = null, companies = [], onSetPayPeriod, onOpenSettings,
  defaultEarningsSort = "newest", defaultSessionsSort = "newest",
  objectives = [], today, onAddObjective, onToggleObjective, onFocusObjective,
  onRemoveObjective, onEditObjective,
  findOverlaps, onAddManual, focusSession = null,
  meter = null, openMeters = [], onShowMeter, onMakeMain, takenTasks, takenByOthers,
}) {
  const [prompt, setPrompt] = useState(null);         // {kind} | {reassign: session id}
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
   * has stopped, or another of the project's meters is being shown, there is
   * nothing left to re-file, and a prompt left open would keep the Start
   * buttons hidden behind a Save with no session to save to.
   */
  useEffect(() => {
    if (prompt?.reassign && prompt.reassign !== current?.id) setPrompt(null);
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
  // The same total per currency, for showing in the display currency. A
  // project whose sessions were not all in one currency used to print their
  // sum as if it were in the project's.
  const totalFigures = (() => {
    const acc = {};
    sessions.forEach((s) => { acc[s.currency] = (acc[s.currency] || 0) + moneyOf(s); });
    const kept = Object.fromEntries(Object.entries(acc).filter(([, c]) => c !== 0));
    return Object.keys(kept).length ? kept : { [project.currency]: 0 };
  })();
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

  const rawTaskRows = taskTotals(project, [...sessions, ...idleSessions], now, price)
    // What each still has to come to, where it has a minimum.
    .map((r) => ({ ...r, minMs: minimumFor(project, findTask(project, r.taskId)) }));
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

  return (
    <>
      <ProjectFace
        project={project} current={current} running={running} idling={idling}
        stopped={stopped} offClock={offClock} piece={piece} settles={settles} w={w}
        currency={currency} shownMs={shownMs} whole={whole} sessions={sessions}
        idleSessions={idleSessions} prompt={prompt} setPrompt={setPrompt} settling={settling}
        setSettling={setSettling} onStart={onStart} onPause={onPause} onResume={onResume}
        onStop={onStop} onSettle={onSettle} onAssign={onAssign} onSetStatus={onSetStatus}
        meter={meter} openMeters={openMeters} onShowMeter={onShowMeter} onMakeMain={onMakeMain}
        takenTasks={takenTasks} takenByOthers={takenByOthers} now={now}
      />

      {/* What it came to. A finished project is no longer a thing to pace, so
          the goal reads as an outcome and the panel reports the whole run
          rather than this week's slice of it. */}
      {isDone(project) && (
        <ClosingSummary
          sessions={sessions} idleSessions={idleSessions} offClock={offClock}
          currency={currency} totalCents={totalCents} totalFigures={totalFigures}
          totalMs={totalMs} idleMs={idleMs}
          share={share} overallGoal={overallGoal} overallValue={overallValue}
        />
      )}

      {!isDone(project) && (sessionGoal || overallGoal) && (
        <Goals
          project={project} sessionGoal={sessionGoal} overallGoal={overallGoal}
          currency={currency} current={current} whole={whole} shownMs={shownMs}
          overallValue={overallValue} now={now}
        />
      )}

      {!offClock && (
        <Earnings project={project} earnings={earnings} now={now}
                  onAdd={onAddEarning} onRemove={onRemoveEarning}
                  onSetTasks={onSetEarningTasks} payPeriod={payPeriod}
                  onSetPayState={onSetPayState} defaultSort={defaultEarningsSort} />
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
          onDeleteTask={onDeleteTask} onSetOwnLimit={onSetOwnLimit}
          onSetOwnMinimum={onSetOwnMinimum} onSubmitTasks={onSubmitTasks}
          onAnswerTasks={onAnswerTasks} onReopenTasks={onReopenTasks}
          onRewardTasks={onRewardTasks} onSetPayStateMany={onSetPayStateMany}
        />
      )}

      {share !== null && idleMs > 0 && !offClock && (
        <TimeAtDesk project={project} share={share} totalMs={totalMs} idleMs={idleMs}
                    idleCents={idleCents} />
      )}

      <Ledger defaultSort={defaultSessionsSort}
        project={project} sessions={sessions} idleSessions={idleSessions} now={now} price={price}
        whole={whole} totalFigures={totalFigures} totalMs={totalMs}
        currency={currency}
        offClock={offClock} piece={piece} settles={settles} stopped={stopped} w={w}
        earnings={earnings} findOverlaps={findOverlaps} focusSession={focusSession}
        focusRow={focusRow} ledgerOpen={ledgerOpen} setLedgerOpen={setLedgerOpen}
        filterTask={filterTask} setFilterTask={setFilterTask} selected={selected}
        setSelected={setSelected} setEditingTask={setEditingTask} setSettling={setSettling}
        onSetPayStateMany={onSetPayStateMany} onAssign={onAssign} onCorrect={onCorrect}
        onRevertCorrection={onRevertCorrection} onDeleteSession={onDeleteSession}
        onAddManual={onAddManual}
      />

      <SettingsSection
        project={project} projects={projects} onPatch={onPatch} onSetTerms={onSetTerms}
        onDeleteProject={onDeleteProject} onSetStatus={onSetStatus} payPeriod={payPeriod}
        companies={companies} onSetPayPeriod={onSetPayPeriod} now={now}
        running={openMeters.some((m) => isRunning(m.session))}
        onOpenSettings={onOpenSettings}
      />
    </>
  );
}
