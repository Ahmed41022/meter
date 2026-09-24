import { useMemo, useRef, useState } from "react";
import { elapsedMs, isRunning } from "../domain/time.js";
import { earningsCents, formatMoney, formatShortDuration } from "../domain/money.js";
import { validateProject } from "../domain/projects.js";
import { isDone } from "../domain/objectives.js";
import { rateFor } from "../domain/tasks.js";
import { wordsFor } from "./words.js";

export const CURRENCIES = ["EGP", "USD", "EUR", "GBP", "SAR", "AED"];

/**
 * The Work tab and the Life tab are the same list asking different questions.
 *
 * Work asks what it earned. Life asks how long it took, and never shows a rate
 * or a currency — demanding one for something that cannot earn is what drove
 * the 0.00001 workaround in the first place.
 *
 * The caller decides which projects belong here; this only decides how to read
 * them.
 */
export default function ProjectsView({
  scope = "work", projects, sessions, objectives = [], now,
  onOpen, onAdd, onExport, onImport,
}) {
  const life = scope === "life";
  const w = wordsFor(life);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", rate: "", currency: CURRENCIES[0] });
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  // Money is summed per currency — adding EGP to USD would be a lie. There is
  // no money on the Life tab at all, so its headline counts time instead.
  const totals = useMemo(() => {
    if (life) return [];
    const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
    const acc = {};
    sessions.forEach((s) => {
      const project = byId[s.projectId];
      if (!project) return;
      acc[s.currency] = (acc[s.currency] || 0)
        + earningsCents(rateFor(project, s), elapsedMs(s, now));
    });
    return Object.entries(acc);
  }, [life, projects, sessions, now]);

  const trackedMs = useMemo(() => {
    if (!life) return 0;
    const mine = new Set(projects.map((p) => p.id));
    return sessions.filter((s) => mine.has(s.projectId))
      .reduce((total, s) => total + elapsedMs(s, now), 0);
  }, [life, projects, sessions, now]);

  const openCount = (projectId) =>
    objectives.filter((o) => o.projectId === projectId && !isDone(o)).length;

  const submit = () => {
    const problem = validateProject(form, { needsRate: !life });
    if (problem) return setError(problem);
    // Off the clock carries no rate, and nothing reads its currency, but the
    // record keeps the same shape so every accessor stays uniform.
    onAdd({ ...form, rate: life ? 0 : Number(form.rate), offClock: life });
    setForm({ name: "", rate: "", currency: form.currency });
    setError("");
    setAdding(false);
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <>
      <div className="grand">
        <span className="eyebrow">
          {life ? "Tracked across everything" : "Earned across everything"}
        </span>
        {life ? (
          <div className="grand-amt">{trackedMs ? formatShortDuration(trackedMs) : "—"}</div>
        ) : totals.length === 0 ? (
          <div className="grand-amt">—</div>
        ) : totals.map(([cur, cents]) => (
          <div className="grand-amt" key={cur}>{formatMoney(cents, cur)}</div>
        ))}
      </div>

      <div className="stack">
        {projects.length === 0 && !adding && (
          <div className="panel empty">
            {life
              ? "Nothing here yet. Add something you track but don’t work — sleep, play, time away."
              : "Nothing here yet. Add a project with its hourly rate, then start the meter."}
          </div>
        )}

        {projects.map((p) => {
          const mine = sessions.filter((s) => s.projectId === p.id);
          const ms = mine.reduce((a, s) => a + elapsedMs(s, now), 0);
          const cents = life
            ? 0
            : mine.reduce((a, s) => a + earningsCents(rateFor(p, s), elapsedMs(s, now)), 0);
          const open = openCount(p.id);
          return (
            <button className={"card" + (life ? " off" : "")} key={p.id}
                    onClick={() => onOpen(p.id)}>
              <span>
                <span className="card-name">
                  {mine.some(isRunning) && <span className="dot" />}
                  {p.name}
                </span>
                <span className="card-meta">
                  {life
                    ? `${mine.length} entr${mine.length === 1 ? "y" : "ies"}`
                    : `${formatMoney(Math.round(p.currentRate * 100), p.currency)}/hr · ${
                        mine.length} session${mine.length === 1 ? "" : "s"}`}
                  {open > 0 && ` · ${open} to do`}
                </span>
              </span>
              <span>
                <span className="card-amt">
                  {life ? (ms ? formatShortDuration(ms) : "—") : formatMoney(cents, p.currency)}
                </span>
                <span className="card-dur">
                  {life ? "tracked" : (ms ? formatShortDuration(ms) : "no time yet")}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="sec">
        {adding ? (
          <div className="panel">
            <span className="eyebrow">New {w.projectNoun}</span>
            <div style={{ height: 14 }} />
            <label className="field">
              <span className="eyebrow">Name</span>
              <input className="inp" value={form.name} autoFocus
                     placeholder={life ? "Sleep" : "Acme dashboard"}
                     onChange={set("name")} onKeyDown={(e) => e.key === "Enter" && submit()} />
            </label>
            {life ? (
              <div className="hint">
                No rate: this is time you track but don’t work. It stays out of earnings,
                billed hours and the project breakdown.
              </div>
            ) : (
              <div className="pair">
                <label className="field">
                  <span className="eyebrow">Hourly rate</span>
                  <input className="inp" type="number" min="0" step="any" value={form.rate}
                         placeholder="450" onChange={set("rate")}
                         onKeyDown={(e) => e.key === "Enter" && submit()} />
                </label>
                <label className="field">
                  <span className="eyebrow">Currency</span>
                  <select className="inp" value={form.currency} onChange={set("currency")}>
                    {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              </div>
            )}
            {error && <div className="err">{error}</div>}
            <div className="controls">
              <button className="btn primary" onClick={submit}>Add {w.projectNoun}</button>
              <button className="btn ghost" onClick={() => { setAdding(false); setError(""); }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="controls">
            <button className="btn primary" onClick={() => setAdding(true)}>
              New {w.projectNoun}
            </button>
            <button className="btn ghost" onClick={onExport}>Export backup</button>
            <button className="btn ghost" onClick={() => fileRef.current?.click()}>Restore</button>
            <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }}
                   onChange={(e) => {
                     const f = e.target.files?.[0];
                     if (f) onImport(f);
                     e.target.value = "";
                   }} />
          </div>
        )}
      </div>
    </>
  );
}
