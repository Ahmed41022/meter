import { busiestStretch, shareOf, standsOut } from "../../domain/rhythm.js";
import { Rhythm } from "../charts.jsx";
import { DAY_NAMES, day } from "./labels.js";

/** The shape of the week and the day, over the whole record. */
export default function WhenYouWork({ view }) {
  // `standsOut` rather than `busiest`: seven bars within a fifth of each other
  // is a flat week, and naming a winner from it states noise as a habit.
  const peak = standsOut(view.rhythm.weekdays);
  const peakDay = peak ? peak.weekday : null;
  // A dozen measured sessions is not a working pattern, so below that the
  // hourly half is not drawn at all.
  const enoughTimed = view.rhythm.timed >= 12;
  const stretch = enoughTimed ? busiestStretch(view.rhythm.hours, 4) : null;
  const stretchShare = stretch ? shareOf(view.rhythm.hours, stretch.billedMs) : null;

  return (
    <div className="sec">
      <div className="sec-head"><span className="eyebrow">When you work</span></div>
      <div className="panel">
        <Rhythm weekdays={view.rhythm.weekdays} hours={stretch ? view.rhythm.hours : null}
                dayNames={DAY_NAMES} peakDay={peakDay}
                stretch={stretch} stretchShare={stretchShare}
                span={`Across everything recorded, from ${day(view.rhythm.from, { month: "short", year: "numeric" })}`
                  + (stretch ? " · hours from timed sessions only" : "")} />
      </div>
    </div>
  );
}
