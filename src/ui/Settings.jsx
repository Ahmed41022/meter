import { useState } from "react";
import { normaliseGoal } from "../domain/goals.js";
import { companiesIn, companyOf, isOffClock, statusOf } from "../domain/projects.js";

export default function Settings({
  project, projects = [], onPatch, onDeleteProject, onSetStatus, hasRunningSession,
}) {
  const [name, setName] = useState(project.name);
  const [company, setCompany] = useState(companyOf(project) ?? "");
  const [rate, setRate] = useState(String(project.currentRate));
  const [sessionGoal, setSessionGoal] = useState(project.sessionGoal || { type: "money", target: "" });
  const [overallGoal, setOverallGoal] = useState(
    project.overallGoal || { type: "money", target: "", period: "week" }
  );
  const [confirming, setConfirming] = useState(false);

  const saveBasics = () => {
    const parsed = Number(rate);
    onPatch({
      name: name.trim() || project.name,
      ...(Number.isFinite(parsed) && parsed > 0 ? { currentRate: parsed } : {}),
    });
  };

  const saveGoal = (key, goal) =>
    onPatch({ [key]: normaliseGoal(isOffClock(project) ? { ...goal, type: "time" } : goal) });

  const goalFields = (key, goal, setGoal, withPeriod) => (
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
                  onChange={(e) => { const next = { ...goal, type: e.target.value }; setGoal(next); saveGoal(key, next); }}>
            <option value="money">Money earned</option>
            <option value="time">Minutes worked</option>
          </select>
        </label>
      )}
      {withPeriod && (
        <label className="field">
          <span className="eyebrow">Resets</span>
          <select className="inp" value={goal.period}
                  onChange={(e) => { const next = { ...goal, period: e.target.value }; setGoal(next); saveGoal(key, next); }}>
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
               onChange={(e) => setGoal({ ...goal, target: e.target.value })}
               onBlur={() => saveGoal(key, goal)} />
      </label>
    </div>
  );

  return (
    <div className="panel">
      <label className="field">
        <span className="eyebrow">Project name</span>
        <input className="inp" value={name} onChange={(e) => setName(e.target.value)} onBlur={saveBasics} />
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
                   onChange={(e) => setRate(e.target.value)} onBlur={saveBasics} />
          </label>
          <div className="hint">
            A new rate applies to sessions you start from now on. Everything already in the ledger keeps
            the rate it was recorded at{hasRunningSession ? ", including the one running right now" : ""}.
          </div>
        </>
      )}

      {/* Off the clock has no client. A company on sleep would be a category
          error, and it would then turn up in the revenue breakdown. */}
      {!isOffClock(project) && (
        <>
          <label className="field">
            <span className="eyebrow">Company</span>
            <input className="inp" value={company} list="meter-companies"
                   placeholder="who it's for — optional"
                   onChange={(e) => setCompany(e.target.value)}
                   onBlur={() => onPatch({ company: company.trim() })} />
          </label>
          {/* Suggestions from what you have already typed: the list is what
              stops "Outlier" and "outlier" becoming two clients. */}
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
        <span className="eyebrow">Counts as</span>
      </div>
      {/* One choice between two states, so a segmented control — `.btn` grows
          to fill its row, which turned a toggle into two slabs the size of
          Save buttons. */}
      <div className="seg" role="tablist" aria-label="How this project counts">
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

      <div className="sec-head" style={{ marginTop: 22 }}>
        <span className="eyebrow">Session goal</span>
      </div>
      {goalFields("sessionGoal", sessionGoal, setSessionGoal, false)}

      <div className="sec-head" style={{ marginTop: 10 }}>
        <span className="eyebrow">Overall goal</span>
      </div>
      {goalFields("overallGoal", overallGoal, setOverallGoal, true)}

      <div className="sec-head" style={{ marginTop: 22 }}>
        <span className="eyebrow">Status</span>
      </div>
      {/* Three states, one control — two checkboxes could express "paused and
          done", which is not a thing a project can be. */}
      <div className="seg" role="tablist" aria-label="Project status">
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
