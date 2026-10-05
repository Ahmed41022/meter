import { useState } from "react";
import { elapsedMs, isRunning, startedAt } from "../domain/time.js";
import { earningsCents, formatMoney, formatShortDuration } from "../domain/money.js";
import {
  byProject, currenciesByValue, performanceIn, periodRange, sessionMsInWindow, splitByClock,
} from "../domain/performance.js";
import { daysOfWork, recentPicks, spillsPast } from "../domain/recent.js";
import { isIdle } from "../domain/sessions.js";
import { isOffClock, offClockProjects, workProjects } from "../domain/projects.js";
import { rateFor, taskLabel } from "../domain/tasks.js";

/** One more week each time. Seven is the span you actually think in, and the
 *  ledger has hundreds of sessions in it — all of them at once is not a page. */
const STEP = 7;

const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const longDay = (t) => new Date(t).toLocaleDateString(undefined, {
  weekday: "long", day: "numeric", month: "long",
});

/** A per-currency total as one string. Never summed across currencies — 100
 *  EGP and 100 USD are not 200 of anything. */
const money = (cents) =>
  currenciesByValue(cents).map(([cur, c]) => formatMoney(c, cur)).join(" · ");

/**
 * What today is, and what to start next.
 *
 * Deliberately separate from the Overview, which answers "how did the month
 * go". This one is scoped to now: nothing on it has a period selector,
 * because the answer to "what was I doing" is never "in March".
 *
 * Every figure here is computed by `performanceIn` over a day's window — the
 * same call the Overview makes with its selector on Day. It is not summed
 * from the rows listed beneath it, which are grouped by the day a session
 * STARTED in. A sitting that ran past midnight belongs to one list and two
 * totals, and reading the totals off the list would make this screen disagree
 * with every other one. See the note atop `domain/recent.js`.
 *
 * Those figures are work, drawn from on-the-clock projects only, exactly as
 * the Overview draws them. Sleep tracked at a rate is still time you
 * recorded, so its rows stay listed with their hours, but it is neither work
 * nor money and must not reach a heading that says what a day came to.
 */
export default function TodayView({
  projects, sessions, earnings, now, running, onStart, onOpen, onShowSession,
}) {
  const [shown, setShown] = useState(STEP);

  const rateOf = (s) => {
    const owner = projects.find((p) => p.id === s.projectId);
    return owner ? rateFor(owner, s) : s.rate;
  };
  const nameOf = (id) => projects.find((p) => p.id === id) ?? null;

  const picks = recentPicks(sessions, projects);
  const days = daysOfWork(sessions);

  const { work, offClock } = splitByClock(projects, sessions);
  // Off the clock cannot earn, so money filed against it is left out with its
  // hours, the way the Overview leaves it out.
  const offIds = new Set(offClockProjects(projects).map((p) => p.id));
  const workEarnings = earnings.filter((e) => !offIds.has(e.projectId));

  const { from: dayFrom, to: dayTo } = periodRange("day", now, 0);
  // Work first and off the clock after it, as the Overview orders them, so a
  // night's sleep does not head a list of what the day earned.
  const todayRows = [
    ...byProject(workProjects(projects), work, dayFrom, dayTo, now, rateOf, workEarnings),
    ...byProject(offClockProjects(projects), offClock, dayFrom, dayTo, now, rateOf),
  ];
  const today = performanceIn(work, dayFrom, dayTo, now, rateOf, workEarnings);

  return (
    <>
      {/* Hidden while a meter is going. Starting one closes whatever else is
          open, so a row of one-click starts beside a running session is a row
          of one-click ways to end it by accident. The running bar above is
          the right control then, and it is already there. */}
      {picks.length > 0 && !running && (
        <div className="sec">
          <div className="sec-head">
            <span className="eyebrow">Start again</span>
          </div>
          <div className="panel agains">
            {picks.map((p) => (
              <button className="again" key={`${p.project.id}|${p.taskId ?? ""}`}
                      onClick={() => onStart(p.project.id, p.taskId, p.kind)}>
                <span className="again-name">{p.project.name}</span>
                <span className="again-task">
                  {p.taskId ? taskLabel(p.project, p.taskId) : "no task"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="sec">
        <div className="sec-head">
          <span className="eyebrow">Today</span>
          <span className="eyebrow">
            {money(today.billedCents) || "nothing yet"}
            {today.billedMs > 0 && ` · ${formatShortDuration(today.billedMs)}`}
          </span>
        </div>
        <div className="panel">
          {todayRows.length === 0 ? (
            <div className="empty">Nothing recorded today yet.</div>
          ) : todayRows.map(({
            project, billedMs, billedCents, idleMs, pendingCents, cancelledCents,
          }) => (
            <div className="trow clickable" key={project.id} onClick={() => onOpen(project.id)}>
              <div>
                <div className="trow-label">{project.name}</div>
                <div className="trow-sub">
                  {/* Said, because its hours sit in this list and not in the
                      heading above it. */}
                  {isOffClock(project) && "off the clock · "}
                  {/* Which tasks the day touched, not how long each took —
                      that is the project's own page, one click away. */}
                  {tasksToday(project, sessions, dayFrom, dayTo, now) || "no task"}
                  {idleMs > 0 && ` · ${formatShortDuration(idleMs)} idle`}
                </div>
              </div>
              <span className="trow-time">
                {billedMs > 0 ? formatShortDuration(billedMs) : "—"}
              </span>
              {!isOffClock(project) && (
                <span className="trow-amt">
                  {money(billedCents) || "—"}
                  {money(pendingCents) && (
                    <span className="trow-pending">{money(pendingCents)} pending</span>
                  )}
                  {money(cancelledCents) && (
                    <span className="trow-pending">{money(cancelledCents)} cancelled</span>
                  )}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="sec">
        <div className="sec-head">
          <span className="eyebrow">Recent</span>
          <span className="eyebrow">
            {days.length} {days.length === 1 ? "day" : "days"} recorded
          </span>
        </div>

        {days.length === 0 && (
          <div className="panel"><div className="empty">No sessions yet.</div></div>
        )}

        {days.slice(0, shown).map((day) => {
          // Over the day's window, not over the rows below: a sitting that
          // crossed midnight is listed once and counted in two days.
          const totals = performanceIn(work, day.dayStart, day.dayEnd, now, rateOf, workEarnings);
          return (
            <div key={day.dayStart} className="day">
              <div className="day-head">
                <span className="day-name">{longDay(day.dayStart)}</span>
                <span className="day-sum">
                  {money(totals.billedCents)}
                  {totals.billedMs > 0 && ` · ${formatShortDuration(totals.billedMs)}`}
                </span>
              </div>
              <div className="panel">
                {day.sessions.map((s) => {
                  const owner = nameOf(s.projectId);
                  const ms = elapsedMs(s, now);
                  const over = spillsPast(s, day.dayEnd, now);
                  // How much of this sitting the day above was credited with.
                  // Without it the rows visibly fail to add up to the heading,
                  // and a ledger whose arithmetic does not work in front of
                  // you is not one you go on trusting.
                  const here = sessionMsInWindow(s, day.dayStart, day.dayEnd, now);
                  return (
                    <div className="row clickable" key={s.id} onClick={() => onShowSession(s.id)}>
                      <div>
                        <div className="row-when">
                          {clock(startedAt(s))} · {owner?.name ?? "a removed project"}
                          {isRunning(s) && <span className="tag">running</span>}
                          {isIdle(s) && <span className="tag">idle</span>}
                        </div>
                        <div className="row-meta">
                          {owner && isOffClock(owner) ? "off the clock · " : ""}
                          {s.taskId && owner ? `${taskLabel(owner, s.taskId)} · ` : ""}
                          {formatShortDuration(ms)}
                          {over && ` · ran past midnight · ${formatShortDuration(here)} of it here`}
                        </div>
                      </div>
                      <span className="row-amt">
                        {owner && !isOffClock(owner) && !isIdle(s)
                          ? formatMoney(earningsCents(rateOf(s), ms), s.currency)
                          : formatShortDuration(ms)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {days.length > shown && (
          <div className="controls" style={{ marginTop: 14 }}>
            <button className="btn ghost" onClick={() => setShown(shown + STEP)}>
              Show {Math.min(STEP, days.length - shown)} more
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/** The tasks a project was worked under today, named once each. */
function tasksToday(project, sessions, from, to, now) {
  const names = new Set();
  for (const s of sessions) {
    if (s.projectId !== project.id || s.deletedAt) continue;
    const last = s.segments?.[s.segments.length - 1];
    const ends = last?.endedAt ?? now;
    if (ends <= from || startedAt(s) >= to) continue;
    names.add(s.taskId ? taskLabel(project, s.taskId) : "no task");
  }
  return [...names].join(" · ");
}
