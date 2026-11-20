import { PERIODS } from "../../domain/performance.js";
import { NAMES } from "../dashboard/labels.js";

/**
 * Choices about how screens open, kept in the ledger so every device that
 * syncs agrees. The theme above is the opposite on purpose: what suits a phone
 * at night and a desktop at noon differ, so it stays per device.
 */
export default function DefaultsSection({ overviewPeriod, onOverviewPeriod }) {
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
        <div className="hint">
          Shared by every device that syncs. The theme above is per device.
        </div>
      </div>
    </section>
  );
}
