import { useMemo, useRef, useState } from "react";
import { elapsedMs, isRunning } from "../domain/time.js";
import { earningsCents, formatMoney, formatShortDuration } from "../domain/money.js";
import {
  companyOf, isDone as projectDone, isPaused, searchProjects, validateProject,
} from "../domain/projects.js";
import { isCancelled, isPending, isPieceOnly, perTask } from "../domain/earnings.js";
import { isDone } from "../domain/objectives.js";
import { rateFor } from "../domain/tasks.js";
import { countWord, daysWord, wordsFor } from "./words.js";

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
  scope = "work", projects, sessions, earnings = [], objectives = [], now,
  onOpen, onAdd, onExport, onImport, onExportCsv, backup,
}) {
  const life = scope === "life";
  const w = wordsFor(life);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    name: "", rate: "", perTask: "", currency: CURRENCIES[0],
  });
  /** Which price the form is asking for. Not a property of the project so much
   *  as of the question: a project can end up carrying both. */
  const [model, setModel] = useState("hourly");
  const [error, setError] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [query, setQuery] = useState("");
  const fileRef = useRef(null);

  // Money is summed per currency — adding EGP to USD would be a lie. There is
  // no money on the Life tab at all, so its headline counts time instead.
  const totals = useMemo(() => {
    if (life) return [];
    const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
    const acc = {};
    sessions.forEach((s) => {
      const project = byId[s.projectId];
      if (!project || isPending(s) || isCancelled(s)) return;
      acc[s.currency] = (acc[s.currency] || 0)
        + earningsCents(rateFor(project, s), elapsedMs(s, now));
    });
    // Money that never came from an hour still belongs in what you have
    // earned. Leaving it out understated the headline by more than half on a
    // ledger where most of the work was paid per accepted item.
    earnings.forEach((e) => {
      if (!byId[e.projectId] || isPending(e) || isCancelled(e)) return;
      acc[e.currency] = (acc[e.currency] || 0) + e.cents;
    });
    return Object.entries(acc);
  }, [life, projects, sessions, earnings, now]);

  const trackedMs = useMemo(() => {
    if (!life) return 0;
    const mine = new Set(projects.map((p) => p.id));
    return sessions.filter((s) => mine.has(s.projectId))
      .reduce((total, s) => total + elapsedMs(s, now), 0);
  }, [life, projects, sessions, now]);

  const openCount = (projectId) =>
    objectives.filter((o) => o.projectId === projectId && !isDone(o)).length;

  const submit = () => {
    const problem = validateProject(form, { needsRate: !life, model });
    if (problem) return setError(problem);
    const piece = !life && model === "perTask";
    onAdd({
      ...form,
      // Off the clock carries no rate, and nothing reads its currency, but the
      // record keeps the same shape so every accessor stays uniform. Work paid
      // per item carries no rate either, and for a sharper reason: money is
      // derived from rate x elapsed, so any rate invented to satisfy this form
      // would report income that never arrived.
      rate: life || piece ? 0 : Number(form.rate),
      offClock: life,
      perTask: piece ? Number(form.perTask) : null,
      // Per-item work is, by definition, worth something only once the item is
      // accepted — so its sessions start pending rather than counted.
      paysOnAcceptance: piece,
    });
    setForm({ name: "", rate: "", perTask: "", currency: form.currency });
    setError("");
    setAdding(false);
  };

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  /** One card. Defined once and handed to both groups, so a finished project
   *  reads exactly like a live one — it is filed away, not diminished. */
  const card = (p) => {
    const mine = sessions.filter((s) => s.projectId === p.id);
    const ms = mine.reduce((a, s) => a + elapsedMs(s, now), 0);
    const settled = (s) => !isPending(s) && !isCancelled(s);
    const cents = life
      ? 0
      : mine.filter(settled).reduce((a, s) => a + earningsCents(rateFor(p, s), elapsedMs(s, now)), 0)
        + earnings.filter((e) => e.projectId === p.id && settled(e)).reduce((a, e) => a + e.cents, 0);
    const waiting = life ? 0
      : mine.filter(isPending).reduce((a, s) => a + earningsCents(rateFor(p, s), elapsedMs(s, now)), 0)
        + earnings.filter((e) => e.projectId === p.id && isPending(e)).reduce((a, e) => a + e.cents, 0);
    const open = openCount(p.id);
    const company = life ? null : companyOf(p);
    const stopped = isPaused(p) || projectDone(p);
    return (
      <button className={"card" + (life ? " off" : "") + (stopped ? " stopped" : "")} key={p.id}
              onClick={() => onOpen(p.id)}>
        <span>
          <span className="card-name">
            {mine.some(isRunning) && <span className="dot" />}
            {p.name}
            {isPaused(p) && <span className="tag">Paused</span>}
          </span>
          <span className="card-meta">
            {company && `${company} · `}
            {life
              ? `${mine.length} entr${mine.length === 1 ? "y" : "ies"}`
              // A project paid per accepted item has no hourly rate, and
              // printing currentRate gave it a confident $0.00/hr.
              : `${isPieceOnly(p)
                ? `${formatMoney(Math.round(perTask(p) * 100), p.currency)} per task`
                : `${formatMoney(Math.round(p.currentRate * 100), p.currency)}/hr`} · ${
                  mine.length} session${mine.length === 1 ? "" : "s"}`}
            {open > 0 && !stopped && ` · ${open} to do`}
          </span>
        </span>
        <span>
          <span className="card-amt">
            {life ? (ms ? formatShortDuration(ms) : "—") : formatMoney(cents, p.currency)}
          </span>
          <span className="card-dur">
            {life ? "tracked" : (ms ? formatShortDuration(ms) : "no time yet")}
            {waiting !== 0 && ` · ${formatMoney(waiting, p.currency)} pending`}
          </span>
        </span>
      </button>
    );
  };

  /** Finished work is filed, not deleted. Paused stays in the live list,
   *  because "not now" is a different statement from "over". */
  // Searching narrows the LIST only. The headline above still totals every
  // project, because what you have earned does not change while you look for
  // something.
  const matching = searchProjects(projects, query);
  const running = matching.filter((p) => !projectDone(p));
  const finished = matching.filter(projectDone);
  const searching = query.trim() !== "";
  // Worth a box only once the list is long enough to lose something in. Kept
  // visible while a query is live, so it never vanishes mid-search.
  const searchable = projects.length > 6 || searching;
  // A match inside a collapsed group is a match the reader cannot see.
  const openFinished = showDone || searching;

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

      {searchable && (
        <div className="finder">
          <input className="find" type="search" value={query} placeholder={`Find a ${w.projectNoun}`}
                 aria-label={`Find a ${w.projectNoun}`}
                 onChange={(e) => setQuery(e.target.value)} />
          {searching && (
            <button className="linkish find-clear" onClick={() => setQuery("")}>Clear</button>
          )}
        </div>
      )}

      <div className="stack">
        {searching && matching.length === 0 && (
          <div className="panel empty">
            Nothing matches “{query.trim()}”.
          </div>
        )}

        {!searching && running.length === 0 && !adding && (
          <div className="panel empty">
            {finished.length > 0
              ? "Nothing running. Everything here is finished — it's all still below."
              : life
                ? "Nothing here yet. Add something you track but don’t work — sleep, play, time away."
                : "Nothing here yet. Add a project with its hourly rate, then start the meter."}
          </div>
        )}

        {running.map(card)}
      </div>

      {/* Finished projects are filed away rather than deleted: the hours
          happened and every total still counts them. Collapsed by default,
          because the list you work from is the live one. */}
      {finished.length > 0 && (
        <div className="sec" style={{ marginTop: 18 }}>
          <button className="done-head" aria-expanded={openFinished}
                  onClick={() => setShowDone((v) => !v)}>
            <span className={"chev" + (openFinished ? " open" : "")}>▶</span>
            <span className="eyebrow">
              Done · {finished.length}{searching && ` matching`}
            </span>
          </button>
          {openFinished && <div className="stack">{finished.map(card)}</div>}
        </div>
      )}


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
                           onChange={set(model === "perTask" ? "perTask" : "rate")}
                           onKeyDown={(e) => e.key === "Enter" && submit()} />
                  </label>
                  <label className="field">
                    <span className="eyebrow">Currency</span>
                    <select className="inp" value={form.currency} onChange={set("currency")}>
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
              </>
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
            <button className={"btn " + (backup?.stale ? "primary" : "ghost")} onClick={onExport}>
              Export backup
            </button>
            <button className="btn ghost" onClick={() => fileRef.current?.click()}>Restore</button>
            {!life && onExportCsv && (
              <button className="btn ghost" onClick={onExportCsv}>Export CSV</button>
            )}
            <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }}
                   onChange={(e) => {
                     const f = e.target.files?.[0];
                     if (f) onImport(f);
                     e.target.value = "";
                   }} />
          </div>
        )}
        {/* Stated whether or not it is overdue: a reader should be able to see
            that the last copy is recent, not have to trust the silence. */}
        {!life && backup && (
          <p className="backup-note">
            {backup.never
              ? "No backup has ever been exported."
              : `Last backup ${daysWord(backup.days)}.`}
            {backup.unsaved > 0 && ` ${countWord(backup.unsaved)} since.`}
          </p>
        )}
      </div>
    </>
  );
}
