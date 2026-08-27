import { useState } from "react";
import { elapsedMs, isRunning, startedAt } from "../domain/time.js";
import {
  earningsCents, formatDuration, formatMoney, formatShortDuration, moneyParts,
} from "../domain/money.js";
import { periodStart } from "../domain/goals.js";
import { GoalBar } from "./parts.jsx";
import Settings from "./Settings.jsx";

const MS_PER_HOUR = 3_600_000;
const time = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const date = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export default function ProjectView({
  project, sessions, current, now,
  onStart, onPause, onResume, onStop, onDeleteSession, onPatch, onDeleteProject,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const running = current && isRunning(current);

  const shownMs = current ? elapsedMs(current, now) : 0;
  const currency = current?.currency ?? project.currency;
  const { head, tail } = moneyParts(current ? earningsCents(current, shownMs) : 0, currency);

  const minuteInHour = Math.floor((shownMs % MS_PER_HOUR) / 60_000);
  const hoursBilled = Math.floor(shownMs / MS_PER_HOUR);

  const totalCents = sessions.reduce((a, s) => a + earningsCents(s, elapsedMs(s, now)), 0);
  const totalMs = sessions.reduce((a, s) => a + elapsedMs(s, now), 0);

  const { sessionGoal, overallGoal } = project;
  const periodSessions = overallGoal
    ? sessions.filter((s) => startedAt(s) >= periodStart(overallGoal.period, now))
    : [];
  const periodCents = periodSessions.reduce((a, s) => a + earningsCents(s, elapsedMs(s, now)), 0);
  const periodMs = periodSessions.reduce((a, s) => a + elapsedMs(s, now), 0);

  const ordered = [...sessions].sort((a, b) => startedAt(b) - startedAt(a));

  return (
    <>
      <div className="face">
        <div className="face-top">
          <div>
            <div className="plate-name">{project.name}</div>
            <div className="plate-rate">
              {formatMoney(Math.round((current?.rate ?? project.currentRate) * 100), currency)} per hour
              {current && current.rate !== project.currentRate && " · rate locked for this session"}
            </div>
          </div>
          <span className={`state${running ? " on" : ""}`}>
            {running ? "Running" : current ? "Paused" : "Stopped"}
          </span>
        </div>

        <div className="money">
          <span className="money-head">{head}</span>
          {tail !== null && <span className="money-tail">{tail}</span>}
        </div>

        <div className="clock">
          <span className="clock-main">{formatDuration(shownMs)}</span>
          <span className="clock-note">
            {current ? `started ${time(startedAt(current))}` : "meter is idle"}
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

        <div className="controls">
          {!current && <button className="btn primary" onClick={onStart}>Start the meter</button>}
          {running && (
            <>
              <button className="btn ghost" onClick={onPause}>Pause</button>
              <button className="btn primary" onClick={onStop}>Stop and save</button>
            </>
          )}
          {current && !running && (
            <>
              <button className="btn primary" onClick={onResume}>Resume</button>
              <button className="btn ghost" onClick={onStart}>New session</button>
            </>
          )}
        </div>
      </div>

      {(sessionGoal || overallGoal) && (
        <div className="sec">
          <div className="sec-head"><span className="eyebrow">Goals</span></div>
          <div className="panel">
            {sessionGoal && (
              <GoalBar label="This session" type={sessionGoal.type} target={sessionGoal.target}
                       currency={currency}
                       value={sessionGoal.type === "money"
                         ? (current ? earningsCents(current, shownMs) : 0) / 100
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

      <div className="sec">
        <div className="sec-head">
          <span className="eyebrow">Ledger</span>
          <span className="eyebrow">
            {formatMoney(totalCents, project.currency)} · {totalMs ? formatShortDuration(totalMs) : "0m"}
          </span>
        </div>
        <div className="panel">
          {ordered.length === 0 ? (
            <div className="empty">No sessions yet. Start the meter and this fills in.</div>
          ) : ordered.map((s) => (
            <div className="row" key={s.id}>
              <div>
                <div className="row-when">
                  {date(startedAt(s))} · {time(startedAt(s))}{isRunning(s) && " · running"}
                </div>
                <div className="row-meta">
                  {formatDuration(elapsedMs(s, now))} at{" "}
                  {formatMoney(Math.round(s.rate * 100), s.currency)}/hr
                  {s.segments.length > 1 && ` · ${s.segments.length} blocks`}
                </div>
              </div>
              <span className="row-amt">{formatMoney(earningsCents(s, elapsedMs(s, now)), s.currency)}</span>
              <button className="x" aria-label="Remove session" onClick={() => onDeleteSession(s.id)}>×</button>
            </div>
          ))}
        </div>
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
