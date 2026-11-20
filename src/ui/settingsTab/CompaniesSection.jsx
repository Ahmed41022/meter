import { useState } from "react";
import { describePeriod, paydayFor, samePeriod, storedPeriod } from "../../domain/payPeriod.js";
import { periodForm, periodOf } from "../settings/form.js";
import PayScheduleFields from "../settings/PayScheduleFields.jsx";
import { payDay } from "../PaymentAnswer.jsx";

const projectsWord = (n) => (n === 0 ? "No current projects" : `${n} project${n === 1 ? "" : "s"}`);

/**
 * One client's schedule being edited, in the row it belongs to.
 *
 * The form state is its own and is built from the stored rule when the editor
 * opens, so closing it throws the edits away and opening it again starts from
 * what is saved. The same boxes as the project's Settings panel, through the
 * same `periodForm` / `periodOf` pair, so a schedule means the same thing
 * wherever it is typed.
 */
function ScheduleEditor({ company, now, onSave, onCancel }) {
  const [form, setForm] = useState(() => periodForm(company.rule));
  const setPeriod = (patch) => setForm((f) => ({ ...f, ...patch }));
  const rule = periodOf(form);
  // A half-typed monthly day reads back as no rule at all; saving that would
  // quietly clear the schedule, so it is not a change that can be saved.
  const usable = form.kind === "none" || storedPeriod(rule) !== null;
  const dirty = !samePeriod(rule, company.rule);
  const save = () => { if (dirty && usable) onSave(company.name, rule); };
  const onKey = (e) => { if (e.key === "Enter") save(); };
  return (
    <div className="company-edit">
      {/* Said before Save, because the schedule is the client's: saving
          changes the payday of every project under it, not only one. */}
      <div className="hint warn" style={{ marginTop: 0 }}>
        This schedule is shared by every {company.name} project
        {company.projects > 1 ? ` (${company.projects} of them)` : ""}, so saving changes the
        payday of all of them.
      </div>
      <PayScheduleFields period={form} setPeriod={setPeriod} rule={rule} now={now}
                         target={company.name} onKey={onKey} paysOnAcceptance={null} />
      <div className="controls">
        <button className="btn primary" disabled={!dirty || !usable} onClick={save}>Save</button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * Every client and its payday in one place.
 *
 * A payday belongs to the client, but until now it could only be reached from
 * inside one of that client's projects. Here they are listed together, with
 * the schedule in words and the next date it gives, and one at a time can be
 * opened for editing.
 */
export default function CompaniesSection({ companies, now, onSave }) {
  const [editing, setEditing] = useState(null);
  return (
    <section className="settings-sec" aria-labelledby="settings-companies">
      <h2 className="settings-title" id="settings-companies">Companies &amp; paydays</h2>
      {companies.length === 0 ? (
        <div className="panel">
          <div className="hint" style={{ margin: 0 }}>
            No clients yet. One appears here once a work project names a company.
          </div>
        </div>
      ) : (
        <div className="panel company-list">
          {companies.map((c) => {
            // A date on the client's own clock, printed as that date, as the
            // Overview prints a payday.
            const next = c.rule ? paydayFor(c.rule, now) : null;
            return (
              <div className="company-row" key={c.name.toLowerCase()}>
                <div className="company-head">
                  <strong className="company-name">{c.name}</strong>
                  {editing !== c.name && (
                    <button className="linkish" onClick={() => setEditing(c.name)}
                            aria-label={`Edit ${c.name}`}>
                      Edit
                    </button>
                  )}
                </div>
                <div className="company-meta">
                  {c.rule ? describePeriod(c.rule) : "No schedule"}
                </div>
                <div className="company-meta">
                  {projectsWord(c.projects)}
                  {next && <> · next payday <strong>{payDay(next.date)}</strong></>}
                </div>
                {editing === c.name && (
                  <ScheduleEditor company={c} now={now} onCancel={() => setEditing(null)}
                                  onSave={(name, rule) => { onSave(name, rule); setEditing(null); }} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
