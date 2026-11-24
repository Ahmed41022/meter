import { useState } from "react";
import { EVERY_DAY, readGoal } from "../../domain/workGoals.js";
import { hoursText, readHours } from "../../domain/minimum.js";
import { companiesIn, isOffClock } from "../../domain/projects.js";
import { useCurrency } from "../CurrencyContext.jsx";
import { CURRENCIES } from "../NewProject.jsx";
import { A_WORD, EVERY_WORD } from "./words.js";

const MINUTE = 60_000;
const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]];
/** A money target as typed, a decimal comma included, or NaN. */
const readMoney = (text) => (String(text).trim() ? Number(String(text).trim().replace(",", ".")) : NaN);
const scopeKey = (s) => (s.kind === "company" ? `c:${s.company}` : s.kind === "project" ? `p:${s.projectId}` : "all");
const scopeOf = (key) => (key.startsWith("c:") ? { kind: "company", company: key.slice(2) }
  : key.startsWith("p:") ? { kind: "project", projectId: key.slice(2) } : { kind: "all" });

/** One row of choices, as everywhere a setting is picked rather than typed. */
function Choice({ label, options, value, onChange }) {
  return (
    <div className="field">
      <span className="eyebrow">{label}</span>
      <div className="modes" role="tablist" aria-label={label}>
        {options.map(([key, text]) => (
          <button key={key} type="button" role="tab" aria-selected={value === key}
                  className={"seg-btn" + (value === key ? " on" : "")} onClick={() => onChange(key)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A goal's boxes, for a new one and for changing one. Seeded once, so the
 *  caller keys it by the goal it edits. */
export default function GoalForm({ goal = null, projects, onSave, onCancel }) {
  const { choice, favourites } = useCurrency();
  const fallback = choice === "earned" ? favourites[0] ?? "USD" : choice;
  const terms = goal?.terms.at(-1) ?? null;
  const [period, setPeriod] = useState(goal?.period ?? "day");
  const [type, setType] = useState(goal?.type ?? "time");
  const [hours, setHours] = useState(goal?.type === "time" ? hoursText(terms.target * MINUTE) : "");
  const [amount, setAmount] = useState(goal?.type === "money" ? String(terms.target) : "");
  const [currency, setCurrency] = useState(goal?.currency ?? fallback);
  const [covers, setCovers] = useState(goal ? scopeKey(goal.scope) : "all");
  const [days, setDays] = useState(terms?.days ?? EVERY_DAY);

  const work = projects.filter((p) => !isOffClock(p));
  const companies = companiesIn(work);
  const kept = goal ? scopeKey(goal.scope) : "all";
  const listed = ["all", ...companies.map((c) => `c:${c}`), ...work.map((p) => `p:${p.id}`)];
  const fields = {
    type, period, currency, days, scope: scopeOf(covers),
    target: type === "time" ? (readHours(hours) ?? NaN) / MINUTE : readMoney(amount),
  };
  const next = readGoal(fields);
  const typed = (type === "time" ? hours : amount).trim() !== "";
  const save = () => next && onSave(fields);
  const onKey = (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") onCancel();
  };
  const toggle = (d) => setDays((was) =>
    (was.includes(d) ? was.filter((x) => x !== d) : EVERY_DAY.filter((x) => x === d || was.includes(x))));
  const asksAnew = goal && (goal.period !== period || goal.type !== type || kept !== covers
    || (type === "money" && goal.currency !== currency));

  return (
    <div className="goal-form">
      <Choice label="How often" options={Object.entries(EVERY_WORD)} value={period} onChange={setPeriod} />
      <Choice label="Measure" options={[["time", "Time worked"], ["money", "Money earned"]]}
              value={type} onChange={setType} />
      {type === "time" ? (
        <label className="field">
          <span className="eyebrow">Hours {A_WORD[period]}</span>
          <input className="inp" inputMode="decimal" value={hours} autoFocus
                 placeholder={{ day: "6", week: "30", month: "120" }[period]}
                 onChange={(e) => setHours(e.target.value)} onKeyDown={onKey} />
        </label>
      ) : (
        <div className="pair">
          <label className="field">
            <span className="eyebrow">Amount {A_WORD[period]}</span>
            <input className="inp" inputMode="decimal" value={amount} autoFocus
                   placeholder={{ day: "200", week: "1000", month: "4000" }[period]}
                   onChange={(e) => setAmount(e.target.value)} onKeyDown={onKey} />
          </label>
          <label className="field">
            <span className="eyebrow">Currency</span>
            <select className="inp" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {[...new Set([goal?.currency, fallback, ...favourites, ...CURRENCIES].filter(Boolean))]
                .map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
      )}
      {typed && !next && days.length > 0 && (
        <div className="hint warn" role="alert">A target is a number above zero.</div>
      )}
      <label className="field">
        <span className="eyebrow">Covers</span>
        <select className="inp" value={covers} onChange={(e) => setCovers(e.target.value)}>
          <option value="all">All work</option>
          {/* What it covers now, when that has since gone, so saving something
              else does not quietly move it. */}
          {!listed.includes(kept) && <option value={kept}>{goal.scope.company ?? "A removed project"}</option>}
          {companies.length > 0 && (
            <optgroup label="Companies">
              {companies.map((c) => <option key={c} value={`c:${c}`}>{c}</option>)}
            </optgroup>
          )}
          {work.length > 0 && (
            <optgroup label="Projects">
              {work.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name}</option>)}
            </optgroup>
          )}
        </select>
      </label>
      <div className="field">
        <span className="eyebrow">Working days</span>
        <div className="modes" role="group" aria-label="Working days">
          {DAYS.map(([d, name]) => (
            <button key={d} type="button" aria-pressed={days.includes(d)}
                    className={"seg-btn" + (days.includes(d) ? " on" : "")} onClick={() => toggle(d)}>
              {name}
            </button>
          ))}
        </div>
      </div>
      {days.length === 0
        ? <div className="hint warn" role="alert">Pick at least one day.</div>
        : (
          <div className="hint">
            {period === "day"
              ? "On other days nothing is asked, and they are never counted as missed."
              : `The target is for the whole ${period}; its pace is spread over these days.`}
            {" "}Money waiting on an answer counts. Idle time and life activities don&apos;t.
            {goal && (asksAnew
              ? " Changing what it measures starts its results again."
              : " A new target or new days apply from today; past results stay as they were.")}
          </div>
        )}
      <div className="controls">
        <button className="btn primary" disabled={!next} onClick={save}>{goal ? "Save goal" : "Set goal"}</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
