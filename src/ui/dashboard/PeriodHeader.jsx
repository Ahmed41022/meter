import { PERIODS } from "../../domain/performance.js";
import { SETTING, saveSetting } from "../../storage/settings.js";
import { NAMES } from "./labels.js";

/**
 * The period control and its stepper. Which period is chosen is remembered by
 * the view, so this only reports the choice.
 */
export default function PeriodHeader({ period, setPeriod, setOffset, offset }) {
  return (
    <div className="dash-head">
      <div className="segmented" role="tablist" aria-label="Reporting period">
        {PERIODS.map((p) => (
          <button key={p} role="tab" aria-selected={period === p}
                  className={"seg" + (period === p ? " on" : "")}
                  onClick={() => {
                    setPeriod(p);
                    setOffset(0);
                    saveSetting(SETTING.PERIOD, p);
                  }}>
            {NAMES[p]}
          </button>
        ))}
      </div>
      {/* All time cannot be stepped: there is exactly one of it. */}
      {period !== "all" && (
        <div className="stepper">
          <button className="step" aria-label={`Previous ${period}`}
                  onClick={() => setOffset((o) => o - 1)}>‹</button>
          {/* Forward is disabled at the present period — there is no data
              ahead of now, and an empty "next week" reads as a bug. */}
          <button className="step" aria-label={`Next ${period}`} disabled={offset >= 0}
                  onClick={() => setOffset((o) => Math.min(0, o + 1))}>›</button>
        </div>
      )}
    </div>
  );
}
