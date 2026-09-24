import { useCallback, useState } from "react";
import { formatMoney, formatShortDuration } from "../domain/money.js";
import { heatLevel } from "../domain/performance.js";

/**
 * The reporting figures: stat tiles and the trend column chart.
 *
 * Everything here is presentational — it receives numbers already derived by
 * `domain/performance.js` and never computes a total itself. Two series appear
 * throughout, billed and idle, and they always wear the same two colours the
 * rest of the app uses for them: jade for work, amber for time at the desk that
 * wasn't billed.
 */

/** Jade against amber sits in the acceptable-but-not-comfortable band for
 *  red-green colour blindness, so identity is never left to colour alone: every
 *  chart below carries a legend, labelled figures and per-bar text. */
const SERIES = { billed: "var(--jade)", idle: "var(--amber)" };

const pct = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);

/**
 * A signed change against the previous period.
 *
 * `ratio` is null when there is no baseline, and that renders as an em dash
 * rather than +0% — claiming no change from nothing is a different statement
 * from having nothing to compare with.
 *
 * `goodWhenUp` is explicit because direction and desirability are separate
 * questions: more billed time is good news, more idle time is not.
 */
export function Delta({ ratio, goodWhenUp = true, label }) {
  if (ratio === null || ratio === undefined) {
    return (
      <span className="delta none" title={`No ${label} to compare with`}>
        —<span className="delta-vs"> vs {label}</span>
      </span>
    );
  }
  const rounded = Math.round(ratio * 100);
  const tone = rounded === 0 ? "flat" : (rounded > 0) === goodWhenUp ? "up" : "down";
  return (
    <span className={`delta ${tone}`}>
      {rounded > 0 ? "+" : rounded < 0 ? "−" : ""}{Math.abs(rounded)}%
      <span className="delta-vs"> vs {label}</span>
    </span>
  );
}

/** Label, value, and an optional comparison underneath. The value stays in the
 *  ink tokens — the coloured mark beside a figure carries identity, never the
 *  text itself. */
export function StatTile({ label, value, sub }) {
  return (
    <div className="tile">
      <span className="eyebrow">{label}</span>
      <div className="tile-val">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

export function Legend({ items }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span className="legend-item" key={it.label}>
          <span className="swatch" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Billed against idle as a proportion of desk time.
 *
 * A two-part ratio, so a bar rather than a pie. The 2px surface gap between the
 * two fills is what separates them; neither carries a border.
 */
export function SplitBar({ billedMs, idleMs, share }) {
  return (
    <>
      <div className="split">
        <div className="split-billed" style={{ width: `${pct(billedMs, billedMs + idleMs)}%` }} />
        <div className="split-idle" style={{ width: `${pct(idleMs, billedMs + idleMs)}%` }} />
      </div>
      <div className="split-legend">
        <span className="legend-item">
          <span className="swatch" style={{ background: SERIES.billed }} />
          {formatShortDuration(billedMs)} billed
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: SERIES.idle }} />
          {formatShortDuration(idleMs)} idle
        </span>
      </div>
      {share !== null && <div className="util-note">{Math.round(share * 100)}% of desk time billed</div>}
    </>
  );
}

/**
 * Time per bucket as stacked columns: billed from the baseline, idle above it.
 *
 * Height is scaled to the tallest column rather than to a round number, because
 * the question this chart answers is "which hours or days carried the work",
 * not "how many hours exactly" — the tiles above it carry the exact figures and
 * every column states its own in a tooltip.
 *
 * The period is passed in rather than inferred from the bucket count: a day
 * that gains or loses an hour to DST has 23 or 25 buckets, and counting them
 * would label that day's chart "time per day".
 *
 * Columns are capped at 24px and centred in their slot, so a seven-bar week
 * doesn't render as seven slabs. Adjacent columns and the two stacked segments
 * are all separated by a 2px gap in the surface colour, never by a border.
 */
export function TrendChart({ trend, period, currency, emptyNote }) {
  const peak = Math.max(...trend.map((b) => b.billedMs + b.idleMs), 0);
  const anyIdle = trend.some((b) => b.idleMs > 0);

  if (peak === 0) return <div className="empty">{emptyNote}</div>;

  return (
    <div className="trend">
      <div className="trend-top">
        <span className="eyebrow">Time per {period === "day" ? "hour" : "day"}</span>
        <span className="eyebrow">peak {formatShortDuration(peak)}</span>
      </div>

      <div className="trend-plot">
        {trend.map((b) => {
          const total = b.billedMs + b.idleMs;
          const cents = Object.values(b.billedCents).reduce((a, c) => a + c, 0);
          const when = new Date(b.from).toLocaleString(undefined, {
            weekday: "short", day: "numeric", month: "short",
            ...(period === "day" ? { hour: "2-digit", minute: "2-digit" } : {}),
          });
          // The whole column is the hit target, not just the drawn bar — a
          // 6px-tall mark is far too small to aim at.
          return (
            <div className="tcol" key={b.from} tabIndex={0}
                 aria-label={`${when}: ${formatShortDuration(b.billedMs)} billed${
                   b.idleMs ? `, ${formatShortDuration(b.idleMs)} idle` : ""}`}>
              <div className="tbar">
                {b.idleMs > 0 && (
                  <div className={"tseg idle" + (b.billedMs > 0 ? " stacked" : "")}
                       style={{ height: `${pct(b.idleMs, peak)}%` }} />
                )}
                {b.billedMs > 0 && (
                  <div className={"tseg billed" + (b.idleMs > 0 ? " under" : "")}
                       style={{ height: `${pct(b.billedMs, peak)}%` }} />
                )}
              </div>
              {total > 0 && (
                <div className="ttip" role="tooltip">
                  <strong>{when}</strong>
                  <span>{formatShortDuration(b.billedMs)} billed</span>
                  {b.idleMs > 0 && <span className="ttip-idle">{formatShortDuration(b.idleMs)} idle</span>}
                  {cents > 0 && <span>{formatMoney(cents, currency)}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="trend-axis">
        {trend.map((b) => (
          <span className="tlab" key={b.from}>{b.major ? b.label : ""}</span>
        ))}
      </div>

      {anyIdle && (
        <Legend items={[
          { label: "Billed", color: SERIES.billed },
          { label: "Idle", color: SERIES.idle },
        ]} />
      )}
    </div>
  );
}

/**
 * A year of days, shaded by how much time each one carried.
 *
 * Two ramps rather than one, because the two registers are not the same
 * quantity and must not be read against a shared scale: jade for work, and for
 * off-clock time the same quiet slate the rest of the app gives it. Both start
 * from the empty-cell colour, so the ramp reads as "more of this" rather than
 * as a set of categories.
 *
 * The boundaries are quantiles of whatever is being shaded (six hours is a full
 * day of work and a short night's sleep — no fixed scale serves both), which
 * makes them arbitrary unless they are stated. So the legend spells out every
 * one of them instead of saying "less" and "more".
 */
const RAMP = {
  work: ["#DCEFE5", "#A5D8C1", "#4FA986", "#0F7B5A"],
  life: ["#E3E7E3", "#BFC7C1", "#99A49C", "#75827B"],
};
const EMPTY_CELL = "var(--line-2)";

const monthName = (t) => new Date(t).toLocaleDateString(undefined, { month: "short" });
const fullDate = (t) => new Date(t).toLocaleDateString(undefined, {
  weekday: "short", day: "numeric", month: "short", year: "numeric",
});

export function Heatmap({ weeks, thresholds, scale = "work", valueOf, noun, streak }) {
  const [hover, setHover] = useState(null);
  const ramp = RAMP[scale];

  /** Where 53 columns don't fit, open on the end. The recent weeks are the ones
   *  anyone is looking for, and a calendar that starts a year ago reads as
   *  empty. Set once on mount so it never fights a reader who has scrolled. */
  const openAtToday = useCallback((node) => {
    if (node) node.scrollLeft = node.scrollWidth;
  }, []);

  /**
   * A column carries a month label when it is the first column belonging to
   * that month. Which month a column belongs to is decided by its MIDWEEK day,
   * not its Monday: the week of 31 Aug – 6 Sep is four-sevenths September, and
   * going by the Monday would leave September with no label at all while
   * pushing August's onto a column that is mostly not August.
   */
  const monthOf = (week) => new Date(week.days[3].at).getMonth();
  const labels = weeks.map((week, i) => {
    // The leading column is a part-month that started before the calendar
    // does, and labelling it would put two names a single column apart.
    if (i === 0 || monthOf(week) === monthOf(weeks[i - 1])) return "";
    return monthName(week.days[3].at);
  });

  const cells = weeks.flatMap((w) => w.days).filter((d) => !d.future);
  const active = cells.filter((d) => valueOf(d) > 0).length;
  const total = cells.reduce((a, d) => a + valueOf(d), 0);

  /**
   * The streak leads, because it is the one figure here you can still change
   * today. "none today" is said out loud rather than left to be inferred from
   * a number that has not moved: the run is alive, it just has not been
   * extended yet, and those are different things to be told.
   */
  const parts = [];
  if (streak?.current > 0) {
    parts.push(`${streak.current}-day streak`);
    if (!streak.includesToday) parts.push("none today");
  }
  parts.push(`${active} active ${active === 1 ? "day" : "days"}`);
  if (streak?.longest > streak?.current) parts.push(`best ${streak.longest}`);
  parts.push(formatShortDuration(total));
  const summary = parts.join(" · ");

  return (
    <div className="hm">
      <div className="hm-top">
        <span className="eyebrow">{noun} per day</span>
        {/* The hovered day reads out here rather than in a floating tip. A tip
            would have to live inside the scroll container, and a container that
            scrolls on one axis clips the other — so it would be cut off on the
            top row, which is half the reason to hover in the first place. */}
        <span className={"eyebrow hm-read" + (hover ? " on" : "")} aria-live="polite">
          {hover
            ? `${fullDate(hover.day.at)} · ${hover.ms > 0
                ? formatShortDuration(hover.ms) : `no ${noun.toLowerCase()}`}`
            : summary}
        </span>
      </div>

      <div className="hm-scroll" ref={openAtToday}>
        <div className="hm-months">
          {labels.map((label, i) => (
            <span className="hm-month" key={weeks[i].from}>{label}</span>
          ))}
        </div>
        <div className="hm-body">
          <div className="hm-days">
            {["Mon", "", "Wed", "", "Fri", "", ""].map((d, i) => (
              <span className="hm-day" key={i}>{d}</span>
            ))}
          </div>
          <div className="hm-grid" role="img" onMouseLeave={() => setHover(null)}
               aria-label={`${noun} per day over the last year: ${summary}`}>
            {weeks.map((week) => (
              <div className="hm-col" key={week.from}>
                {week.days.map((day) => {
                  const ms = valueOf(day);
                  const level = day.future ? -1 : heatLevel(ms, thresholds);
                  return (
                    <span
                      key={day.at}
                      data-at={day.at}
                      data-level={level}
                      className={"hm-cell" + (day.future ? " future" : "")}
                      style={day.future ? undefined
                        : { background: level === 0 ? EMPTY_CELL : ramp[level - 1] }}
                      onMouseEnter={day.future ? undefined : () => setHover({ day, ms })}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {thresholds.length > 0 ? (
        <div className="legend hm-legend">
          {ramp.map((color, i) => (
            <span className="legend-item" key={color}>
              <span className="swatch" style={{ background: color }} />
              {i < thresholds.length
                ? `to ${formatShortDuration(thresholds[i])}`
                : `over ${formatShortDuration(thresholds[thresholds.length - 1])}`}
            </span>
          ))}
        </div>
      ) : (
        <div className="hm-none">Nothing recorded in the last year.</div>
      )}
    </div>
  );
}
