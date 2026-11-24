import { useEffect, useState } from "react";
import { normaliseGoal } from "../domain/goals.js";
import { companyOf, fold, isOffClock } from "../domain/projects.js";
import { REWARD } from "../domain/earnings.js";
import { readHours } from "../domain/minimum.js";
import { SCOPE } from "../domain/terms.js";
import { findCompany, samePeriod, storedPeriod } from "../domain/payPeriod.js";
import { HOUR, formOf, periodForm, periodOf } from "./settings/form.js";
import { keepDraft, restored, unsavedSettings } from "./settings/drafts.js";
import { goalFields } from "./settings/goalFields.jsx";
import RateTerms from "./settings/RateTerms.jsx";
import CompanyPayday from "./settings/CompanyPayday.jsx";
import ProjectState from "./settings/ProjectState.jsx";
import Danger from "./settings/Danger.jsx";

// Read from here by ProjectView, which asks without opening the panel.
export { unsavedSettings };

export default function Settings({
  project, projects = [], onPatch, onDeleteProject, onSetStatus, hasRunningSession,
  payPeriod = null, companies = [], onSetPayPeriod, now = Date.now(), onSetTerms, onOpenSettings,
}) {
  const [form, setForm] = useState(() => restored(project, payPeriod));
  /**
   * What the ledger holds, in the same terms.
   *
   * Comparing against the project itself would not work: a target typed as
   * "120" comes back as the number 120, and a panel that decided it was still
   * unsaved would never put its Save button away.
   */
  const [saved, setSaved] = useState(() => formOf(project, payPeriod));
  const [confirming, setConfirming] = useState(false);
  /**
   * Whether the payday boxes have been changed since the last save. Until
   * they have, they follow the company named above; once they have, what was
   * set in them stands. Saving or discarding puts them back to following.
   * A draft kept from before the panel closed comes back as it was left, so
   * payday boxes changed then are still changed, and naming a company must
   * not put the saved schedule back over them.
   */
  const [periodTouched, setPeriodTouched] = useState(
    () => JSON.stringify(form.period) !== JSON.stringify(saved.period));
  useEffect(() => {
    if (form === saved) setPeriodTouched(false);
  }, [form, saved]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setPeriod = (patch) => {
    setPeriodTouched(true);
    setForm((f) => ({ ...f, period: { ...f.period, ...patch } }));
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  // Kept outside the panel for as long as anything is unsaved, and let go the
  // moment nothing is: saved, discarded, or typed back to what it was.
  useEffect(() => {
    keepDraft(project.id, dirty ? { form, saved } : null);
  }, [project.id, dirty, form, saved]);
  /**
   * The project changed underneath an untouched panel — an Undo of a change
   * that reached the past, or another device's edit arriving by sync — and
   * the panel follows it. Kept as it was it would show terms the project no
   * longer has as "Saved". A panel being edited keeps the edit.
   */
  const ledger = JSON.stringify(formOf(project, payPeriod));
  useEffect(() => {
    if (dirty) return;
    const held = JSON.parse(ledger);
    setSaved(held);
    setForm(held);
  }, [ledger]); // eslint-disable-line react-hooks/exhaustive-deps -- follows the ledger, never the draft

  const { name, company, rate, reward, each, perHour, period, sessionGoal, overallGoal } = form;
  const { limit, over, least } = form;
  // Not a number of hours: left as it is, and said so beside the box.
  const leastMs = readHours(least);

  /**
   * How far a change to the rate or the time limit reaches. Asked only when
   * one of them has changed, and not part of the form: it is a question
   * about the change, not a setting, and nothing is unsaved because of it.
   */
  const [scope, setScope] = useState(SCOPE.FORWARD);
  const limitHours = Number(limit);
  const overPct = over.trim() === "" ? 0 : Number(over);
  // A limit that is not a number above zero, or a share that is not a number
  // from zero up, would read as "no limit" and quietly lift the one there is.
  const limitRefused = limit.trim() !== "" && (!(limitHours > 0) || !(overPct >= 0));
  const rateChanged = !isOffClock(project) && rate !== saved.rate && Number(rate) > 0;
  const limitChanged = !isOffClock(project) && !limitRefused
    && (limit !== saved.limit || (limit.trim() !== "" && over !== saved.over));

  /**
   * The schedule belongs to the company, not to this project, so Save files
   * it under the company in the box: the one this project will belong to
   * once saved. Filing it under the company already saved lost it whenever
   * both changed in one Save — renaming Northwind to Outlier and moving the
   * cutoff wrote the cutoff to Northwind, and Outlier, with no schedule at
   * all, dropped every one of this project's paydays without a word. Nothing
   * is written until Save, so a half-typed name never reaches the ledger.
   *
   * The company saved before keeps its own schedule, for whatever other
   * projects it has.
   */
  const payee = companyOf(project);
  const target = company.trim();
  /** The schedule a company already has, as kept, or null: none, or no such
   *  company. */
  const scheduleOf = (name) =>
    storedPeriod(findCompany({ companies }, name)?.payPeriod) ?? null;
  /**
   * The company box, and the payday that goes with it. While the payday boxes
   * are untouched they follow the company named: one that already has a
   * schedule brings it, since joining a client means joining its paydays;
   * any other keeps the schedule shown, which Save then gives it — renaming
   * a company should not cost it its payday.
   */
  const setCompany = (next) => setForm((f) => {
    if (periodTouched) return { ...f, company: next };
    const theirs = fold(next) === fold(payee ?? "") ? null : scheduleOf(next);
    return { ...f, company: next, period: theirs ? periodForm(theirs) : saved.period };
  });
  const rule = periodOf(period);
  /**
   * Another company's schedule that Save would replace. It is shared by
   * every project under that company, so it is said here, before saving,
   * rather than overwritten silently.
   */
  const moving = target !== "" && fold(target) !== fold(payee ?? "");
  const theirs = moving ? scheduleOf(target) : null;
  const theirName = findCompany({ companies }, target)?.name ?? target;
  const clash = theirs !== null && !samePeriod(rule, theirs);
  const useTheirs = () => {
    setForm((f) => ({ ...f, period: periodForm(theirs) }));
    setPeriodTouched(false);
  };

  const asGoal = (goal) =>
    normaliseGoal(isOffClock(project) ? { ...goal, type: "time" } : goal);

  const save = () => {
    const parsed = Number(rate);
    /** The amount, but only for the model actually chosen. */
    const chosen = (kind, value) =>
      (reward === kind && Number.isFinite(value) && value > 0 ? value : null);
    onPatch({
      name: name.trim() || project.name,
      company: company.trim(),
      // A changed rate goes through `onSetTerms` below, because how far back
      // it reaches is part of the change.
      ...(Number.isFinite(parsed) && parsed > 0 && !(rateChanged && onSetTerms)
        ? { currentRate: parsed } : {}),
      // Cleared on purpose means cleared, and the model NOT chosen is always
      // cleared: null rather than skipped, so a project can stop being paid
      // per item, and can never hold two answers to what acceptance pays.
      // Only when the box changed, so a Save of something else writes nothing
      // on a project that has never had a minimum.
      ...(least !== saved.least && !Number.isNaN(leastMs)
        ? { taskMinMs: leastMs > 0 ? leastMs : null } : {}),
      bonusPerHour: chosen(REWARD.PER_HOUR, Number(perHour)),
      perTask: chosen(REWARD.PER_TASK, Number(each)),
      sessionGoal: asGoal(sessionGoal),
      overallGoal: asGoal(overallGoal),
    });
    // One Save for the panel, two writes underneath: the schedule is the
    // company's and outlives any one project, so it cannot ride along in the
    // project patch. It goes to the company in the box, created there if it
    // is new. "No schedule" for a company that has none has nothing to say,
    // and writes nothing rather than an empty record.
    if (target && (rule !== null || scheduleOf(target) !== null)) onSetPayPeriod?.(target, rule);
    if ((rateChanged || limitChanged) && onSetTerms) {
      onSetTerms({
        rate: rateChanged ? parsed : null,
        limit: limitChanged
          ? { ms: limit.trim() === "" ? null : Math.round(limitHours * HOUR), factor: overPct / 100 }
          : null,
      }, scope);
    }
    setScope(SCOPE.FORWARD);
    setSaved(form);
  };

  /** Enter saves, because a one-field change should not need the mouse. */
  const onKey = (e) => { if (e.key === "Enter" && dirty) save(); };

  return (
    <div className="panel">
      <label className="field">
        <span className="eyebrow">Project name</span>
        <input className="inp" value={name} onKeyDown={onKey}
               onChange={(e) => set({ name: e.target.value })} />
      </label>


      <RateTerms project={project} least={least} leastRefused={Number.isNaN(leastMs)} rate={rate} limit={limit} over={over} reward={reward}
                 each={each} perHour={perHour} set={set} onKey={onKey}
                 limitRefused={limitRefused} limitHours={limitHours} overPct={overPct}
                 rateChanged={rateChanged} limitChanged={limitChanged} scope={scope}
                 setScope={setScope} hasRunningSession={hasRunningSession} />

      <CompanyPayday project={project} projects={projects} company={company}
                     setCompany={setCompany} onKey={onKey} target={target} clash={clash}
                     theirName={theirName} theirs={theirs} useTheirs={useTheirs}
                     period={period} setPeriod={setPeriod} rule={rule} now={now}
                     onOpenSettings={onOpenSettings} />

      <div className="sec-head" style={{ marginTop: 22 }}>
        <span className="eyebrow">Session goal</span>
      </div>
      {goalFields(project, set, "sessionGoal", sessionGoal, false)}

      <div className="sec-head" style={{ marginTop: 10 }}>
        <span className="eyebrow">Overall goal</span>
      </div>
      {goalFields(project, set, "overallGoal", overallGoal, true)}

      {/*
        Everything above is typed, and nothing above is saved until this.
        Editing a rate used to take effect the moment focus left the box, which
        meant a half-typed "4" on the way to "45" was briefly the project's
        real rate — and a tab away at the wrong moment left it there.

        The three controls BELOW are deliberately still immediate. Each is one
        decisive click with a visible consequence, not something typed, and
        Status already offers an Undo of its own. Making them wait for a Save
        they do not need would teach the button to mean two different things.
      */}
      <div className={"savebar" + (dirty ? " on" : "")} aria-live="polite">
        {dirty ? (
          <>
            <span className="savebar-note">Unsaved changes</span>
            <button className="btn primary" onClick={save}>Save changes</button>
            <button className="btn ghost" onClick={() => setForm(saved)}>Discard</button>
          </>
        ) : (
          <span className="savebar-note quiet">Saved</span>
        )}
      </div>

      {/* The bar is the boundary between the two halves of this panel, and
          saying so is the difference between "nothing happened" and "it has
          already happened". Everything above is typed and staged; everything
          below is one click with an immediate consequence, which is why it
          has no Save of its own to go looking for. */}
      <p className="hint" style={{ marginTop: 10 }}>
        Everything above here is saved together with that button. Everything below takes
        effect the moment you press it.
      </p>

      <ProjectState project={project} onPatch={onPatch} onSetStatus={onSetStatus} />

      <Danger project={project} confirming={confirming} setConfirming={setConfirming}
              onDeleteProject={onDeleteProject} />
    </div>
  );
}
