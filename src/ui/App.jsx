import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createStore } from "../storage/store.js";
import { isRunning, isStale } from "../domain/time.js";
import {
  addManualSession, assignTaskToMany, correctSession, currentSession, deleteSession,
  overlappingSessions, revertCorrection, heartbeat, idleSessionsFor, isBilled,
  liveSessions, pauseSession, recoverSession, restoreSession, resumeSession,
  sessionsFor, startSession, stopSession,
} from "../domain/sessions.js";
import { addProject, patchProject, removeProject, setStatus } from "../domain/projects.js";
import {
  addEarning, earningsFor, liveEarnings, removeEarning, restoreEarning, setPayState,
} from "../domain/earnings.js";
import { addTask, removeTask, renameTask, resolveTaskId, setTaskRate } from "../domain/tasks.js";
import { backupState, recordBackup } from "../domain/backup.js";
import { toCsv } from "../domain/csv.js";
import { offClockProjects, workProjects } from "../domain/projects.js";
import {
  addObjective, dayKey, editObjective, focusObjective, liveObjectives, objectivesFor,
  removeObjective, restoreObjective, toggleObjective, unlinkTask,
} from "../domain/objectives.js";
import { CSS } from "./styles.js";
import { countWord, daysWord } from "./words.js";
import { Notice, RecoveryBanner, Toast } from "./parts.jsx";
import ProjectsView from "./ProjectsView.jsx";
import ProjectView from "./ProjectView.jsx";
import DashboardView from "./DashboardView.jsx";

const TICK_MS = 1_000;
const HEARTBEAT_MS = 60_000;
const STALE_MS = 150_000;
const TOAST_MS = 7_000;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/**
 * Turns a prompt answer into a task id plus the state change that must land
 * first. A new label reuses an existing task's id when it already matches, so
 * the prompt can never mint a duplicate the user would read as the same task.
 */
const resolveTaskPick = (project, pick, createTask) => {
  if (pick?.label === undefined) return { id: pick?.taskId ?? null, prepare: (s) => s };
  const id = resolveTaskId(project, pick.label, uid());
  return { id, prepare: (s) => createTask(s, id, pick.label) };
};
const EMPTY = { projects: [], sessions: [], objectives: [], earnings: [] };

export default function App({ store: injectedStore }) {
  // Created ONCE. A default parameter (`store = createStore()`) is evaluated on
  // every render, which made this a new object every time — so the load effect's
  // dependency changed on every render, re-ran, called setState with a freshly
  // parsed object, and re-rendered. A runaway loop that also re-armed the
  // startup banners, so dismissing one appeared to do nothing.
  const [store] = useState(() => injectedStore ?? createStore());

  const [state, setState] = useState(EMPTY);
  const [ready, setReady] = useState(false);
  const [openProjectId, setOpenProjectId] = useState(null);
  // The overall view leads, and the project list is a tab of its own. A project
  // opens as a drill-down from that list, so closing one returns there rather
  // than to the dashboard the user was not looking at.
  const [tab, setTab] = useState("overview");
  const [now, setNow] = useState(() => Date.now());
  const [recoveryId, setRecoveryId] = useState(null);
  const [conflict, setConflict] = useState(false);
  const [toast, setToast] = useState(null);
  const [saveFailed, setSaveFailed] = useState(false);

  const stateRef = useRef(state);
  const toastTimer = useRef(null);

  /** Single write path. Reducers are pure; this is the only place that
   *  touches React state and storage together. */
  const commit = useCallback((reduce) => {
    const next = reduce(stateRef.current);
    stateRef.current = next;
    setState(next);
    store.save(next).then((ok) => setSaveFailed(!ok));
  }, [store]);

  const flash = useCallback((message, action, run) => {
    clearTimeout(toastTimer.current);
    setToast({ message, action, run });
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const booted = useRef(false);

  /** Startup only. Guarded independently of the dependency array so that no
   *  future change to these deps can resurrect the startup banners after the
   *  user has already answered them. */
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    let alive = true;
    store.load().then((loaded) => {
      if (!alive) return;
      const data = loaded ?? EMPTY;
      stateRef.current = data;
      setState(data);
      setReady(true);

      const t = Date.now();
      const running = liveSessions(data.sessions).filter(isRunning);
      const stale = running.find((s) => isStale(s, t, STALE_MS));
      if (stale) setRecoveryId(stale.id);
      else if (running.length) setConflict(true); // fresh heartbeat: another tab
    });
    return () => { alive = false; clearTimeout(toastTimer.current); };
  }, [store]);

  const anyRunning = useMemo(() => liveSessions(state.sessions).some(isRunning), [state.sessions]);
  const backup = useMemo(() => backupState(state, now), [state, now]);

  /** Drives rendering only. Stop this interval and the stored data is still
   *  correct — elapsed time is derived, never accumulated here. */
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [anyRunning]);

  /** Proof of life, so a crash can be closed at the right timestamp. */
  useEffect(() => {
    if (!anyRunning || recoveryId) return;
    const id = setInterval(() => commit((s) => heartbeat(s, Date.now())), HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [anyRunning, recoveryId, commit]);

  /** Hands the user a file. Throws rather than failing quietly if the browser
   *  will not make one, so nothing downstream records a backup that never
   *  happened. */
  const download = (name, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const stamp = () => `meter-${new Date().toISOString().slice(0, 10)}`;

  const exportBackup = () => {
    // Serialised BEFORE the stamp, so the file records the state the user asked
    // for rather than one that claims to have already been backed up.
    download(`${stamp()}.json`, JSON.stringify(stateRef.current, null, 2), "application/json");
    commit((st) => recordBackup(st, Date.now()));
  };

  /**
   * Deliberately does NOT count as a backup.
   *
   * A CSV is for something else to read — a tax return, a spreadsheet. It drops
   * segments, goals, objectives and every id, so the app cannot read it back.
   * Letting it clear the backup nudge would leave someone believing they had a
   * copy they could restore from, which is the one mistake this whole feature
   * exists to prevent.
   */
  const exportCsv = () => {
    download(`${stamp()}.csv`, toCsv(stateRef.current, Date.now()), "text/csv;charset=utf-8");
  };

  /** Opening a project lands on the tab it belongs to, so the back link
   *  returns somewhere the project is actually listed. */
  const openProject = (id) => {
    const p = stateRef.current.projects.find((x) => x.id === id);
    setOpenProjectId(id);
    setTab(p?.offClock ? "life" : "work");
  };

  const importBackup = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.sessions)) throw new Error();
        const snapshot = stateRef.current;
        commit(() => parsed);
        setOpenProjectId(null);
        flash("Backup restored.", "Undo", () => commit(() => snapshot));
      } catch {
        flash("That file isn't a Meter backup.");
      }
    };
    reader.readAsText(file);
  };

  if (!ready) {
    return <div className="mtr"><style>{CSS}</style><div className="wrap empty">Loading your ledger…</div></div>;
  }

  const project = state.projects.find((p) => p.id === openProjectId) || null;
  const current = project ? currentSession(state, project.id) : null;
  const recovering = recoveryId ? state.sessions.find((s) => s.id === recoveryId) : null;

  return (
    <div className="mtr">
      <style>{CSS}</style>
      <div className="wrap">
        <div className="topbar">
          <span className="mark">Meter</span>
          {project
            ? <button className="linkbtn" onClick={() => setOpenProjectId(null)}>← All projects</button>
            : <nav className="tabs" role="tablist" aria-label="Views">
                {[["overview", "Overview"], ["work", "Work"], ["life", "Life"]].map(([key, label]) => (
                  <button key={key} role="tab" aria-selected={tab === key}
                          className={"tab" + (tab === key ? " on" : "")}
                          onClick={() => setTab(key)}>
                    {label}
                  </button>
                ))}
              </nav>}
        </div>

        {store.volatile && (
          <Notice title="Nothing is being saved">
            This browser is blocking storage, so your sessions disappear when you reload. Serve the
            file over http instead of opening it directly, or allow site data for this page.
          </Notice>
        )}

        {saveFailed && (
          <Notice title="Not saving">
            Changes aren&apos;t reaching storage, so this session won&apos;t survive a reload. Export a backup
            before you close the tab.
          </Notice>
        )}

        {recovering && (
          <RecoveryBanner
            session={recovering} now={now}
            project={state.projects.find((p) => p.id === recovering.projectId)}
            onStopAtLastTick={() => { commit((s) => recoverSession(s, recovering.id)); setRecoveryId(null); }}
            onKeepRunning={() => setRecoveryId(null)}
            onDelete={() => { commit((s) => deleteSession(s, recovering.id, Date.now())); setRecoveryId(null); }}
          />
        )}

        {conflict && !recovering && (
          <>
            <Notice title="Already running">
              A session was ticking seconds ago. If you have Meter open in another tab, close one —
              two tabs writing the same record will overwrite each other.
            </Notice>
            <div className="controls" style={{ marginTop: -10, marginBottom: 20 }}>
              <button className="btn ghost" onClick={() => setConflict(false)}>This tab only</button>
            </div>
          </>
        )}

        {/* Last of the banners, deliberately. A meter left running overnight or
            a second tab overwriting this one need answering now; a missing
            backup is important but not urgent, and putting it above them buries
            the thing the user has to act on. */}
        {ready && backup.stale && (
          <Notice title={backup.never ? "Never backed up" : `Last backed up ${daysWord(backup.days)}`}>
            {countWord(backup.unsaved)} exist only in this browser. Clearing site data, or
            reinstalling, takes {backup.unsaved === 1 ? "it" : "them"} with it —
            {" "}<button className="linkish" onClick={exportBackup}>export a backup</button> to keep a copy
            you hold.
          </Notice>
        )}


        {project ? (
          <ProjectView
            project={project} current={current} now={now}
            sessions={sessionsFor(state, project.id)}
            idleSessions={idleSessionsFor(state, project.id)}
            onStart={(kind, pick) => {
              const taskId = resolveTaskPick(project, pick, (st, id, label) =>
                addTask(st, project.id, { id, label }, Date.now()));
              commit((s) => startSession(
                taskId.prepare(s), project, { now: Date.now(), id: uid(), kind, taskId: taskId.id }));
            }}
            onPause={() => commit((s) => pauseSession(s, current.id, Date.now()))}
            onResume={() => commit((s) => resumeSession(s, current.id, Date.now()))}
            onStop={() => commit((s) => stopSession(s, current.id, Date.now()))}
            onDeleteSession={(id) => {
              commit((s) => deleteSession(s, id, Date.now()));
              flash("Session removed.", "Undo", () => commit((s) => restoreSession(s, id)));
            }}
            onAssign={(sessionIds, pick) => {
              const chosen = resolveTaskPick(project, pick, (st, id, label) =>
                addTask(st, project.id, { id, label }, Date.now()));
              commit((s) => assignTaskToMany(chosen.prepare(s), sessionIds, chosen.id));
            }}
            onCorrect={(sessionId, window_) => {
              const snapshot = stateRef.current;
              commit((s) => correctSession(s, sessionId, window_, Date.now()));
              flash("Session corrected.", "Undo", () => commit(() => snapshot));
            }}
            onRevertCorrection={(sessionId) =>
              commit((s) => revertCorrection(s, sessionId))}
            onSaveTask={(taskId, { label, rate }) =>
              commit((s) => setTaskRate(renameTask(s, project.id, taskId, label), project.id, taskId, rate))}
            onDeleteTask={(taskId) => {
              const snapshot = stateRef.current;
              // Objectives pointing at the task are unfiled with it, so the
              // intent survives even though the bucket does not.
              commit((s) => unlinkTask(removeTask(s, project.id, taskId), taskId));
              flash("Task deleted. Its sessions moved to “No task”.", "Undo",
                    () => commit(() => snapshot));
            }}
            findOverlaps={(window_) => overlappingSessions(stateRef.current, window_)}
            onAddManual={(entry) => {
              commit((s) => addManualSession(s, project, entry, Date.now(), uid()));
              flash("Time added.");
            }}
            objectives={objectivesFor(state, project.id)}
            today={dayKey(now)}
            onAddObjective={(fields) =>
              commit((s) => addObjective(s, project.id, fields, Date.now(), uid()))}
            onToggleObjective={(id) => commit((s) => toggleObjective(s, id, Date.now()))}
            onEditObjective={(id, patch) => commit((s) => editObjective(s, id, patch))}
            onFocusObjective={(id, key) => commit((s) => focusObjective(s, id, key))}
            onRemoveObjective={(id) => {
              commit((s) => removeObjective(s, id, Date.now()));
              flash("Removed.", "Undo", () => commit((s) => restoreObjective(s, id)));
            }}
            projects={state.projects}
            earnings={earningsFor(state, project.id)}
            onAddEarning={(entry) =>
              commit((s) => addEarning(s, project, entry, Date.now(), uid()))}
            onRemoveEarning={(id) => {
              commit((s) => removeEarning(s, id, Date.now()));
              flash("Removed.", "Undo", () => commit((s) => restoreEarning(s, id)));
            }}
            onSetPayState={(id, status) => commit((s) => setPayState(s, id, status))}
            onPatch={(patch) => commit((s) => patchProject(s, project.id, patch))}
            onSetStatus={(status) => {
              commit((s) => setStatus(s, project.id, status, Date.now()));
              if (status !== "active") {
                flash(status === "done" ? "Marked done." : "Paused.", "Undo",
                  () => commit((s) => setStatus(s, project.id, "active", Date.now())));
              }
            }}
            onDeleteProject={() => {
              const snapshot = stateRef.current;
              commit((s) => removeProject(s, project.id));
              setOpenProjectId(null);
              flash("Project removed.", "Undo", () => commit(() => snapshot));
            }}
          />
        ) : tab === "overview" ? (
          <DashboardView
            projects={state.projects}
            /* Both kinds: the dashboard reports idle time beside billed, and
               `performanceIn` is what keeps the two apart. */
            sessions={liveSessions(state.sessions)}
            earnings={liveEarnings(state)}
            objectives={liveObjectives(state)}
            now={now}
            today={dayKey(now)}
            onOpenProject={openProject}
            onToggleObjective={(id) => commit((s) => toggleObjective(s, id, Date.now()))}
          />
        ) : (
          <ProjectsView
            scope={tab}
            projects={tab === "life" ? offClockProjects(state.projects) : workProjects(state.projects)}
            sessions={tab === "life"
              ? liveSessions(state.sessions)
              : liveSessions(state.sessions).filter(isBilled)}
            earnings={liveEarnings(state)}
            objectives={liveObjectives(state)}
            now={now}
            onOpen={openProject}
            onAdd={(fields) => commit((s) => addProject(s, fields, Date.now(), uid()))}
            onExport={exportBackup} onImport={importBackup} backup={backup}
            onExportCsv={exportCsv}
          />
        )}
      </div>

      {toast && (
        <Toast message={toast.message} action={toast.action}
               onAction={() => { toast.run?.(); setToast(null); }} />
      )}
    </div>
  );
}
