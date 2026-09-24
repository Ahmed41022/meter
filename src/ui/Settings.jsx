import { useState } from "react";
import { normaliseGoal } from "../domain/goals.js";
import { isOffClock } from "../domain/projects.js";

export default function Settings({ project, onPatch, onDeleteProject, hasRunningSession }) {
  const [name, setName] = useState(project.name);
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

      <div className="sec-head" style={{ marginTop: 12 }}>
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
