import { useState } from "react";
import { normaliseGoal } from "../domain/goals.js";
import { companiesIn, companyOf, isOffClock, statusOf } from "../domain/projects.js";
import { REWARD, bonusPerHour, paysOnAcceptance, perTask, rewardModel } from "../domain/earnings.js";
import { formatMoney } from "../domain/money.js";

/**
 * What the form holds, in the shape the inputs want — strings, because that is
 * what was typed. Kept beside what was last saved so the panel can say whether
 * there is anything to save, without having to guess how the ledger normalised
 * the last answer.
 */
const formOf = (project) => ({
  name: project.name,
  company: companyOf(project) ?? "",
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

export default function Settings({
  project, projects = [], onPatch, onDeleteProject, onSetStatus, hasRunningSession,
}) {
  const [form, setForm] = useState(() => formOf(project));
  /**
   * What the ledger holds, in the same terms.
   *
   * Comparing against the project itself would not work: a target typed as
   * "120" comes back as the number 120, and a panel that decided it was still
   * unsaved would never put its Save button away.
   */
  const [saved, setSaved] = useState(() => formOf(project));
  const [confirming, setConfirming] = useState(false);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);

  const { name, company, rate, reward, each, perHour, sessionGoal, overallGoal } = form;
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
                   onChange={(e) => set({ company: e.target.value })} />
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
            Paid once accepted means new sessions start out <strong>pending</strong>: their money
            is reported on its own line rather than in your earnings. Submitting the task settles
            it — delivering the work is what earns the hourly money — and the acceptance reward
            waits separately until you hear back.
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
              + "closing summary. Both leave Targets and stop the meter; neither hides any history."}
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
            <button className="btn danger" onClick={onDeleteProject}>Yes, delete it</button>
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
