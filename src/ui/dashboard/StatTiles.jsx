import { formatMoney, formatShortDuration } from "../../domain/money.js";
import { deltaRatio } from "../../domain/performance.js";
import { Delta, StatTile } from "../charts.jsx";

/** The row of tiles under the headline: billed, idle, share, activity and rates. */
export default function StatTiles({
  current, previous, base, vs, share, period, active, trend, rates,
}) {
  return (
    <div className="tiles">
      <StatTile label="Billed" value={formatShortDuration(current.billedMs)}
                sub={previous
                  ? <Delta ratio={deltaRatio(base.billedMs, previous.billedMs)} label={vs} />
                  : null} />
      <StatTile label="Idle" value={formatShortDuration(current.idleMs)}
                sub={previous
                  ? <Delta ratio={deltaRatio(base.idleMs, previous.idleMs)}
                           goodWhenUp={false} label={vs} />
                  : null} />
      <StatTile label="Billed share"
                value={share === null ? "—" : `${Math.round(share * 100)}%`}
                sub={share === null ? "no time recorded" : "of time at the desk"} />
      <StatTile
        label={{ day: "Active hours", year: "Active months", all: "Active months" }[period]
          ?? "Active days"}
        value={active} sub={`of ${trend.length}`} />
      {/* Both rates, because they answer different questions and only one of
          them is about the clock. Where nothing untimed was earned they are
          the same number, so the second line would be noise and is dropped.
          A tile for each currency the period was worked or paid in, since
          no one figure can be an hour of two. */}
      {rates.map(({ currency, rateCents, timedRateCents, untimed }) => (
        <StatTile key={currency} label="An hour came to"
                  value={`${formatMoney(rateCents, currency)}/hr`}
                  sub={untimed > 0.005
                    ? `${formatMoney(timedRateCents, currency)}/hr on timed work · ${Math.round(untimed * 100)}% earned no tracked time`
                    : "across billed time"} />
      ))}
    </div>
  );
}
