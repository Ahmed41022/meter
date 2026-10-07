import { useEffect, useState } from "react";
import { normaliseGoal } from "../domain/goals.js";
import { companiesIn, companyOf, fold, isOffClock, statusOf } from "../domain/projects.js";
import { REWARD, bonusPerHour, paysOnAcceptance, perTask, rewardModel } from "../domain/earnings.js";
import { formatMoney } from "../domain/money.js";
import {
  PERIOD, WEEKDAYS, describePeriod, findCompany, knownZone, nextClose, paydayFor,
  samePeriod, storedPeriod,
} from "../domain/payPeriod.js";

/**
 * What the form holds, in the shape the inputs want — strings, because that is
 * what was typed. Kept beside what was last saved so the panel can say whether
 * there is anything to save, without having to guess how the ledger normalised
 * the last answer.
 */
/** A minute of the day as `<input type="time">` wants it, and back. */
const timeText = (minutes) => `${String(Math.floor((minutes ?? 0) / 60)).padStart(2, "0")}`
  + `:${String((minutes ?? 0) % 60).padStart(2, "0")}`;
const minutesOf = (text) => {
  const [h, m] = String(text ?? "").split(":");
  const n = Number(h) * 60 + Number(m);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The clocks a cutoff can be read on.
 *
 * The device's own comes first, because that is what a rule with no zone
 * means and what most people want. Then the handful the platforms actually
 * quote their cutoffs in, then everything the browser knows — four hundred
 * entries nobody scrolls through, but the one zone somebody needs is always
 * among them, and a select types ahead.
 */
const QUOTED_ZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "UTC", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Singapore",
  "Australia/Sydney",
];
const localZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
};
const allZones = () => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return QUOTED_ZONES;
  }
};
const ZONES = allZones();
const HERE = localZone();

/** A schedule in the shape the selects want, with both kinds' answers kept
 *  side by side so switching between them to compare loses neither. */
const periodForm = (rule) => ({
  kind: rule?.kind ?? "none",
  weeklyCutoff: rule?.kind === PERIOD.WEEKLY ? rule.cutoff : 1,
  weeklyPayday: rule?.kind === PERIOD.WEEKLY ? rule.payday : 3,
  monthlyCutoff: rule?.kind === PERIOD.MONTHLY ? String(rule.cutoff) : "1",
  monthlyPayday: rule?.kind === PERIOD.MONTHLY ? String(rule.payday) : "15",
  after: rule?.after ?? 0,
  // Shared by both kinds: when in the day the period closes, and on whose
  // clock. Empty means this device's, which is what an unset rule has always
  // meant.
  closesAt: timeText(rule?.closesAt ?? 0),
  zone: rule?.zone ?? "",
});

/** The selects back into a rule the domain will accept, or null for none. */
const periodOf = (f) => {
  const when = { closesAt: minutesOf(f.closesAt), zone: f.zone || null };
  if (f.kind === PERIOD.WEEKLY) {
    return {
      kind: PERIOD.WEEKLY, cutoff: f.weeklyCutoff, payday: f.weeklyPayday,
      after: f.after, ...when,
    };
  }
  if (f.kind === PERIOD.MONTHLY) {
    return {
      kind: PERIOD.MONTHLY,
      cutoff: Number(f.monthlyCutoff),
      payday: Number(f.monthlyPayday),
      after: f.after,
      ...when,
    };
  }
  return null;
};

const formOf = (project, payPeriod) => ({
  name: project.name,
  company: companyOf(project) ?? "",
  period: periodForm(payPeriod),
  rate: String(project.currentRate),
  /**
   * Which reward system acceptance pays under, with the amount for each kind
   * kept side by side. Two boxes rather than one, so flipping between them to
   * compare does not throw away the figure already typed into the other.
   */
  reward: rewardModel(project) ?? "none",
  each: perTask(project) === null ? "" : String(perTask(project)),
  perHour: bonusPerHour(project) === null ? "" : String(bonusPerHour(project)),
  sessionGoal: project.sessionGoal || { type: "money", target: "" },
  overallGoal: project.overallGoal || { type: "money", target: "", period: "week" },
});

/**
 * Settings typed and not yet saved, by project, kept outside the panel.
 *
 * The panel goes away whenever it is closed or its project is left, and a
 * draft held only in its own state would go with it: a rename typed in, then
 * "← All projects", and the project is back to its old name with nothing
 * said. These boxes used to save as focus left them, so leaving straight
 * after typing is an easy habit to have. Kept here, the draft is waiting when
 * the panel opens again, the closed panel's header says it is there, and
 * closing the window asks first.
 */
const drafts = new Map();

/** Whether a project has settings typed and not saved. */
export const unsavedSettings = (projectId) => drafts.has(projectId);

/**
 * The window is about to go, and every draft with it, so the browser is asked
 * to check with the user first. Inside the desktop app the shell hears the
 * same objection and asks in a dialog of its own (desktop/unsaved.js), since
 * Electron on its own would just refuse to close and say nothing.
 */
const askBeforeLeaving = (e) => {
  e.preventDefault();
  e.returnValue = true; // how older browsers were asked the same thing
};
let asking = false;
const keepDraft = (projectId, draft) => {
  if (draft) drafts.set(projectId, draft);
  else drafts.delete(projectId);
  const ask = drafts.size > 0;
  if (ask === asking) return;
  window[ask ? "addEventListener" : "removeEventListener"]("beforeunload", askBeforeLeaving);
  asking = ask;
};

/**
 * The panel as the project stands now, with a kept draft laid back over it.
 *
 * Only the fields that were edited come back. Every other one is read
 * afresh, so a change that arrived in the meantime — from the other device,
 * say — is not quietly undone by the next Save.
 */
const restored = (project, payPeriod) => {
  const fresh = formOf(project, payPeriod);
  const kept = drafts.get(project.id);
  if (!kept) return fresh;
  const edited = (key) => JSON.stringify(kept.form[key]) !== JSON.stringify(kept.saved[key]);
  return Object.fromEntries(
    Object.keys(fresh).map((key) => [key, edited(key) ? kept.form[key] : fresh[key]]),
  );
};

export default function Settings({
  project, projects = [], onPatch, onDeleteProject, onSetStatus, hasRunningSession,
  payPeriod = null, companies = [], onSetPayPeriod, now = Date.now(),
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

  const { name, company, rate, reward, each, perHour, period, sessionGoal, overallGoal } = form;

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
  const example = describePeriod(rule);
  // A date on the rule's own clock, printed as that date. Converted through
  // this device's clock, a payday in a zone east of here read a day early.
  const nextOne = rule ? paydayFor(rule, now) : null;
  /**
   * The cutoff instant on this device's clock, where that is worth saying.
   *
   * Only when another zone is named and it is not this one: "19:00 your time
   * is 19:00 your time" is noise, and the whole point of printing it is the
   * cases where seven in the evening is two in the morning. Never for a zone
   * this browser cannot read, whose hour it has no way to convert.
   */
  const zoneUnknown = period.zone !== "" && knownZone(period.zone) === null;
  const closesHere = period.zone && period.zone !== HERE && !zoneUnknown
    ? nextClose(rule, now) : null;
  // A rate that is not a number above zero has never been applied, and with an
  // explicit Save that silence would read as the button not working.
  const rateRefused = !isOffClock(project) && rate.trim() !== "" && !(Number(rate) > 0);

  /**
   * The arithmetic spelled out. "+10/hr" is precisely the thing that reads as
   * "+10 per task" to anyone who has met the other reward system, and getting
   * that wrong is what this whole setting exists to fix — so the panel shows
   * 80 and 10 becoming 90 rather than leaving it to be inferred.
   */
  const asMoney = (n) => formatMoney(Math.round(n * 100), project.currency);
  const rateNum = Number(rate);
  const upliftNum = Number(perHour);
  const previewable = Number.isFinite(rateNum) && rateNum > 0
    && Number.isFinite(upliftNum) && upliftNum > 0;
  const ratePreview = previewable ? asMoney(rateNum) : null;
  const upliftPreview = previewable ? asMoney(upliftNum) : null;
  const totalPreview = previewable ? asMoney(rateNum + upliftNum) : null;

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
      ...(Number.isFinite(parsed) && parsed > 0 ? { currentRate: parsed } : {}),
      // Cleared on purpose means cleared, and the model NOT chosen is always
      // cleared: null rather than skipped, so a project can stop being paid
      // per item, and can never hold two answers to what acceptance pays.
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
    setSaved(form);
  };

  const goalFields = (key, goal, withPeriod) => (
    <div className="pair">
      {/* Off the clock there is nothing to earn, so time is the only measure
          on offer rather than a money option that could never move. */}
      {isOffClock(project) ? (
        <label className="field">
          <span className="eyebrow">Measure</span>
          <input className="inp" value="Minutes tracked" disabled readOnly />
        </label>
      ) : (
        <label className="field">
          <span className="eyebrow">Measure</span>
          <select className="inp" value={goal.type}
                  onChange={(e) => set({ [key]: { ...goal, type: e.target.value } })}>
            <option value="money">Money earned</option>
            <option value="time">Minutes worked</option>
          </select>
        </label>
      )}
      {withPeriod && (
        <label className="field">
          <span className="eyebrow">Resets</span>
          <select className="inp" value={goal.period}
                  onChange={(e) => set({ [key]: { ...goal, period: e.target.value } })}>
            <option value="week">Every Monday</option>
            <option value="month">Every 1st</option>
            <option value="lifetime">Never</option>
          </select>
        </label>
      )}
      <label className="field">
        <span className="eyebrow">Target</span>
        <input className="inp" type="number" min="0" step="any" placeholder="empty = no goal"
               value={goal.target}
               onChange={(e) => set({ [key]: { ...goal, target: e.target.value } })} />
      </label>
    </div>
  );

  /** Enter saves, because a one-field change should not need the mouse. */
  const onKey = (e) => { if (e.key === "Enter" && dirty) save(); };

  return (
    <div className="panel">
      <label className="field">
        <span className="eyebrow">Project name</span>
        <input className="inp" value={name} onKeyDown={onKey}
               onChange={(e) => set({ name: e.target.value })} />
      </label>

      {/* Off the clock replaces the rate rather than sitting beside it. A rate
          on something that never earns is the thing this setting exists to
          stop people faking with 0.00001. */}
      {isOffClock(project) ? (
        <div className="hint" style={{ marginTop: 0 }}>
          This isn&apos;t work, so it has no rate. Its hours are tracked and reported on their
          own, and never counted into earnings, billable share, or the project breakdown.
        </div>
      ) : (
        <>
          <label className="field">
            <span className="eyebrow">Hourly rate ({project.currency})</span>
            <input className="inp" type="number" min="0" step="any" value={rate}
                   onKeyDown={onKey} onChange={(e) => set({ rate: e.target.value })} />
          </label>
          <div className="sec-head" style={{ marginTop: 18 }}>
            <span className="eyebrow">Acceptance reward</span>
          </div>
          {/* The two reward systems are alternatives, not options to combine:
              a project holding both would have two answers to "what does
              acceptance pay". Picking one clears the other on save. */}
          <div className="modes" role="tablist" aria-label="What acceptance pays">
            {[
              ["none", "Nothing"],
              [REWARD.PER_TASK, "A flat amount"],
              [REWARD.PER_HOUR, "More per hour"],
            ].map(([key, label]) => (
              <button key={key} role="tab" aria-selected={reward === key}
                      className={"seg-btn" + (reward === key ? " on" : "")}
                      onClick={() => set({ reward: key })}>
                {label}
              </button>
            ))}
          </div>

          {reward === REWARD.PER_TASK && (
            <label className="field" style={{ marginTop: 14 }}>
              <span className="eyebrow">Per accepted task ({project.currency})</span>
              <input className="inp" type="number" min="0" step="any"
                     placeholder="what one accepted item pays"
                     value={each} onKeyDown={onKey}
                     onChange={(e) => set({ each: e.target.value })} />
            </label>
          )}
          {reward === REWARD.PER_HOUR && (
            <label className="field" style={{ marginTop: 14 }}>
              <span className="eyebrow">Extra per hour once accepted ({project.currency})</span>
              <input className="inp" type="number" min="0" step="any"
                     placeholder="on top of the hourly rate"
                     value={perHour} onKeyDown={onKey}
                     onChange={(e) => set({ perHour: e.target.value })} />
            </label>
          )}

          <div className="hint">
            {reward === REWARD.PER_HOUR ? (
              <>
                Paid <strong>for every hour worked on the task</strong>, not once per task.
                {upliftPreview && <> At {ratePreview} plus {upliftPreview} an hour, accepted
                  work comes to {totalPreview} an hour, and a task that took twice as long is
                  worth twice as much.</>}
                {" "}Submitting files it as pending; marking the task accepted pays it.
              </>
            ) : reward === REWARD.PER_TASK ? (
              <>
                One flat amount per accepted item, however long it took — a task can override it
                with its own price. Submitting files it as pending; marking the task accepted
                pays it.
              </>
            ) : (
              <>
                Acceptance pays nothing extra here; the hourly rate is the whole of it. You can
                still record a one-off reward across a batch of tasks from the task list.
              </>
            )}
          </div>
          <div className="hint">
            A new rate applies to sessions you start from now on. Everything already in the ledger keeps
            the rate it was recorded at{hasRunningSession ? ", including the one running right now" : ""}.
          </div>
          {rateRefused && (
            <div className="hint warn">
              An hourly rate has to be a number above zero, so this one will be left as it is.
              To stop charging by the hour, set this project off the clock or price it per task.
            </div>
          )}
        </>
      )}

      {/* Off the clock has no client. A company on sleep would be a category
          error, and it would then turn up in the revenue breakdown. */}
      {!isOffClock(project) && (
        <>
          <label className="field">
            <span className="eyebrow">Company</span>
            <input className="inp" value={company} list="meter-companies"
                   placeholder="who it's for — optional" onKeyDown={onKey}
                   onChange={(e) => setCompany(e.target.value)} />
          </label>
          {/* Suggestions from what you have already typed: the list is what
              stops "Northwind" and "northwind" becoming two clients. */}
          <datalist id="meter-companies">
            {companiesIn(projects).map((c) => <option key={c} value={c} />)}
          </datalist>
          <div className="hint">
            Projects sharing a company are totalled together on the Overview — what each
            one earned, the hours, and what an hour actually came to across all of them.
          </div>

          <div className="sec-head" style={{ marginTop: 22 }}>
            <span className="eyebrow">Payday</span>
            {target && <span className="eyebrow">{target}</span>}
          </div>
          {!target ? (
            <div className="hint" style={{ marginTop: 0 }}>
              A payday belongs to the client, not to one project, so name the company above
              — then its schedule can be set here and every project under it will use the
              same one.
            </div>
          ) : (
            <>
              {/* Said before Save, because the schedule is shared: saving
                  would change the paydays of every project under that
                  company, not only this one. */}
              {clash && (
                <div className="hint warn" style={{ marginTop: 0 }}>
                  {theirName} already has a payday of its own:{" "}
                  <strong>{describePeriod(theirs)}</strong> It is shared by every {theirName}{" "}
                  project, so saving puts the schedule below in its place for all of them.{" "}
                  <button className="linkish" onClick={useTheirs}>
                    Use {theirName}&apos;s instead
                  </button>
                </div>
              )}
              <div className="modes" role="tablist" aria-label="How this client pays">
                {[["none", "No schedule"], [PERIOD.WEEKLY, "Weekly"], [PERIOD.MONTHLY, "Monthly"]]
                  .map(([key, label]) => (
                    <button key={key} role="tab" aria-selected={period.kind === key}
                            className={"seg-btn" + (period.kind === key ? " on" : "")}
                            onClick={() => setPeriod({ kind: key })}>
                      {label}
                    </button>
                  ))}
              </div>

              {period.kind === PERIOD.WEEKLY && (
                <div className="pair" style={{ marginTop: 14 }}>
                  <label className="field">
                    <span className="eyebrow">Work in before</span>
                    <select className="inp" value={period.weeklyCutoff}
                            onChange={(e) => setPeriod({ weeklyCutoff: Number(e.target.value) })}>
                      {WEEKDAYS.map(([n, label]) => <option key={n} value={n}>{label}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span className="eyebrow">Is paid on</span>
                    <select className="inp" value={period.weeklyPayday}
                            onChange={(e) => setPeriod({ weeklyPayday: Number(e.target.value) })}>
                      {WEEKDAYS.map(([n, label]) => <option key={n} value={n}>{label}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span className="eyebrow">Which one</span>
                    <select className="inp" value={period.after}
                            onChange={(e) => setPeriod({ after: Number(e.target.value) })}>
                      <option value={0}>The following one</option>
                      <option value={1}>A week after that</option>
                      <option value={2}>Two weeks after that</option>
                    </select>
                  </label>
                </div>
              )}

              {period.kind === PERIOD.MONTHLY && (
                <div className="pair" style={{ marginTop: 14 }}>
                  <label className="field">
                    <span className="eyebrow">Work in before the</span>
                    <input className="inp" type="number" min="1" max="31" step="1"
                           value={period.monthlyCutoff} onKeyDown={onKey}
                           onChange={(e) => setPeriod({ monthlyCutoff: e.target.value })} />
                  </label>
                  <label className="field">
                    <span className="eyebrow">Is paid on the</span>
                    <input className="inp" type="number" min="1" max="31" step="1"
                           value={period.monthlyPayday} onKeyDown={onKey}
                           onChange={(e) => setPeriod({ monthlyPayday: e.target.value })} />
                  </label>
                  <label className="field">
                    <span className="eyebrow">Which one</span>
                    <select className="inp" value={period.after}
                            onChange={(e) => setPeriod({ after: Number(e.target.value) })}>
                      <option value={0}>The next one</option>
                      <option value={1}>A month after that</option>
                      <option value={2}>Two months after that</option>
                    </select>
                  </label>
                </div>
              )}

              {/* When in the day the period shuts, and on whose clock.
                  Shared by both kinds, because both have the same problem:
                  "closes Sunday 7pm Eastern" is an instant, and read on the
                  wrong clock it is hours out — which for a cutoff is not
                  hours, it is a whole payday. */}
              {period.kind !== "none" && (
                <div className="pair" style={{ marginTop: 14 }}>
                  <label className="field">
                    <span className="eyebrow">Closing at</span>
                    <input className="inp" type="time" value={period.closesAt}
                           onChange={(e) => setPeriod({ closesAt: e.target.value })} />
                  </label>
                  <label className="field">
                    <span className="eyebrow">By which clock</span>
                    <select className="inp" value={period.zone}
                            onChange={(e) => setPeriod({ zone: e.target.value })}>
                      <option value="">Mine{HERE ? ` — ${HERE}` : ""}</option>
                      {/* The zone saved, where neither list has it: without
                          an option of its own the box would show "Mine" and
                          the next Save would erase it. */}
                      {period.zone && !QUOTED_ZONES.includes(period.zone)
                        && !ZONES.includes(period.zone) && (
                        <option value={period.zone}>
                          {zoneUnknown ? `${period.zone} (not known here)` : period.zone}
                        </option>
                      )}
                      <optgroup label="Commonly quoted">
                        {QUOTED_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                      </optgroup>
                      <optgroup label="Everywhere else">
                        {ZONES.filter((z) => !QUOTED_ZONES.includes(z))
                          .map((z) => <option key={z} value={z}>{z}</option>)}
                      </optgroup>
                    </select>
                  </label>
                </div>
              )}
              {/* Kept, not dropped: it is still the client's clock, and the
                  device that set it may know it. Saying so is the difference
                  between a payday an hour out and one nobody can explain. */}
              {period.kind !== "none" && zoneUnknown && (
                <div className="hint warn">
                  {period.zone} isn&apos;t known to this browser, so paydays are worked out on
                  this device&apos;s clock until it is. It stays saved as it is unless you pick
                  another clock.
                </div>
              )}

              {/* Read back in words, with a real date against it. A schedule
                  you cannot check is a schedule you cannot tell you have set
                  up backwards, and the two weekday boxes are easy to swap. */}
              <div className="hint">
                {example ? (
                  <>
                    <strong>{example}</strong>{" "}
                    {/* Dated as Upcoming payments dates it: by the ANSWER where
                        this project pays once accepted, by the hand-in where it
                        pays as worked and nothing waits on an answer. */}
                    {nextOne !== null && (
                      <>{paysOnAcceptance(project) ? "A task accepted" : "Work handed in"} right
                        now would be paid on{" "}
                        <strong>{new Date(`${nextOne.date}T00:00:00Z`).toLocaleDateString(undefined, {
                          timeZone: "UTC", weekday: "long", day: "numeric", month: "long",
                        })}</strong>.{" "}</>
                    )}
                    {paysOnAcceptance(project)
                      ? "This project pays once accepted, so a task is paid in the run for the "
                        + "period its answer fell in, hours and acceptance reward together — one "
                        + "accepted after its own period shut rides the next run. Work nobody has "
                        + "reviewed yet has no date at all, only the soonest it could arrive."
                      : "This project pays as worked, so a task is paid in the run for the "
                        + "period it was handed in, answered or not. A rejection takes it back."}
                    {closesHere !== null && (
                      <>
                        {" "}The cutoff is read in {period.zone}, so the period you are in
                        now shuts at{" "}
                        <strong>{new Date(closesHere).toLocaleString(undefined, {
                          weekday: "long", hour: "2-digit", minute: "2-digit",
                        })}</strong>{" "}
                        your time — that instant, not the hour you typed.
                      </>
                    )}
                  </>
                ) : (
                  <>
                    No schedule, so nothing is forecast for {target}. Set one and the Overview
                    will say what lands and when.
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}

      <div className="sec-head" style={{ marginTop: 22 }}>
        <span className="eyebrow">Session goal</span>
      </div>
      {goalFields("sessionGoal", sessionGoal, false)}

      <div className="sec-head" style={{ marginTop: 10 }}>
        <span className="eyebrow">Overall goal</span>
      </div>
      {goalFields("overallGoal", overallGoal, true)}

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

      <div className="sec-head" style={{ marginTop: 22 }}>
        <span className="eyebrow">Counts as</span>
      </div>
      {/* One choice between two states, so a segmented control — `.btn` grows
          to fill its row, which turned a toggle into two slabs the size of
          Save buttons. */}
      <div className="modes" role="tablist" aria-label="How this project counts">
        <button role="tab" aria-selected={!isOffClock(project)}
                className={"seg-btn" + (isOffClock(project) ? "" : " on")}
                onClick={() => onPatch({ offClock: false })}>
          Paid work
        </button>
        <button role="tab" aria-selected={isOffClock(project)}
                className={"seg-btn" + (isOffClock(project) ? " on" : "")}
                onClick={() => onPatch({ offClock: true })}>
          Off the clock
        </button>
      </div>
      <div className="hint">
        Off the clock is for what you track but don&apos;t work: sleep, play, time away. The hours
        stay recorded and get their own panel; they never reach an earnings figure.
      </div>

      {!isOffClock(project) && (
        <>
          <div className="sec-head" style={{ marginTop: 22 }}>
            <span className="eyebrow">When it pays</span>
          </div>
          <div className="modes" role="tablist" aria-label="When this project pays">
            <button role="tab" aria-selected={!paysOnAcceptance(project)}
                    className={"seg-btn" + (paysOnAcceptance(project) ? "" : " on")}
                    onClick={() => onPatch({ paysOnAcceptance: false })}>
              As worked
            </button>
            <button role="tab" aria-selected={paysOnAcceptance(project)}
                    className={"seg-btn" + (paysOnAcceptance(project) ? " on" : "")}
                    onClick={() => onPatch({ paysOnAcceptance: true })}>
              Once accepted
            </button>
          </div>
          <div className="hint">
            Paid once accepted means nothing counts as earned until somebody says yes. Sessions
            start out <strong>pending</strong> and stay that way when you submit, reported on
            their own line rather than in your earnings; the acceptance reward waits beside them.
            Accepting pays both. A rejection cancels both, and the hours stay on the record with
            their time and without their money.
          </div>
        </>
      )}

      <div className="sec-head" style={{ marginTop: 22 }}>
        <span className="eyebrow">Status</span>
      </div>
      {/* Three states, one control — two checkboxes could express "paused and
          done", which is not a thing a project can be. */}
      <div className="modes" role="tablist" aria-label="Project status">
        {[["active", "Running"], ["paused", "Paused"], ["done", "Done"]].map(([key, label]) => (
          <button key={key} role="tab" aria-selected={statusOf(project) === key}
                  className={"seg-btn" + (statusOf(project) === key ? " on" : "")}
                  onClick={() => onSetStatus(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="hint">
        {statusOf(project) === "done"
          ? "Finished. It has left the Targets panel and won't take new time, and its page now "
            + "reports what it came to. Every hour it recorded is still in your history."
          : statusOf(project) === "paused"
            ? "On hold. It stays where it is but has left the Targets panel and won't take new "
              + "time — set it running again when you come back to it."
            : "Paused keeps it in place for work that has gone quiet. Done files it away with a "
              + "closing summary. Both leave Targets and take no new time, though a meter already "
              + "running keeps going until you stop it; neither hides any history."}
      </div>

      <div className="sec-head" style={{ marginTop: 22 }}>
        <span className="eyebrow">Danger</span>
      </div>
      {confirming ? (
        <>
          <div className="hint">
            This removes {project.name} and every session recorded against it. You&apos;ll get one chance to undo.
          </div>
          <div className="controls">
            <button className="btn danger" onClick={() => { keepDraft(project.id, null); onDeleteProject(); }}>
              Yes, delete it
            </button>
            <button className="btn ghost" onClick={() => setConfirming(false)}>Keep it</button>
          </div>
        </>
      ) : (
        <div className="controls">
          <button className="btn danger" onClick={() => setConfirming(true)}>Delete project</button>
        </div>
      )}
    </div>
  );
}
