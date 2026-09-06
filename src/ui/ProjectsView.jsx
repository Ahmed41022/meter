import { useMemo, useRef, useState } from "react";
import { elapsedMs, isRunning } from "../domain/time.js";
import { earningsCents, formatMoney, formatShortDuration } from "../domain/money.js";
import { validateProject } from "../domain/projects.js";
import { rateFor } from "../domain/tasks.js";

export const CURRENCIES = ["EGP", "USD", "EUR", "GBP", "SAR", "AED"];

export default function ProjectsView({ projects, sessions, now, onOpen, onAdd, onExport, onImport }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", rate: "", currency: CURRENCIES[0] });
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  // Totals are summed per currency — adding EGP to USD would be a lie.
  const totals = useMemo(() => {
    const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
    const acc = {};
    sessions.forEach((s) => {
      const cents = earningsCents(rateFor(byId[s.projectId], s), elapsedMs(s, now));
      acc[s.currency] = (acc[s.currency] || 0) + cents;
    });
    return Object.entries(acc);
  }, [projects, sessions, now]);

  const submit = () => {
    const problem = validateProject(form);
    if (problem) return setError(problem);
    onAdd({ ...form, rate: Number(form.rate) });
    setForm({ name: "", rate: "", currency: form.currency });
    setError("");
    setAdding(false);
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <>
      <div className="grand">
        <span className="eyebrow">Earned across everything</span>
        {totals.length === 0
          ? <div className="grand-amt">—</div>
          : totals.map(([cur, cents]) => (
              <div className="grand-amt" key={cur}>{formatMoney(cents, cur)}</div>
            ))}
      </div>

      <div className="stack">
        {projects.length === 0 && !adding && (
          <div className="panel empty">
            Nothing here yet. Add a project with its hourly rate, then start the meter.
          </div>
        )}

        {projects.map((p) => {
          const mine = sessions.filter((s) => s.projectId === p.id);
          const cents = mine.reduce((a, s) => a + earningsCents(rateFor(p, s), elapsedMs(s, now)), 0);
          const ms = mine.reduce((a, s) => a + elapsedMs(s, now), 0);
          return (
            <button className="card" key={p.id} onClick={() => onOpen(p.id)}>
              <span>
                <span className="card-name">
                  {mine.some(isRunning) && <span className="dot" />}
                  {p.name}
                </span>
                <span className="card-meta">
                  {formatMoney(Math.round(p.currentRate * 100), p.currency)}/hr ·{" "}
                  {mine.length} session{mine.length === 1 ? "" : "s"}
                </span>
              </span>
              <span>
                <span className="card-amt">{formatMoney(cents, p.currency)}</span>
                <span className="card-dur">{ms ? formatShortDuration(ms) : "no time yet"}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="sec">
        {adding ? (
          <div className="panel">
            <span className="eyebrow">New project</span>
            <div style={{ height: 14 }} />
            <label className="field">
              <span className="eyebrow">Name</span>
              <input className="inp" value={form.name} autoFocus placeholder="Acme dashboard"
                     onChange={set("name")} onKeyDown={(e) => e.key === "Enter" && submit()} />
            </label>
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
            {error && <div className="err">{error}</div>}
            <div className="controls">
              <button className="btn primary" onClick={submit}>Add project</button>
              <button className="btn ghost" onClick={() => { setAdding(false); setError(""); }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="controls">
            <button className="btn primary" onClick={() => setAdding(true)}>New project</button>
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
