import { useState } from "react";
import { companiesIn, validateProject } from "../domain/projects.js";
import { REWARD } from "../domain/earnings.js";
import { normaliseGoal } from "../domain/goals.js";
import { describePeriod, findCompany, liveCompanies, storedPeriod } from "../domain/payPeriod.js";
import { HOUR, periodForm, periodOf } from "./settings/form.js";
import { goalFields } from "./settings/goalFields.jsx";
import PayScheduleFields from "./settings/PayScheduleFields.jsx";

export const CURRENCIES = ["EGP", "USD", "EUR", "GBP", "SAR", "AED"];

const blank = (currency) => ({
  name: "", rate: "", perTask: "", currency, company: "",
  parallel: false, limit: "", over: "", reward: "none", each: "", perHour: "",
  sessionGoal: { type: "money", target: "" },
  overallGoal: { type: "money", target: "", period: "week" },
});

/**
 * The create card: everything a project can be told when it is made, so it
 * does not have to be opened and set up a second time.
 *
 * Up front is what decides how the money is counted (name, how it pays, the
 * rate, the currency) and who it is for. The company comes with its payday:
 * a client that already has one is paid on it, said in words; a client that
 * has none can be given one here, which is the client's and so is shared by
 * every project under it. The rest (a per-task time limit, what acceptance
 * pays, the goals) is under "More settings", closed by default, all optional,
 * and the same boxes as the project's own Settings.
 *
 * Off the clock has no rate, no company and no acceptance, so on the Life tab
 * the card asks for a name and, if wanted, the goals.
 */
export default function NewProject({
  life, projects = [], companies = [], now = Date.now(), noun, onAdd, onCancel,
}) {
  const [form, setForm] = useState(() => blank(CURRENCIES[0]));
  /** Which price the form is asking for. Not a property of the project so much
   *  as of the question: a project can end up carrying both. */
  const [model, setModel] = useState("hourly");
  const [period, setPeriodState] = useState(() => periodForm(null));
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const field = (key) => (e) => set({ [key]: e.target.value });
  const setPeriod = (patch) => setPeriodState((p) => ({ ...p, ...patch }));
  const piece = !life && model === "perTask";

  // Every client named so far, on a project or with a payday of its own.
  const clients = [...new Set([
    ...companiesIn(projects),
    ...liveCompanies({ companies }).map((c) => c.name),
  ])].sort((a, b) => a.localeCompare(b));
  const target = form.company.trim();
  const client = target ? findCompany({ companies }, target) : null;
  const theirs = storedPeriod(client?.payPeriod) ?? null;
  const rule = periodOf(period);

  const limitHours = Number(form.limit);
  const overPct = form.over.trim() === "" ? 0 : Number(form.over);
  // The project's goals read time only, off the clock.
  const asGoal = (goal) => normaliseGoal(life ? { ...goal, type: "time" } : goal);

  /** What is wrong with the optional part, or null. Said rather than dropped:
   *  a limit typed and silently not kept reads as a limit that is in force. */
  const moreProblem = () => {
    if (life) return null;
    if (form.limit.trim() !== "" && (!(limitHours > 0) || !(overPct >= 0))) {
      return "A time limit has to be hours above zero, and what time over it pays a percentage from 0 up.";
    }
    if (!piece && form.reward === REWARD.PER_TASK && !(Number(form.each) > 0)) {
      return "What does an accepted task pay? A number above zero.";
    }
    if (!piece && form.reward === REWARD.PER_HOUR && !(Number(form.perHour) > 0)) {
      return "What does an accepted hour pay on top? A number above zero.";
    }
    return null;
  };

  const submit = () => {
    const problem = validateProject(form, { needsRate: !life, model }) ?? moreProblem();
    if (problem) {
      setError(problem);
      // A problem in the closed part would be a message about boxes nobody
      // can see.
      if (!validateProject(form, { needsRate: !life, model })) setMore(true);
      return;
    }
    const reward = piece ? REWARD.PER_TASK : form.reward;
    onAdd({
      name: form.name,
      currency: form.currency,
      // Off the clock carries no rate, and nothing reads its currency, but the
      // record keeps the same shape so every accessor stays uniform. Work paid
      // per item carries no rate either, and for a sharper reason: money is
      // derived from rate x elapsed, so any rate invented to satisfy this form
      // would report income that never arrived.
      rate: life || piece ? 0 : Number(form.rate),
      offClock: life,
      perTask: piece ? Number(form.perTask)
        : reward === REWARD.PER_TASK ? Number(form.each) : null,
      // Per-item work is, by definition, worth something only once the item is
      // accepted — so its sessions start pending rather than counted.
      paysOnAcceptance: piece,
      // A client already known is filed under the spelling it already has,
      // so "alignerr" typed in a hurry does not print as a second client.
      company: life ? "" : (client?.name ?? clients.find((c) => c.toLowerCase() === target.toLowerCase()) ?? target),
      bonusPerHour: !life && reward === REWARD.PER_HOUR ? Number(form.perHour) : null,
      taskLimit: !life && form.limit.trim() !== ""
        ? { ms: Math.round(limitHours * HOUR), factor: overPct / 100 } : null,
      parallelTasks: !life && form.parallel,
      sessionGoal: asGoal(form.sessionGoal),
      overallGoal: asGoal(form.overallGoal),
    // A payday only for a client that has none: one that has a schedule keeps
    // it, and changing it is a change for every project it pays.
    }, !life && target && !theirs && rule ? rule : null);
    setForm(blank(form.currency));
    setPeriodState(periodForm(null));
    setModel("hourly");
    setMore(false);
    setError("");
  };

  const onKey = (e) => { if (e.key === "Enter") submit(); };
  // The goal boxes are the project's own; they only need to know whether
  // this one can earn.
  const shape = { offClock: life, currency: form.currency };
  const setGoal = (patch) => set(patch);

  return (
    <div className="panel newproject">
      <span className="eyebrow">New {noun}</span>
      <div style={{ height: 14 }} />
      <label className="field">
        <span className="eyebrow">Name</span>
        <input className="inp" value={form.name} autoFocus
               placeholder={life ? "Sleep" : "Acme dashboard"}
               onChange={field("name")} onKeyDown={onKey} />
      </label>
      {life ? (
        <div className="hint">
          No rate: this is time you track but don’t work. It stays out of earnings,
          billed hours and the project breakdown.
        </div>
      ) : (
        <>
          <div className="field">
            <span className="eyebrow">How it pays</span>
            <div className="modes" role="tablist" aria-label="How this project pays">
              {[["hourly", "By the hour"], ["perTask", "Per task"]].map(([key, label]) => (
                <button key={key} role="tab" aria-selected={model === key}
                        className={"seg-btn" + (model === key ? " on" : "")}
                        onClick={() => { setModel(key); setError(""); }}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="pair">
            <label className="field">
              <span className="eyebrow">
                {model === "perTask" ? "Per accepted task" : "Hourly rate"}
              </span>
              <input className="inp" type="number" min="0" step="any"
                     value={model === "perTask" ? form.perTask : form.rate}
                     placeholder={model === "perTask" ? "250" : "450"}
                     onChange={field(model === "perTask" ? "perTask" : "rate")}
                     onKeyDown={onKey} />
            </label>
            <label className="field">
              <span className="eyebrow">Currency</span>
              <select className="inp" value={form.currency} onChange={field("currency")}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>
          {model === "perTask" && (
            <div className="hint">
              The clock still runs, so you can see what an hour of it came to — but the
              money comes from the tasks you log as accepted, not from the time.
            </div>
          )}

          <label className="field">
            <span className="eyebrow">Company</span>
            <input className="inp" value={form.company} list="meter-new-companies"
                   placeholder="who it's for — optional" aria-label="Company"
                   onChange={field("company")} onKeyDown={onKey} />
          </label>
          <datalist id="meter-new-companies">
            {clients.map((c) => <option key={c} value={c} />)}
          </datalist>
          {target && theirs && (
            <div className="hint newproject-payday">
              Paid on {client.name}&apos;s payday: <strong>{describePeriod(theirs)}</strong>{" "}
              It is shared by every {client.name} project; change it in Settings → Companies
              &amp; paydays.
            </div>
          )}
          {target && !theirs && (
            <>
              <div className="sec-head" style={{ marginTop: 18 }}>
                <span className="eyebrow">Payday</span>
                <span className="eyebrow">{target}</span>
              </div>
              <div className="hint" style={{ marginTop: 0 }}>
                {target} has no payday yet. Set one here and every {target} project will use
                it, or leave it for later.
              </div>
              <PayScheduleFields period={period} setPeriod={setPeriod} rule={rule} now={now}
                                 target={target} onKey={onKey} paysOnAcceptance={piece} />
            </>
          )}
        </>
      )}

      <button type="button" className="done-head newproject-more" aria-expanded={more}
              onClick={() => setMore((v) => !v)}>
        <span className={"chev" + (more ? " open" : "")}>▶</span>
        <span className="eyebrow">More settings</span>
      </button>
      {more && (
        <div className="newproject-extra">
          {!life && (
            <>
              <div className="pair">
                <label className="field">
                  <span className="eyebrow">Time limit per task (hours)</span>
                  <input className="inp" type="number" min="0" step="any" value={form.limit}
                         placeholder="none" onChange={field("limit")} onKeyDown={onKey} />
                </label>
                <label className="field">
                  <span className="eyebrow">Time over it pays (% of rate)</span>
                  <input className="inp" type="number" min="0" step="any" value={form.over}
                         placeholder="0 = unpaid" disabled={form.limit.trim() === ""}
                         onChange={field("over")} onKeyDown={onKey} />
                </label>
              </div>
              {form.limit.trim() !== "" && limitHours > 0 && overPct >= 0 && (
                <div className="hint">
                  A task&apos;s first {+limitHours.toFixed(2)}h of billed time pay the full rate;
                  time over it pays {overPct === 0 ? "nothing" : `${+overPct.toFixed(2)}% of it`}.
                </div>
              )}
              {!piece && (
                <>
                  <div className="sec-head" style={{ marginTop: 18 }}>
                    <span className="eyebrow">Acceptance reward</span>
                  </div>
                  <div className="modes" role="tablist" aria-label="What acceptance pays">
                    {[["none", "Nothing"], [REWARD.PER_TASK, "A flat amount"],
                      [REWARD.PER_HOUR, "More per hour"]].map(([key, label]) => (
                      <button key={key} type="button" role="tab" aria-selected={form.reward === key}
                              className={"seg-btn" + (form.reward === key ? " on" : "")}
                              onClick={() => set({ reward: key })}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {form.reward === REWARD.PER_TASK && (
                    <label className="field" style={{ marginTop: 14 }}>
                      <span className="eyebrow">Per accepted task ({form.currency})</span>
                      <input className="inp" type="number" min="0" step="any" value={form.each}
                             placeholder="what one accepted item pays"
                             onChange={field("each")} onKeyDown={onKey} />
                    </label>
                  )}
                  {form.reward === REWARD.PER_HOUR && (
                    <label className="field" style={{ marginTop: 14 }}>
                      <span className="eyebrow">Extra per hour once accepted ({form.currency})</span>
                      <input className="inp" type="number" min="0" step="any" value={form.perHour}
                             placeholder="on top of the hourly rate"
                             onChange={field("perHour")} onKeyDown={onKey} />
                    </label>
                  )}
                </>
              )}
            </>
          )}
          {!life && (
            <>
              <div className="sec-head" style={{ marginTop: 18 }}>
                <span className="eyebrow">Parallel tasks</span>
              </div>
              <div className="modes" role="tablist" aria-label="Whether its tasks can run in parallel">
                {[[false, "One at a time"], [true, "Allowed"]].map(([on, label]) => (
                  <button key={label} type="button" role="tab" aria-selected={form.parallel === on}
                          className={"seg-btn" + (form.parallel === on ? " on" : "")}
                          onClick={() => set({ parallel: on })}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="hint">
                Allowed lets several of its tasks run at once, and beside other projects.
              </div>
            </>
          )}
          <div className="sec-head" style={{ marginTop: 18 }}>
            <span className="eyebrow">Session goal</span>
          </div>
          {goalFields(shape, setGoal, "sessionGoal", form.sessionGoal, false)}
          <div className="sec-head" style={{ marginTop: 10 }}>
            <span className="eyebrow">Overall goal</span>
          </div>
          {goalFields(shape, setGoal, "overallGoal", form.overallGoal, true)}
          <div className="hint">
            All of this can be changed later in the project&apos;s Settings.
          </div>
        </div>
      )}

      {error && <div className="err">{error}</div>}
      <div className="controls">
        <button className="btn primary" onClick={submit}>Add {noun}</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
