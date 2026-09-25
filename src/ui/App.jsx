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
import { mergeState, overlaps, stampChanges } from "../domain/merge.js";
import { createAuth, originAllowed } from "../sync/google.js";
import { createDrive, syncOnce } from "../sync/drive.js";
import { SETTING, loadSetting, saveSetting } from "../storage/settings.js";
import Sync from "./Sync.jsx";
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
/** A burst of edits should be one upload, not one per keystroke. */
const PUSH_DELAY_MS = 8_000;
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
  /** Held in a ref so `commit` can ask for a push without depending on the sync
   *  machinery, which depends on `commit`. */
  const pushRef = useRef(() => {});
  const authRef = useRef(null);
  const pushTimer = useRef(null);
  /** The revision this device last saw, so the next sync can tell a quiet write
   *  from one that landed on top of somebody else's. */
  const revisionRef = useRef(null);

  /** Puts a state into React and storage together. Everything that changes the
   *  ledger goes through here or through `commit`, which wraps it. */
  const write = useCallback((next) => {
    stateRef.current = next;
    setState(next);
    store.save(next).then((ok) => setSaveFailed(!ok));
  }, [store]);

  /**
   * Single write path for the user's own changes.
   *
   * Stamps what the change touched, which is what lets two devices be merged
   * later: a record with no stamp loses to one that has been edited since. The
   * diff is a pointer comparison, because the reducers are pure and spread — see
   * domain/merge.js.
   *
   * `sync: false` is for writes that are not news. The heartbeat fires every
   * minute and pushing each one would be 1,400 uploads a day to say the meter is
   * still running; the next real change carries it.
   */
  const commit = useCallback((reduce, { sync = true } = {}) => {
    const before = stateRef.current;
    write(stampChanges(before, reduce(before), Date.now()));
    if (sync) pushRef.current();
  }, [write]);

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

  // ------------------------------------------------------------------ syncing
  const [clientId, setClientId] = useState(() => loadSetting(SETTING.CLIENT_ID));
  const [clientDraft, setClientDraft] = useState("");
  const [sync, setSync] = useState({ state: "idle", at: null });
  const [merged, setMerged] = useState(null);

  /**
   * One round: read Drive, merge, write back only if the merge changed it.
   *
   * A pulled state is adopted with `write` rather than `commit`, deliberately.
   * `commit` stamps whatever it touched, which would re-date every record that
   * just arrived and send them all straight back as if they were new edits here.
   */
  const runSync = useCallback(async ({ interactive = false } = {}) => {
    if (!clientId || !originAllowed()) return;
    setSync((s) => ({ ...s, state: "syncing", error: null }));
    try {
      if (!authRef.current) authRef.current = createAuth({ clientId });
      const auth = authRef.current;
      if (interactive && !auth.hasToken()) await auth.signIn();
      const drive = createDrive({ getToken: auth.getToken });
      const out = await syncOnce({
        drive, local: stateRef.current, merge: mergeState, revision: revisionRef.current,
      });
      revisionRef.current = out.revision;
      if (out.pulled) {
        write(out.state);
        // Two things only a merge can produce, and both need saying rather than
        // absorbing: time counted twice, and a meter apparently running in two
        // places. The second reuses the banner built for two browser tabs.
        const clashes = overlaps(liveSessions(out.state.sessions), Date.now());
        if (clashes.length) setMerged({ overlaps: clashes });
        if (liveSessions(out.state.sessions).filter(isRunning).length > 1) setConflict(true);
      }
      // Named fields, never `...out`: it carries the merged ledger under `state`,
      // and spreading it would put the whole thing into the field that holds the
      // word "ok".
      setSync({
        state: "ok", at: Date.now(),
        pushed: out.pushed, pulled: out.pulled, created: out.created, raced: out.raced,
      });
    } catch (e) {
      setSync({
        state: "error", at: Date.now(),
        error: e?.needsAuth ? "Sign in again to keep syncing." : (e?.message ?? "Sync failed."),
      });
    }
  }, [clientId, write]);

  /** Debounced, so a burst of edits is one upload. Long enough that typing a
   *  project name is not a dozen round trips. */
  useEffect(() => {
    pushRef.current = () => {
      if (!clientId) return;
      clearTimeout(pushTimer.current);
      pushTimer.current = setTimeout(() => runSync(), PUSH_DELAY_MS);
    };
    return () => clearTimeout(pushTimer.current);
  }, [clientId, runSync]);

  /** On opening, and whenever the app comes back to the foreground — which on a
   *  phone is the moment it matters, because it is how it learns what the other
   *  device did while it was closed. */
  useEffect(() => {
    if (!ready || !clientId) return;
    runSync();
    const onShow = () => { if (!document.hidden) runSync(); };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [ready, clientId, runSync]);

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
    const id = setInterval(
      () => commit((s) => heartbeat(s, Date.now()), { sync: false }),
      HEARTBEAT_MS,
    );
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

        {/* Only a merge can produce this: the app refuses to CREATE overlapping
            time, so it means the meter ran on two devices at once. Nothing else
            about the ledger looks wrong — the hours simply read high. */}
        {merged?.overlaps?.length > 0 && (
          <Notice title="Some time is counted twice">
            {merged.overlaps.length === 1 ? "A session" : `${merged.overlaps.length} sessions`}
            {" "}brought in from another device
            {merged.overlaps.length === 1 ? " overlaps" : " overlap"} one already here, so
            those hours are counted twice. Open the project and correct or delete whichever
            is wrong.
            {" "}<button className="linkish" onClick={() => setMerged(null)}>Dismiss</button>
          </Notice>
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

        {/* Sync belongs beside Export and Restore: they are the three answers to
            "where else does this exist". Work only — the Life tab has no ledger
            of its own, it is a view of the same one. */}
        {!project && tab === "work" && (
          <Sync
            clientId={clientId} draft={clientDraft} onDraft={setClientDraft}
            onSaveClientId={() => {
              const id = clientDraft.trim();
              if (!id) return;
              saveSetting(SETTING.CLIENT_ID, id);
              setClientId(id);
              setClientDraft("");
            }}
            onForget={() => {
              saveSetting(SETTING.CLIENT_ID, null);
              setClientId("");
              authRef.current = null;
              revisionRef.current = null;
              setSync({ state: "idle", at: null });
            }}
            status={sync} now={now} signedIn={Boolean(authRef.current?.hasToken())}
            canSignIn={originAllowed()}
            onSync={() => runSync({ interactive: true })}
            onSignOut={async () => {
              await authRef.current?.signOut();
              setSync({ state: "idle", at: null });
            }}
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
