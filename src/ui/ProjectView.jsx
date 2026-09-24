import { useState } from "react";
import { elapsedMs, isOpen, isRunning, startedAt } from "../domain/time.js";
import {
  earningsCents, formatDuration, formatMoney, formatShortDuration, moneyParts,
} from "../domain/money.js";
import { isOffClock } from "../domain/projects.js";
import { wordsFor } from "./words.js";
import { periodStart } from "../domain/goals.js";
import { isIdle, KIND, utilisation, wasCorrected } from "../domain/sessions.js";
import {
  findTask, rateFor, sessionsUnderTask, taskLabel, taskTotals, UNASSIGNED,
} from "../domain/tasks.js";
import TaskPrompt from "./TaskPrompt.jsx";
import TaskBreakdown from "./TaskBreakdown.jsx";
import TaskEditor from "./TaskEditor.jsx";
import SessionEditor from "./SessionEditor.jsx";

/** Above this many rows the ledger is collapsed on arrival, so Settings and
 *  the per-task figures stay reachable without a long scroll. */
const LEDGER_AUTO_COLLAPSE = 5;
import { GoalBar } from "./parts.jsx";
import Settings from "./Settings.jsx";

const MS_PER_HOUR = 3_600_000;
const time = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const date = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export default function ProjectView({
  project, sessions, idleSessions, current, now,
  onStart, onPause, onResume, onStop, onDeleteSession, onPatch, onDeleteProject,
  onAssign, onSaveTask, onDeleteTask, onCorrect, onRevertCorrection,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prompt, setPrompt] = useState(null);         // {kind} | {reassign:true}
  const [ledgerOpen, setLedgerOpen] = useState(null); // null = follow the default
  const [filterTask, setFilterTask] = useState(null); // UNASSIGNED, a taskId, or null
  const [selected, setSelected] = useState([]);       // session ids picked for re-filing
  const [bulkPrompt, setBulkPrompt] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [editingSession, setEditingSession] = useState(null);
  const running = current && isRunning(current);
  const idling = current ? isIdle(current) : false;

  const shownMs = current ? elapsedMs(current, now) : 0;
  const currency = current?.currency ?? project.currency;
  const offClock = isOffClock(project);
  const w = wordsFor(offClock);
  const { head, tail } = moneyParts(current ? earningsCents(rateFor(project, current), shownMs) : 0, currency);

  const minuteInHour = Math.floor((shownMs % MS_PER_HOUR) / 60_000);
  const hoursBilled = Math.floor(shownMs / MS_PER_HOUR);

  const totalCents = sessions.reduce((a, s) => a + earningsCents(rateFor(project, s), elapsedMs(s, now)), 0);
  const totalMs = sessions.reduce((a, s) => a + elapsedMs(s, now), 0);

  const idleMs = idleSessions.reduce((a, s) => a + elapsedMs(s, now), 0);
  const idleCents = idleSessions.reduce((a, s) => a + earningsCents(rateFor(project, s), elapsedMs(s, now)), 0);
  const share = utilisation(totalMs, idleMs);

  // A goal saved as money before the project moved off the clock would render
  // a figure that can never move. Off the clock every goal reads as time.
  const asTime = (goal) => (goal && offClock ? { ...goal, type: "time" } : goal);
  const sessionGoal = asTime(project.sessionGoal);
  const overallGoal = asTime(project.overallGoal);
  const periodSessions = overallGoal
    ? sessions.filter((s) => startedAt(s) >= periodStart(overallGoal.period, now))
    : [];
  const periodCents = periodSessions.reduce((a, s) => a + earningsCents(rateFor(project, s), elapsedMs(s, now)), 0);
  const periodMs = periodSessions.reduce((a, s) => a + elapsedMs(s, now), 0);

  // The ledger shows both kinds; the totals above keep them apart.
  const ordered = [...sessions, ...idleSessions].sort((a, b) => startedAt(b) - startedAt(a));
  const visible = filterTask
    ? ordered.filter((s) =>
        filterTask === UNASSIGNED ? !s.taskId : s.taskId === filterTask)
    : ordered;
  const showLedger = ledgerOpen ?? (visible.length <= LEDGER_AUTO_COLLAPSE && !filterTask);
  const selecting = selected.length > 0;
  const toggleSelect = (id) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const taskRows = taskTotals(project, [...sessions, ...idleSessions], now);
  const hasTasks = taskRows.some((r) => r.taskId);

  return (
    <>
      <div className={"face" + (idling ? " idle" : "")}>
        <div className="face-top">
          <div>
            <div className="plate-name">{project.name}</div>
            <div className="plate-rate">
              {offClock ? "off the clock · not counted as work" : <>
                {formatMoney(Math.round((current ? rateFor(project, current) : project.currentRate) * 100), currency)} per hour
                {current && rateFor(project, current) !== current.rate && " · task rate"}
                {current && rateFor(project, current) === current.rate
                  && current.rate !== project.currentRate && " · rate locked for this session"}
              </>}
            </div>
          </div>
          <span className={`state${running ? (idling ? " idling" : " on") : ""}`}>
            {running ? (idling ? "Idling" : "Running") : current ? "Paused" : "Stopped"}
          </span>
        </div>

        {/* An off-clock project has no earnings to show, and a huge 0.00 reads
            as a broken meter. The elapsed time is the figure that matters. */}
        <div className="money">
          {offClock
            ? <span className="money-head">{formatDuration(shownMs)}</span>
            : <>
                <span className="money-head">{head}</span>
                {tail !== null && <span className="money-tail">{tail}</span>}
              </>}
        </div>

        {idling && <div className="money-label">Not billed — idle time at this project&apos;s rate</div>}

        {current && (
          <button className="task-chip" onClick={() => setPrompt({ reassign: true })}>
            {w.taskCap} · {current.taskId ? taskLabel(project, current.taskId) : "none"} · change
          </button>
        )}

        <div className="clock">
          {/* Off the clock the headline figure is already this duration, so
              repeating it here would just print the same number twice. */}
          {!offClock && <span className="clock-main">{formatDuration(shownMs)}</span>}
          <span className="clock-note">
            {current
              ? `started ${time(startedAt(current))}`
              : offClock ? "not tracking" : "meter is stopped"}
          </span>
        </div>

        {/* Minute rail: one mark per minute of the current billable hour. It
            counts out an hour you are going to charge for, so off the clock
            there is nothing for it to count. */}
        {!offClock && <>
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

        {prompt && (
          <TaskPrompt
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
          {!current && !prompt && (
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
              <button className="btn primary" onClick={onStop}>
                {idling ? "Stop idling" : w.stop}
              </button>
            </>
          )}
          {current && !running && (
            <>
              <button className="btn primary" onClick={onResume}>Resume</button>
              <button className="btn ghost"
                      onClick={() => onStart(idling ? KIND.IDLE : KIND.BILLED, { taskId: current.taskId })}>
                {offClock ? "New entry" : "New session"}
              </button>
            </>
          )}
        </div>

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

      {(sessionGoal || overallGoal) && (
        <div className="sec">
          <div className="sec-head"><span className="eyebrow">Goals</span></div>
          <div className="panel">
            {sessionGoal && (
              <GoalBar label="This session" type={sessionGoal.type} target={sessionGoal.target}
                       currency={currency}
                       value={sessionGoal.type === "money"
                         ? (current ? earningsCents(rateFor(project, current), shownMs) : 0) / 100
                         : shownMs / 60000} />
            )}
            {overallGoal && (
              <GoalBar
                label={overallGoal.period === "lifetime" ? "All time"
                     : overallGoal.period === "week" ? "This week" : "This month"}
                type={overallGoal.type} target={overallGoal.target} currency={project.currency}
                value={overallGoal.type === "money" ? periodCents / 100 : periodMs / 60000} />
            )}
          </div>
        </div>
      )}

      {hasTasks && (
        <div className="sec">
          <div className="sec-head">
            <span className="eyebrow">{w.byTask}</span>
            <span className="eyebrow">
              {taskRows.length} {w.task}{taskRows.length === 1 ? "" : "s"}
            </span>
          </div>
          {editingTask && (
            <div style={{ marginBottom: 12 }}>
              <TaskEditor words={w}
                task={findTask(project, editingTask)}
                currency={project.currency}
                projectRate={project.currentRate}
                sessionCount={sessionsUnderTask([...sessions, ...idleSessions], editingTask)}
                onCancel={() => setEditingTask(null)}
                onSave={(patch) => { onSaveTask(editingTask, patch); setEditingTask(null); }}
                onDelete={() => {
                  onDeleteTask(editingTask);
                  if (filterTask === editingTask) setFilterTask(null);
                  setEditingTask(null);
                }}
              />
            </div>
          )}
          <TaskBreakdown offClock={offClock} rows={taskRows} currency={project.currency} active={filterTask}
                         onEdit={(id) => setEditingTask(id)}
                         onPick={(key) => {
                           setFilterTask(key === filterTask ? null : key);
                           setLedgerOpen(true);
                           setSelected([]);
                         }} />
        </div>
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

      <div className="sec">
        <div className="sec-head">
          <button className="toggle" onClick={() => setLedgerOpen(!showLedger)}
                  aria-expanded={showLedger}>
            <span className={"chev" + (showLedger ? " open" : "")}>▶</span>
            <span className="eyebrow">
              {w.ledger} · {ordered.length}{offClock
                ? ` entr${ordered.length === 1 ? "y" : "ies"}`
                : ` session${ordered.length === 1 ? "" : "s"}`}
            </span>
          </button>
          <span className="eyebrow">
            {offClock ? "" : `${formatMoney(totalCents, project.currency)} · `}
            {totalMs ? formatShortDuration(totalMs) : "0m"}
          </span>
        </div>

        {filterTask && (
          <button className="chip" style={{ marginBottom: 12 }} onClick={() => setFilterTask(null)}>
            Showing {filterTask === UNASSIGNED ? "sessions with no task" : taskLabel(project, filterTask)} ✕
          </button>
        )}

        {selecting && (
          <div className="selbar">
            <span className="selbar-count">{selected.length} selected</span>
            <button className="btn primary" onClick={() => setBulkPrompt(true)}>
              {w.assign}
            </button>
            <button className="btn ghost" onClick={() => setSelected([])}>Clear</button>
          </div>
        )}

        {bulkPrompt && (
          <div style={{ marginBottom: 12 }}>
            <TaskPrompt
              project={project} confirmLabel={`Move ${selected.length} session${selected.length === 1 ? "" : "s"}`}
              onCancel={() => setBulkPrompt(false)}
              onConfirm={(pick) => {
                onAssign(selected, pick);
                setSelected([]);
                setBulkPrompt(false);
              }}
            />
          </div>
        )}

        {showLedger && visible.length > 1 && (
          <div className="controls" style={{ marginTop: 0, marginBottom: 12 }}>
            <button className="btn ghost"
                    onClick={() => setSelected(
                      selected.length === visible.length ? [] : visible.map((x) => x.id)
                    )}>
              {selected.length === visible.length ? "Deselect all" : `Select all ${visible.length}`}
            </button>
          </div>
        )}

        {editingSession && (
          <div style={{ marginBottom: 12 }}>
            <SessionEditor
              session={[...sessions, ...idleSessions].find((x) => x.id === editingSession)}
              project={project}
              onCancel={() => setEditingSession(null)}
              onSave={(window_) => { onCorrect(editingSession, window_); setEditingSession(null); }}
              onRevert={() => { onRevertCorrection(editingSession); setEditingSession(null); }}
            />
          </div>
        )}

        {showLedger && (
        <div className="panel">
          {visible.length === 0 ? (
            <div className="empty">
              {filterTask ? w.emptyFiltered : w.emptyLedger}
            </div>
          ) : visible.map((s) => (
            <div className={"row pick" + (isIdle(s) ? " is-idle" : "") + (selected.includes(s.id) ? " sel" : "")}
                 key={s.id}>
              <input type="checkbox" className="row-check" checked={selected.includes(s.id)}
                     aria-label={`Select session from ${date(startedAt(s))}`}
                     onChange={() => toggleSelect(s.id)} />
              <div>
                <div className="row-when">
                  {date(startedAt(s))} · {time(startedAt(s))}{isRunning(s) && " · running"}
                  {isIdle(s) && <span className="tag">Idle</span>}
                  {wasCorrected(s) && <span className="edited">Edited</span>}
                  {!isOpen(s) && (
                    <>
                      {" "}
                      <button className="linkish" onClick={() => setEditingSession(s.id)}>edit</button>
                    </>
                  )}
                </div>
                <div className="row-meta">
                  {s.taskId ? `${taskLabel(project, s.taskId)} · ` : `${w.noTask} · `}
                  {formatDuration(elapsedMs(s, now))}
                  {!offClock && <>
                    {" at "}
                    {formatMoney(Math.round(rateFor(project, s) * 100), s.currency)}/hr
                    {rateFor(project, s) !== s.rate && " (task rate)"}
                  </>}
                  {s.segments.length > 1 && ` · ${s.segments.length} blocks`}
                </div>
              </div>
              <span className="row-amt">
                {offClock
                  ? formatShortDuration(elapsedMs(s, now))
                  : formatMoney(earningsCents(rateFor(project, s), elapsedMs(s, now)), s.currency)}
              </span>
              <button className="x" aria-label="Remove session" onClick={() => onDeleteSession(s.id)}>×</button>
            </div>
          ))}
        </div>
        )}
      </div>

      <div className="sec">
        <div className="sec-head">
          <span className="eyebrow">Settings</span>
          <button className="linkbtn" onClick={() => setSettingsOpen((v) => !v)}>
            {settingsOpen ? "Close" : "Open"}
          </button>
        </div>
        {settingsOpen && (
          <Settings project={project} onPatch={onPatch} onDeleteProject={onDeleteProject}
                    hasRunningSession={!!running} />
        )}
      </div>
    </>
  );
}
