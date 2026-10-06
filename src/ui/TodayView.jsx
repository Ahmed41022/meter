import { useState } from "react";
import { elapsedMs, isRunning, startedAt } from "../domain/time.js";
import { earningsCents, formatMoney, formatShortDuration } from "../domain/money.js";
import {
  byProject, currenciesByValue, performanceIn, periodRange, sessionMsInWindow, splitByClock,
} from "../domain/performance.js";
import { daysOfWork, recentPicks, spillsPast } from "../domain/recent.js";
import { isIdle } from "../domain/sessions.js";
import { isCancelled, isPending } from "../domain/earnings.js";
import { isOffClock, offClockProjects, workProjects } from "../domain/projects.js";
import { rateFor, taskLabel } from "../domain/tasks.js";

/** One more week each time. Seven is the span you actually think in, and the
 *  ledger has hundreds of sessions in it — all of them at once is not a page. */
const STEP = 7;

const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const dayShort = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const longDay = (t) => new Date(t).toLocaleDateString(undefined, {
  weekday: "long", day: "numeric", month: "long",
});

/** A per-currency total as one string. Never summed across currencies — 100
 *  EGP and 100 USD are not 200 of anything. */
const money = (cents) =>
  currenciesByValue(cents).map(([cur, c]) => formatMoney(c, cur)).join(" · ");

/**
 * What a day came to, the way its heading says it: what was earned, the hours
 * worked, and what is still waiting on an answer. The last is said apart, as
 * the Overview keeps it, so a day of unanswered work never reads as paid —
 * and it is said at all because its rows are listed underneath, and a row
 * whose money is in no figure above it reads as a sum that does not add up.
 */
const daySum = (totals, nothing = "") => {
  const waiting = money(Object.fromEntries(
    Object.entries(totals.pendingCents).filter(([, c]) => c !== 0)));
  return [
    money(totals.billedCents) || nothing,
    totals.billedMs > 0 ? formatShortDuration(totals.billedMs) : "",
    waiting ? `${waiting} pending` : "",
  ].filter(Boolean).join(" · ");
};

/**
 * What today is, and what to start next.
 *
 * Deliberately separate from the Overview, which answers "how did the month
 * go". This one is scoped to now: nothing on it has a period selector,
 * because the answer to "what was I doing" is never "in March".
 *
 * Every figure here is computed by `performanceIn` over a day's window — the
 * same call the Overview makes with its selector on Day — and never summed
 * from the rows listed beneath it, which would let this screen drift from
 * every other one. The rows are measured over the same window instead: a
 * sitting that ran past midnight is listed under each day it touched, each
 * listing carrying that day's share of its hours and its money, so the
 * sittings under a heading add up to it. Money no clock measured — a bonus,
 * an accepted item's price — is counted in the heading and has no row of its
 * own. See the note atop `domain/recent.js`.
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
  const days = daysOfWork(sessions, now);

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
          <span className="eyebrow">{daySum(today, "nothing yet")}</span>
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
          // Over the day's window, never summed from the rows below. Each row
          // is measured over the same window, which is why they agree.
          const totals = performanceIn(work, day.dayStart, day.dayEnd, now, rateOf, workEarnings);
          return (
            <div key={day.dayStart} className="day">
              <div className="day-head">
                <span className="day-name">{longDay(day.dayStart)}</span>
                <span className="day-sum">{daySum(totals)}</span>
              </div>
              <div className="panel">
                {day.sessions.map((s) => {
                  const owner = nameOf(s.projectId);
                  // This day's share of the sitting, in hours and in money,
                  // split at midnight. A sitting that crossed it is listed
                  // under each of its days, and the whole of it under both
                  // would put its hours in front of you twice while the
                  // headings counted them once. Measured this way the rows add
                  // up to the heading above them, and a ledger whose
                  // arithmetic does not work in front of you is not one you go
                  // on trusting.
                  const here = sessionMsInWindow(s, day.dayStart, day.dayEnd, now);
                  const whole = elapsedMs(s, now);
                  const over = spillsPast(s, day.dayEnd, now);
                  // Carried in from an earlier day, where its clock time alone
                  // would read as a start this day never had.
                  const carried = startedAt(s) < day.dayStart;
                  // Whether the row's figure is money at all. Idle and off
                  // the clock read as time; so does work whose project is gone.
                  const priced = owner && !isOffClock(owner) && !isIdle(s);
                  // Rejected work keeps its row, its hours and what it would
                  // have paid, struck through the way the ledger shows it, so
                  // the column cannot be read as money the heading leaves
                  // out. Unanswered work says so instead of passing for paid.
                  const voided = priced && isCancelled(s);
                  return (
                    <div className={"row clickable" + (voided ? " is-void" : "")} key={s.id}
                         onClick={() => onShowSession(s.id)}>
                      <div>
                        <div className="row-when">
                          {carried && `${dayShort(startedAt(s))}, `}
                          {clock(startedAt(s))} · {owner?.name ?? "a removed project"}
                          {/* Only where it is still going: the earlier day's
                              share of a running sitting is over. */}
                          {isRunning(s) && !over && <span className="tag">running</span>}
                          {isIdle(s) && <span className="tag">idle</span>}
                          {priced && isPending(s) && <span className="tag">pending</span>}
                          {voided && <span className="tag">cancelled</span>}
                        </div>
                        <div className="row-meta">
                          {owner && isOffClock(owner) ? "off the clock · " : ""}
                          {s.taskId && owner ? `${taskLabel(owner, s.taskId)} · ` : ""}
                          {formatShortDuration(here)}
                          {here !== whole && ` of ${formatShortDuration(whole)}`}
                          {over && " · ran past midnight"}
                        </div>
                      </div>
                      <span className="row-amt">
                        {priced
                          ? formatMoney(earningsCents(rateOf(s), here), s.currency)
                          : formatShortDuration(here)}
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
