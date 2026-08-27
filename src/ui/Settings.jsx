import { useState } from "react";
import { normaliseGoal } from "../domain/goals.js";

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

  const saveGoal = (key, goal) => onPatch({ [key]: normaliseGoal(goal) });

  const goalFields = (key, goal, setGoal, withPeriod) => (
    <div className="pair">
      <label className="field">
        <span className="eyebrow">Measure</span>
        <select className="inp" value={goal.type}
                onChange={(e) => { const next = { ...goal, type: e.target.value }; setGoal(next); saveGoal(key, next); }}>
          <option value="money">Money earned</option>
          <option value="time">Minutes worked</option>
        </select>
      </label>
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

      <label className="field">
        <span className="eyebrow">Hourly rate ({project.currency})</span>
        <input className="inp" type="number" min="0" step="any" value={rate}
               onChange={(e) => setRate(e.target.value)} onBlur={saveBasics} />
      </label>
      <div className="hint">
        A new rate applies to sessions you start from now on. Everything already in the ledger keeps
        the rate it was recorded at{hasRunningSession ? ", including the one running right now" : ""}.
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
