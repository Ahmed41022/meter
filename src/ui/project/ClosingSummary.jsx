import { lastActivityAt, startedAt } from "../../domain/time.js";
import { formatMoney, formatShortDuration } from "../../domain/money.js";
import { effectiveRate } from "../../domain/performance.js";
import { StatTile } from "../charts.jsx";
import { date } from "./format.js";

/**
 * What a finished project came to: the span it ran, what it earned and what
 * an hour of it was worth. Shown instead of the goal bars once it is done.
 */
export default function ClosingSummary({
  sessions, idleSessions, offClock, currency, totalCents, totalMs, idleMs, share,
  overallGoal, overallValue,
}) {
  /** The span the project actually ran, taken from the work rather than from
   *  when it was created or marked done — a project made in March and first
   *  worked in June ran from June. */
  const allSessions = [...sessions, ...idleSessions];
  const ranFrom = allSessions.length
    ? Math.min(...allSessions.map((s) => startedAt(s))) : null;
  const ranTo = allSessions.length
    ? Math.max(...allSessions.map((s) => s.closedAt ?? lastActivityAt(s) ?? startedAt(s))) : null;
  const closingRate = effectiveRate(totalCents, totalMs);
  const goalUnit = (v) => (overallGoal?.type === "money"
    ? formatMoney(Math.round(v * 100), currency) : formatShortDuration(v * 60_000));

  return (
    <div className="sec">
      <div className="sec-head">
        <span className="eyebrow">What it came to</span>
        {ranFrom !== null && (
          <span className="eyebrow">
            {date(ranFrom)} – {date(ranTo)}{new Date(ranTo).getFullYear() !== new Date().getFullYear()
              ? ` ${new Date(ranTo).getFullYear()}` : ""}
          </span>
        )}
      </div>
      <div className="panel">
        {allSessions.length === 0 ? (
          <div className="empty">No time was ever recorded against this one.</div>
        ) : (
          <div className="tiles closing">
            {!offClock && (
              <StatTile label="Earned" value={formatMoney(totalCents, currency)} />
            )}
            <StatTile label={offClock ? "Tracked" : "Billed"}
                      value={formatShortDuration(totalMs)}
                      sub={idleMs > 0 ? `${formatShortDuration(idleMs)} idle` : null} />
            {!offClock && closingRate !== null && (
              <StatTile label="An hour came to" value={`${formatMoney(closingRate, currency)}/hr`}
                        sub={share === null ? null : `${Math.round(share * 100)}% of desk time billed`} />
            )}
            {overallGoal && (
              <StatTile label="Goal"
                        value={overallValue >= overallGoal.target ? "Met" : "Short"}
                        sub={`${goalUnit(overallValue)} of ${goalUnit(overallGoal.target)}`} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
