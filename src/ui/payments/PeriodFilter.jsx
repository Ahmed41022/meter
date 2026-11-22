import { STATEMENT_PERIODS } from "../../domain/statementPeriod.js";

/**
 * Which span of the history to look at: a few named ones, and two days of
 * your own. Only reports the choice; the view remembers it.
 */
export default function PeriodFilter({ choice, custom, onChoose, onCustom }) {
  return (
    <div className="stmt-period">
      <div className="segmented small" role="group" aria-label="Period">
        {STATEMENT_PERIODS.map(([key, label]) => (
          <button key={key} type="button" aria-pressed={choice === key}
                  className={"seg" + (choice === key ? " on" : "")}
                  onClick={() => onChoose(key)}>
            {label}
          </button>
        ))}
      </div>
      {choice === "custom" && (
        <div className="stmt-dates">
          <input className="inp" type="date" aria-label="From" value={custom.from}
                 onChange={(e) => onCustom({ ...custom, from: e.target.value })} />
          <input className="inp" type="date" aria-label="To" value={custom.to}
                 onChange={(e) => onCustom({ ...custom, to: e.target.value })} />
        </div>
      )}
    </div>
  );
}
