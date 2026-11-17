import { periodBoundary } from "../../domain/goals.js";
import { heatGrid, heatThresholds, streaks } from "../../domain/performance.js";
import { Heatmap } from "../charts.jsx";

/**
 * The year of days drawn as a heatmap, with the Work and Off the clock scale
 * and the stepper back through earlier years. The calendar itself is built by
 * the view, which is why the step and the scale are passed in.
 */
export default function Activity({ view, now, heatScale, setHeatScale, heatBack, setHeatBack }) {
  // Off the clock has no billable half, so its calendar shades every tracked
  // minute; work shades the billed ones, which is what the goals count.
  const scale = view.hasOffClock ? heatScale : "work";
  const heat = view.calendar[scale];
  const heatValue = scale === "work" ? (d) => d.billedMs : (d) => d.billedMs + d.idleMs;
  const heatWeeks = heatGrid(heat.from, heat.to, heat.byDay, periodBoundary("day", now, 0));
  const heatDays = heatWeeks.flatMap((w) => w.days).filter((d) => !d.future);
  const heatCuts = heatThresholds(heatDays.map(heatValue));
  const streak = streaks(heatDays, (d) => heatValue(d) > 0);

  return (
    <div className="sec">
      <div className="sec-head">
        <span className="eyebrow">Activity</span>
        <span className="hm-head">
          {view.hasOffClock && (
          // Named for the section above it, not for the tabs at the top of the
          // page: a Work/Life pair here would look like navigation and go
          // nowhere.
          <div className="segmented small" role="tablist" aria-label="Which time to show">
            {[["work", "Work"], ["life", "Off the clock"]].map(([key, label]) => (
              <button key={key} role="tab" aria-selected={scale === key}
                      className={"seg" + (scale === key ? " on" : "")}
                      onClick={() => setHeatScale(key)}>
                {label}
              </button>
            ))}
          </div>
          )}
          {/* Steps a whole grid at a time, so a week belongs to exactly one
              view rather than straddling two. Stops where the records do. */}
          {view.depth[scale] > 0 && (
            <span className="stepper">
              <button className="step" aria-label="Earlier years"
                      disabled={heatBack >= view.depth[scale]}
                      onClick={() => setHeatBack((b) => b + 1)}>‹</button>
              <button className="step" aria-label="Later years"
                      disabled={heatBack <= 0}
                      onClick={() => setHeatBack((b) => Math.max(0, b - 1))}>›</button>
            </span>
          )}
        </span>
      </div>
      <div className="panel">
        <Heatmap weeks={heatWeeks} thresholds={heatCuts} scale={scale} streak={streak}
                 valueOf={heatValue} noun={scale === "work" ? "Billed" : "Tracked"} />
      </div>
    </div>
  );
}
