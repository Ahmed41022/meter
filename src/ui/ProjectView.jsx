import { useState } from "react";
import { elapsedMs, isRunning, startedAt } from "../domain/time.js";
import {
  earningsCents, formatDuration, formatMoney, formatShortDuration, moneyParts,
} from "../domain/money.js";
import { periodStart } from "../domain/goals.js";
import { isIdle, KIND, utilisation } from "../domain/sessions.js";
import {
  findTask, rateFor, sessionsUnderTask, taskLabel, taskTotals, UNASSIGNED,
} from "../domain/tasks.js";
import TaskPrompt from "./TaskPrompt.jsx";
import TaskBreakdown from "./TaskBreakdown.jsx";
import TaskEditor from "./TaskEditor.jsx";

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
  onAssign, onSaveTask, onDeleteTask,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prompt, setPrompt] = useState(null);         // {kind} | {reassign:true}
  const [ledgerOpen, setLedgerOpen] = useState(null); // null = follow the default
  const [filterTask, setFilterTask] = useState(null); // UNASSIGNED, a taskId, or null
  const [selected, setSelected] = useState([]);       // session ids picked for re-filing
  const [bulkPrompt, setBulkPrompt] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const running = current && isRunning(current);
  const idling = current ? isIdle(current) : false;

  const shownMs = current ? elapsedMs(current, now) : 0;
  const currency = current?.currency ?? project.currency;
  const { head, tail } = moneyParts(current ? earningsCents(rateFor(project, current), shownMs) : 0, currency);

  const minuteInHour = Math.floor((shownMs % MS_PER_HOUR) / 60_000);
  const hoursBilled = Math.floor(shownMs / MS_PER_HOUR);

  const totalCents = sessions.reduce((a, s) => a + earningsCents(rateFor(project, s), elapsedMs(s, now)), 0);
  const totalMs = sessions.reduce((a, s) => a + elapsedMs(s, now), 0);

  const idleMs = idleSessions.reduce((a, s) => a + elapsedMs(s, now), 0);
  const idleCents = idleSessions.reduce((a, s) => a + earningsCents(rateFor(project, s), elapsedMs(s, now)), 0);
  const share = utilisation(totalMs, idleMs);

  const { sessionGoal, overallGoal } = project;
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
              {formatMoney(Math.round((current ? rateFor(project, current) : project.currentRate) * 100), currency)} per hour
              {current && rateFor(project, current) !== current.rate && " · task rate"}
              {current && rateFor(project, current) === current.rate
                && current.rate !== project.currentRate && " · rate locked for this session"}
            </div>
          </div>
          <span className={`state${running ? (idling ? " idling" : " on") : ""}`}>
            {running ? (idling ? "Idling" : "Running") : current ? "Paused" : "Stopped"}
          </span>
        </div>

        <div className="money">
          <span className="money-head">{head}</span>
          {tail !== null && <span className="money-tail">{tail}</span>}
        </div>

        {idling && <div className="money-label">Not billed — idle time at this project&apos;s rate</div>}

        {current && (
          <button className="task-chip" onClick={() => setPrompt({ reassign: true })}>
            Task · {current.taskId ? taskLabel(project, current.taskId) : "none"} · change
          </button>
        )}

        <div className="clock">
          <span className="clock-main">{formatDuration(shownMs)}</span>
          <span className="clock-note">
            {current ? `started ${time(startedAt(current))}` : "meter is stopped"}
          </span>
        </div>

        {/* Minute rail: one mark per minute of the current billable hour. */}
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

        {prompt && (
          <TaskPrompt
            project={project}
            initialTaskId={prompt.reassign ? current?.taskId : null}
            confirmLabel={
              prompt.reassign ? "Save" : prompt.kind === KIND.IDLE ? "Start idle" : "Start the meter"
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
                Start the meter
              </button>
              <button className="btn ghost" onClick={() => setPrompt({ kind: KIND.IDLE })}>
                Start idle
              </button>
            </>
          )}
          {running && (
            <>
              <button className="btn ghost" onClick={onPause}>Pause</button>
              <button className="btn primary" onClick={onStop}>
                {idling ? "Stop idling" : "Stop and save"}
              </button>
            </>
          )}
          {current && !running && (
            <>
              <button className="btn primary" onClick={onResume}>Resume</button>
              <button className="btn ghost"
                      onClick={() => onStart(idling ? KIND.IDLE : KIND.BILLED, { taskId: current.taskId })}>
                New session
              </button>
            </>
          )}
        </div>

        {/* Switching kind is always explicit. Auto-starting the other timer
            would attribute time to the wrong bucket with no trace of why. */}
        {running && (
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
            <span className="eyebrow">By task</span>
            <span className="eyebrow">{taskRows.length} row{taskRows.length === 1 ? "" : "s"}</span>
          </div>
          {editingTask && (
            <div style={{ marginBottom: 12 }}>
              <TaskEditor
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
          <TaskBreakdown rows={taskRows} currency={project.currency} active={filterTask}
                         onEdit={(id) => setEditingTask(id)}
                         onPick={(key) => {
                           setFilterTask(key === filterTask ? null : key);
                           setLedgerOpen(true);
                           setSelected([]);
                         }} />
        </div>
      )}

      {share !== null && idleMs > 0 && (
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
              Ledger · {ordered.length} session{ordered.length === 1 ? "" : "s"}
            </span>
          </button>
          <span className="eyebrow">
            {formatMoney(totalCents, project.currency)} · {totalMs ? formatShortDuration(totalMs) : "0m"}
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
              Assign to task
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

        {showLedger && (
        <div className="panel">
          {visible.length === 0 ? (
            <div className="empty">
              {filterTask ? "No sessions filed under this task yet." : "No sessions yet. Start the meter and this fills in."}
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
                </div>
                <div className="row-meta">
                  {s.taskId ? `${taskLabel(project, s.taskId)} · ` : "No task · "}
                  {formatDuration(elapsedMs(s, now))} at{" "}
                  {formatMoney(Math.round(rateFor(project, s) * 100), s.currency)}/hr
                  {rateFor(project, s) !== s.rate && " (task rate)"}
                  {s.segments.length > 1 && ` · ${s.segments.length} blocks`}
                </div>
              </div>
              <span className="row-amt">{formatMoney(earningsCents(rateFor(project, s), elapsedMs(s, now)), s.currency)}</span>
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
