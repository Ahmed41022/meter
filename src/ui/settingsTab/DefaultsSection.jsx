import { PERIODS } from "../../domain/performance.js";
import {
  BY_COMPANY_ORDERS, BY_PROJECT_ORDERS, CARD_ORDERS, EARNINGS_ORDERS, LIFE_ORDERS,
  SESSION_ORDERS,
} from "../../domain/order.js";
import { NAMES } from "../dashboard/labels.js";

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
 * Choices about how screens open, kept in the ledger so every device that
 * syncs agrees. The theme above is the opposite on purpose: what suits a phone
 * at night and a desktop at noon differ, so it stays per device.
 */
export default function DefaultsSection({ overviewPeriod, onOverviewPeriod, sorts = {}, onSort }) {
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
        <div className="hint">
          Shared by every device that syncs. The theme above is per device.
        </div>
      </div>
    </section>
  );
}
