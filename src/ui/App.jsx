import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createStore } from "../storage/store.js";
import { isRunning, startedAt } from "../domain/time.js";
import { formatShortDuration } from "../domain/money.js";
import {
  currentSession, idleSessionsFor, isBilled, liveSessions, ownedBy, sessionsFor, stopSession,
} from "../domain/sessions.js";
import { liveProjects } from "../domain/projects.js";
import { earningsFor, liveEarnings } from "../domain/earnings.js";
import { storedPeriodFor } from "../domain/payPeriod.js";
import { OUTCOME } from "../domain/payouts.js";
import { upcomingPay } from "../domain/payout.js";
import { backupState } from "../domain/backup.js";
import { mergeState, overlaps, stampChanges } from "../domain/merge.js";
import { createAuth, originAllowed } from "../sync/google.js";
import { createDrive, syncOnce } from "../sync/drive.js";
import { SETTING, THEME, deviceId, loadSetting, saveSetting } from "../storage/settings.js";
import Sync, { SyncPip } from "./Sync.jsx";
import { pricer } from "../domain/terms.js";
import RunningBar from "./RunningBar.jsx";
import { offClockProjects, workProjects } from "../domain/projects.js";
import { dayKey, liveObjectives, objectivesFor, toggleObjective } from "../domain/objectives.js";
import { liveTodos } from "../domain/todos.js";
import { CSS } from "./styles.js";
import { ledgerWords } from "./words.js";
import { Notice, Toast } from "./parts.jsx";
import ProjectsView from "./ProjectsView.jsx";
import ProjectView from "./ProjectView.jsx";
import DashboardView from "./DashboardView.jsx";
import TodayView from "./TodayView.jsx";
import SettingsTab from "./SettingsTab.jsx";

import { EMPTY, useStartup } from "./app/useStartup.js";
import { useOverLimit } from "./app/useOverLimit.js";
import { useClock } from "./app/useClock.js";
import { useWakeCatchUp } from "./app/useWakeCatchUp.js";
import { useHeartbeat } from "./app/useHeartbeat.js";
import UnreadableBanner from "./app/UnreadableBanner.jsx";
import AlreadyRunning from "./app/AlreadyRunning.jsx";
import { sessionActions } from "./app/sessionActions.js";
import { taskActions } from "./app/taskActions.js";
import { moneyActions, paymentActions } from "./app/moneyActions.js";
import { projectActions, projectListActions } from "./app/projectActions.js";
import { objectiveActions } from "./app/objectiveActions.js";
import { todayActions } from "./app/todayActions.js";
import { navigation } from "./app/navigation.js";
import TopBar from "./app/TopBar.jsx";
import { backupHandlers } from "./app/backup.js";
import VolatileNotice from "./app/VolatileNotice.jsx";
import SaveFailedNotice from "./app/SaveFailedNotice.jsx";
import RecoveryPrompt from "./app/RecoveryPrompt.jsx";
import PaydayNotice from "./app/PaydayNotice.jsx";
import BackupReminder from "./app/BackupReminder.jsx";

/** A burst of edits should be one upload, not one per keystroke. */
const PUSH_DELAY_MS = 8_000;

/** Replaced at build time; the fallback is what a dev server would show. */
const VERSION = typeof __METER_VERSION__ === "string" ? __METER_VERSION__ : "dev";
/**
 * How often to look for news while a meter is going.
 *
 * Without it the only way to learn that the other device stopped the session
 * is to leave the app and come back, so a stop from your phone would sit
 * unseen on a laptop that is still counting the hours.
 */
const LIVE_PULL_MS = 120_000;
const TOAST_MS = 7_000;

const clockTime = (t) =>
  new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const dayShort = (t) =>
  new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** One side of a clash, by the two facts that let you recognise it: whose work
 *  it is and when it started. A session deleted since the merge is named
 *  rather than linked — there is nothing left to open. */
function SessionLink({ id, state, projects, onShow }) {
  const session = state.sessions.find((x) => x.id === id);
  if (!session || session.deletedAt) return <span>a deleted session</span>;
  const project = projects.find((p) => p.id === session.projectId);
  return (
    <button className="linkish" onClick={() => onShow(id)}>
      {project?.name ?? "a removed project"}, {clockTime(startedAt(session))}
    </button>
  );
}

export default function App({ store: injectedStore }) {
  // Created ONCE. A default parameter (`store = createStore()`) is evaluated on
  // every render, which made this a new object every time — so the load effect's
  // dependency changed on every render, re-ran, called setState with a freshly
  // parsed object, and re-rendered. A runaway loop that also re-armed the
  // startup banners, so dismissing one appeared to do nothing.
  const [store] = useState(() => injectedStore ?? createStore());
  /** Which machine this is, minted once and never synced. It is what lets a
   *  meter running on the laptop be told apart from one that crashed. */
  const [device] = useState(deviceId);

  const [state, setState] = useState(EMPTY);
  const [ready, setReady] = useState(false);
  const [openProjectId, setOpenProjectId] = useState(null);
  // Today leads: what you are doing now and what to start next is the reason
  // the app gets opened, and the Overview answers a different question — how
  // a month went — that nobody asks first. The project list is a tab of its
  // own, and a project opens as a drill-down from it, so closing one returns
  // there rather than to a screen the user was not looking at.
  const [tab, setTab] = useState("today");
  const [now, setNow] = useState(() => Date.now());
  const [recoveryId, setRecoveryId] = useState(null);
  const [conflict, setConflict] = useState(false);
  /** A session the user has been sent to look at, from a warning that named
   *  it. Cleared on the way out, so returning later does not re-scroll. */
  const [focusSession, setFocusSession] = useState(null);
  const [toast, setToast] = useState(null);
  const [saveFailed, setSaveFailed] = useState(false);
  /** What the store found and could not read, if anything — see
   *  `store.unreadable`. Held here so the banner can be answered and put away. */
  const [unreadable, setUnreadable] = useState(null);
  /** A backup file that has been read and checked but not yet let in:
   *  `{ name, state }`, waiting on "Replace my ledger". */
  const [restoring, setRestoring] = useState(null);

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

  const { answerPayment, answerPayments, markPaymentLines } = paymentActions({ commit, flash, stateRef });

  useStartup({
    store, device, stateRef, toastTimer, setState, setUnreadable, setReady, setRecoveryId,
    setConflict,
  });

  const anyRunning = useMemo(() => liveSessions(state.sessions).some(isRunning), [state.sessions]);
  /** A meter THIS device is holding. Only it may write proof of life. */
  const meterHere = useMemo(
    () => liveSessions(state.sessions).some((s) => isRunning(s) && ownedBy(s, device)),
    [state.sessions, device],
  );
  const backup = useMemo(() => backupState(state, now), [state, now]);

  /**
   * What is coming in, and when, once a minute rather than on every tick of
   * `now`: the "not before" date on work under review is the payday of the
   * period the clock is in, and a period shuts at a minute, not at midnight —
   * a cutoff is set to the minute, so no finer key is needed. Here, not in the
   * Overview, because the notice that follows a passed payday shows on every
   * tab. Read from the stored lists, which are stable between changes, so it
   * is not worked out again by a re-render.
   */
  const minute = Math.floor(now / 60_000);
  const pay = useMemo(
    () => upcomingPay({
      projects: state.projects, sessions: state.sessions, earnings: state.earnings,
      companies: state.companies, payouts: state.payouts,
    }, now),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above: the minute, not the second
    [state.projects, state.sessions, state.earnings, state.companies, state.payouts, minute],
  );
  // The one-time question about every past payday, and the day the notice
  // about the oldest was last put off. Both per device; see settings.js.
  const [payoutsAsked, setPayoutsAsked] = useState(() => loadSetting(SETTING.PAYOUTS_ASKED) === "1");
  const [laterDay, setLaterDay] = useState(() => loadSetting(SETTING.PAYOUT_LATER));

  const price = useMemo(
    () => pricer(liveProjects(state.projects), liveSessions(state.sessions)),
    [state.projects, state.sessions],
  );
  useOverLimit({ state, now, price, device, flash });

  // ------------------------------------------------------------------ syncing
  const [clientId, setClientId] = useState(() => loadSetting(SETTING.CLIENT_ID));
  const [clientDraft, setClientDraft] = useState("");
  const [sync, setSync] = useState({ state: "idle", at: null });
  const [theme, setTheme] = useState(() => loadSetting(SETTING.THEME, THEME.SYSTEM));
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

  useClock(anyRunning, setNow);

  useWakeCatchUp(setNow);

  useHeartbeat({ meterHere, recoveryId, write, device, stateRef });

  /** While something is going, look for news on a timer — a stop made on the
   *  other device has to reach the one that is still counting. */
  useEffect(() => {
    if (!anyRunning || !clientId) return;
    const id = setInterval(() => runSync(), LIVE_PULL_MS);
    return () => clearInterval(id);
  }, [anyRunning, clientId, runSync]);

  const { exportBackup, exportCsv, importBackup, confirmRestore, downloadUnreadable } = backupHandlers({
    stateRef, commit, flash, write, store, unreadable, restoring, setRestoring, setOpenProjectId,
    setUnreadable,
  });

  const { openProject, showSession } = navigation({
    stateRef, setOpenProjectId, setFocusSession, setTab,
  });

  if (!ready) {
    return <div className="mtr"><style>{CSS}</style><div className="wrap empty">Loading your ledger…</div></div>;
  }

  // Deleted projects are tombstoned rather than removed, so every read of them
  // goes through here. One place to forget instead of seven.
  const projects = liveProjects(state.projects);
  const project = projects.find((p) => p.id === openProjectId) || null;
  const current = project ? currentSession(state, project.id) : null;

  /** The one meter that is going, wherever it belongs. Two at once is already
   *  reported as a conflict elsewhere; this takes the first either way, so the
   *  strip never disagrees with itself between renders. Computed plainly
   *  rather than memoised: it runs after an early return, where a hook cannot
   *  go, and it is a filter over a list this render walks several times
   *  already. */
  const runningSession = liveSessions(state.sessions).filter(isRunning)[0] ?? null;
  const runningProject = runningSession
    ? projects.find((p) => p.id === runningSession.projectId) ?? null
    : null;
  const recovering = recoveryId ? state.sessions.find((s) => s.id === recoveryId) : null;

  return (
    // The attribute the palette already keys off: absent means follow the
    // system, and "light" is what overrides a system set to dark.
    <div className="mtr" data-theme={theme === THEME.SYSTEM ? undefined : theme}>
      <style>{CSS}</style>
      <div className="wrap">
        {/* Above everything, because it is about right now and the rest of the
            page is about what has already happened. */}
        {runningProject && (
          <RunningBar
            project={runningProject} session={runningSession} now={now} price={price}
            elsewhere={!ownedBy(runningSession, device)}
            onOpen={openProject}
            onStop={() => commit((s) => stopSession(s, runningSession.id, Date.now()))}
          />
        )}

        <TopBar
          project={project} tab={tab} setTab={setTab} setOpenProjectId={setOpenProjectId}
          setFocusSession={setFocusSession}
        />

        {/* First, because it is about the ledger itself. Opening empty without
            a word is how the original used to get saved over: nothing looked
            wrong until the first change had already replaced it. */}
        {unreadable && (
          <UnreadableBanner
            unreadable={unreadable} store={store} downloadUnreadable={downloadUnreadable}
            setUnreadable={setUnreadable} setOpenProjectId={setOpenProjectId}
            setFocusSession={setFocusSession} setTab={setTab}
          />
        )}

        {store.volatile && (
          <VolatileNotice />
        )}

        {/* Not while the store is holding for an unreadable ledger: the banner
            above already says nothing is saved, and why, and how to end it. */}
        {saveFailed && !(unreadable && store.held) && (
          <SaveFailedNotice />
        )}

        {recovering && (
          <RecoveryPrompt
            recovering={recovering} now={now} state={state} projects={projects} commit={commit}
            setRecoveryId={setRecoveryId}
          />
        )}

        {conflict && !recovering && (
          <AlreadyRunning setConflict={setConflict} />
        )}

        {/* Only a merge can produce this: the app refuses to CREATE overlapping
            time, so it means the meter ran on two devices at once. Nothing else
            about the ledger looks wrong — the hours simply read high. */}
        {merged?.overlaps?.length > 0 && (
          <Notice title="Some time is counted twice">
            The meter ran in two places at once, so these hours are in the ledger twice.
            Open each side and correct or delete whichever is wrong.
            {/* Naming them is the whole value of the warning. "Two sessions
                overlap" leaves the reader to find two records out of hundreds
                by matching timestamps by eye, which is the work the app just
                did and then threw away. */}
            {merged.overlaps.map((clash) => (
              <span className="twice" key={`${clash.a}-${clash.b}`}>
                <strong>{formatShortDuration(clash.ms)}</strong> twice,
                {" "}from {clockTime(clash.at)} on {dayShort(clash.at)}:{" "}
                <SessionLink id={clash.a} state={state} projects={projects} onShow={showSession} />
                {" and "}
                <SessionLink id={clash.b} state={state} projects={projects} onShow={showSession} />
              </span>
            ))}
            {" "}
            <button className="linkish" onClick={() => setMerged(null)}>Dismiss</button>
          </Notice>
        )}

        {/* A payday has passed and nobody has said what came. The oldest first,
            and the next when it is answered. Not while the Overview's one-time
            question about every past payday is still waiting, which is the
            kinder way to deal with years of them, and not on a day it was put
            off. On every tab, because money that did not arrive is worth
            knowing about wherever you are. */}
        {ready && payoutsAsked && pay.overdue.length > 0 && laterDay !== dayKey(now) && (
          <PaydayNotice pay={pay} state={state} now={now} answerPayment={answerPayment}
                        setLaterDay={setLaterDay} />
        )}

        {/* Last of the banners, deliberately. A meter left running overnight or
            a second tab overwriting this one need answering now; a missing
            backup is important but not urgent, and putting it above them buries
            the thing the user has to act on. */}
        {ready && backup.stale && (
          <BackupReminder backup={backup} exportBackup={exportBackup} />
        )}


        {project ? (
          <ProjectView
            /* Keyed by the project, so opening another one starts a fresh
               page rather than reusing this one. Every form inside it is
               seeded once, from the project it opened on; reused for the
               next project, Settings would show the first project's name and
               rate, and Save would write them onto the second. */
            key={project.id}
            project={project} current={current} now={now}
            sessions={sessionsFor(state, project.id)}
            idleSessions={idleSessionsFor(state, project.id)}
            {...sessionActions({ commit, flash, stateRef, device, project, current })}
            {...taskActions({ commit, flash, stateRef, project })}
            {...moneyActions({ commit, flash, stateRef, project })}
            {...projectActions({ commit, flash, stateRef, project, setOpenProjectId })}
            {...objectiveActions({ commit, flash, project })}
            focusSession={focusSession}
            objectives={objectivesFor(state, project.id)}
            today={dayKey(now)}
            projects={projects}
            earnings={earningsFor(state, project.id)}
            /* As stored, so a zone this browser does not know is shown and
               saved back rather than quietly dropped. */
            payPeriod={storedPeriodFor(state, project)}
            /* Every client's schedule, so Settings can say when a company
               typed into it already has one that saving would replace. */
            companies={state.companies ?? []}
          />
        ) : tab === "today" ? (
          <TodayView
            projects={projects}
            sessions={liveSessions(state.sessions)}
            earnings={liveEarnings(state)}
            now={now} running={Boolean(runningSession)}
            todos={liveTodos(state)}
            {...todayActions({ commit, flash, stateRef, projects, device, openProject })}
            onOpen={openProject}
            onShowSession={showSession}
          />
        ) : tab === "overview" ? (
          <DashboardView
            projects={projects}
            /* Both kinds: the dashboard reports idle time beside billed, and
               `performanceIn` is what keeps the two apart. */
            sessions={liveSessions(state.sessions)}
            earnings={liveEarnings(state)}
            objectives={liveObjectives(state)}
            companyRules={state.companies ?? []}
            pay={pay}
            asked={payoutsAsked}
            onSettleAsk={() => { saveSetting(SETTING.PAYOUTS_ASKED, "1"); setPayoutsAsked(true); }}
            onAnswer={answerPayment}
            onPaid={(rows) => answerPayments(rows, OUTCOME.PAID, undefined,
              rows.length === 1 ? "Marked as paid." : `${rows.length} payments marked as paid.`)}
            onMovePayment={(row, date) => answerPayments([row], OUTCOME.MOVED, date, "Date changed.")}
            onMarkLines={markPaymentLines}
            now={now}
            today={dayKey(now)}
            onOpenProject={openProject}
            onToggleObjective={(id) => commit((s) => toggleObjective(s, id, Date.now()))}
          />
        ) : tab === "settings" ? (
          <SettingsTab
            theme={theme}
            onTheme={(key) => {
              setTheme(key);
              saveSetting(SETTING.THEME, key === THEME.SYSTEM ? null : key);
            }}
            backupProps={{
              backup, onExport: exportBackup, onImport: importBackup, onExportCsv: exportCsv,
              restore: restoring && {
                name: restoring.name,
                current: ledgerWords(state),
                incoming: ledgerWords(restoring.state),
              },
              onConfirmRestore: confirmRestore, onCancelRestore: () => setRestoring(null),
            }}
            /* The Sync panel sits with Export and Restore: the three are the
               answers to "where else does this exist". */
            sync={(
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
                canSignIn={originAllowed()} origin={window.location.origin}
                onSync={() => runSync({ interactive: true })}
                onSignOut={async () => {
                  await authRef.current?.signOut();
                  setSync({ state: "idle", at: null });
                }}
              />
            )}
          />
        ) : (
          <ProjectsView
            scope={tab}
            projects={tab === "life" ? offClockProjects(projects) : workProjects(projects)}
            sessions={tab === "life"
              ? liveSessions(state.sessions)
              : liveSessions(state.sessions).filter(isBilled)}
            earnings={liveEarnings(state)}
            objectives={liveObjectives(state)}
            now={now}
            onOpen={openProject}
            {...projectListActions({ commit })}
          />
        )}
      </div>

      <div className="foot">
        {/* Where the ledger stands with Drive, on every screen rather than
            only the one that configures it. Nothing at all before it is set
            up: there is no state to report, and a permanent "off" is
            furniture. */}
        {clientId && originAllowed() && (
          <SyncPip status={sync} now={now} signedIn={Boolean(authRef.current?.hasToken())}
                   onSync={() => runSync({ interactive: true })} />
        )}
        {/* Which build you are looking at. Three copies of this app can be in
            use at once — browser, phone and desktop — and "it works on mine"
            is not answerable without it. */}
        <p className="version">Meter v{VERSION}</p>
      </div>

      {toast && (
        <Toast message={toast.message} action={toast.action}
               onAction={() => { toast.run?.(); setToast(null); }} />
      )}
    </div>
  );
}
