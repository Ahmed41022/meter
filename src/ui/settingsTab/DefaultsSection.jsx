import { PERIODS } from "../../domain/performance.js";
import {
  BY_COMPANY_ORDERS, BY_PROJECT_ORDERS, CARD_ORDERS, EARNINGS_ORDERS, LIFE_ORDERS,
  SESSION_ORDERS,
} from "../../domain/order.js";
import { NAMES } from "../dashboard/labels.js";
import { dayTurn } from "../../domain/hoursLeft.js";
import { clockOfMinutes } from "../goals/words.js";

/** When a day can end: every half hour from the evening before to noon. */
const EVENING = 17 * 60;
const HALF = 30;
const span = (from, to) => Array.from({ length: (to - from) / HALF + 1 }, (_, i) => from + i * HALF);
const DAY_ENDS = [...span(EVENING, 23 * 60 + HALF), ...span(0, 12 * 60)];

const endsWords = (at) => {
  if (at === 0) return "Goals count each day from midnight to midnight.";
  return dayTurn(at) > 0
    ? `Goals count work until ${clockOfMinutes(at)} toward the day before. Every other screen still turns over at midnight, and pay goes by each client’s own clock.`
    : `Goals say how long is left until ${clockOfMinutes(at)}. Work after it still counts, until midnight.`;
};

/** One select per list: which order it opens in. Each label names its list,
 *  because "sorted by" alone would not say which screen it changes. */
const SORTS = [
  ["cardsSort", "Work projects open sorted by", CARD_ORDERS],
  ["lifeSort", "Life projects open sorted by", LIFE_ORDERS],
  ["byProjectSort", "Overview, By project, opens sorted by", BY_PROJECT_ORDERS],
  ["byCompanySort", "Overview, By company, opens sorted by", BY_COMPANY_ORDERS],
  ["earningsSort", "A project’s earnings open sorted by", EARNINGS_ORDERS],
  ["sessionsSort", "A project’s sessions open sorted by", SESSION_ORDERS],
];

/**
 * Choices about how screens open, and when a day ends, kept in the ledger so every device that
 * syncs agrees. The theme above is the opposite on purpose: what suits a phone
 * at night and a desktop at noon differ, so it stays per device.
 */
export default function DefaultsSection({
  overviewPeriod, onOverviewPeriod, sorts = {}, onSort, dayEndsAt = 0, onDayEndsAt,
}) {
  return (
    <section className="settings-sec" aria-labelledby="settings-defaults">
      <h2 className="settings-title" id="settings-defaults">Defaults</h2>
      <div className="panel">
        <label className="field">
          <span className="eyebrow">Overview opens on</span>
          <select className="inp" value={overviewPeriod}
                  onChange={(e) => onOverviewPeriod(e.target.value)}>
            <option value="last">The last one used on this device</option>
            {PERIODS.map((p) => <option key={p} value={p}>{NAMES[p]}</option>)}
          </select>
        </label>
        {SORTS.map(([key, label, orders]) => (
          <label className="field" key={key}>
            <span className="eyebrow">{label}</span>
            <select className="inp" value={sorts[key]}
                    onChange={(e) => onSort(key, e.target.value)}>
              {orders.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
          </label>
        ))}
        <label className="field">
          <span className="eyebrow">My day ends at</span>
          <select className="inp" value={dayEndsAt} onChange={(e) => onDayEndsAt(Number(e.target.value))}>
            {/* One another build set that is not on the half hour. */}
            {!DAY_ENDS.includes(dayEndsAt) && <option value={dayEndsAt}>{clockOfMinutes(dayEndsAt)}</option>}
            {DAY_ENDS.map((m) => (
              <option key={m} value={m}>{m === 0 ? "Midnight" : clockOfMinutes(m)}{dayTurn(m) > 0 ? ", next day" : ""}</option>
            ))}
          </select>
        </label>
        <div className="hint day-ends">{endsWords(dayEndsAt)}</div>
        <div className="hint">
          Shared by every device that syncs. The theme above is per device.
        </div>
      </div>
    </section>
  );
}
