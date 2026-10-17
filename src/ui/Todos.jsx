import { useState } from "react";
import { acceptsTime } from "../domain/projects.js";
import { doneTodos, isDone, linkedProject, openTodos } from "../domain/todos.js";

/**
 * The general to-do list at the top of the Today tab.
 *
 * Anything you mean to do, not only work. A to-do may name a project, and
 * then it offers that project's meter; otherwise it is a line and a tick box.
 * Ticked ones fold away under "Done", where they can be unticked or cleared,
 * so what is still left is what the list shows.
 */

/** The project picker, shared by the add and edit forms. */
function ProjectPick({ projects, value, onChange }) {
  return (
    <label className="field">
      <span className="eyebrow">Project</span>
      <select className="inp" value={value} onChange={onChange}>
        <option value="">None</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>
  );
}

function Form({ projects, start, label, onSave, onCancel, keepOpen = false }) {
  const [draft, setDraft] = useState(start);
  const set = (key) => (e) => setDraft((f) => ({ ...f, [key]: e.target.value }));
  const save = () => {
    if (!draft.text.trim()) return;
    onSave({ text: draft.text, projectId: draft.projectId || null });
    // Adding keeps the form open on an empty line, so a list can be written
    // down in one go; the project stays picked for the next one.
    if (keepOpen) setDraft((f) => ({ ...f, text: "" }));
  };
  return (
    <div className="obj-form">
      <label className="field">
        <span className="eyebrow">What needs doing</span>
        <input className="inp" autoFocus value={draft.text} placeholder="e.g. renew the domain"
               onChange={set("text")}
               onKeyDown={(e) => {
                 if (e.key === "Enter") save();
                 if (e.key === "Escape") onCancel();
               }} />
      </label>
      <ProjectPick projects={projects} value={draft.projectId} onChange={set("projectId")} />
      <div className="controls">
        <button className="btn primary" onClick={save}>{label}</button>
        <button className="btn ghost" onClick={onCancel}>{keepOpen ? "Done" : "Cancel"}</button>
      </div>
    </div>
  );
}

function Row({ todo, projects, running, onStart, onOpen, onToggle, onEdit, onRemove }) {
  const [editing, setEditing] = useState(false);
  const project = linkedProject(todo, projects);
  const done = isDone(todo);

  if (editing) {
    // Seeded from the to-do as it is now, each time the form opens.
    return (
      <Form projects={projects} label="Save"
            start={{ text: todo.text, projectId: project?.id ?? "" }}
            onSave={(patch) => { onEdit(todo.id, patch); setEditing(false); }}
            onCancel={() => setEditing(false)} />
    );
  }

  return (
    <div className={"obj todo" + (done ? " done" : "")}>
      <label className="obj-check">
        <input type="checkbox" checked={done} onChange={() => onToggle(todo.id)}
               aria-label={`Mark ${todo.text} ${done ? "not done" : "done"}`} />
        <span className="obj-text">{todo.text}</span>
      </label>
      {project && (
        <div className="obj-meta">
          <button className="linkish faintish" onClick={() => onOpen(project.id)}>{project.name}</button>
        </div>
      )}
      <div className="obj-actions">
        {/* Not while a meter runs: starting one stops it, and a row of
            one-click starts beside it is a row of ways to end it by accident.
            Nor on a paused or finished project, which takes no time. */}
        {project && !done && !running && acceptsTime(project) && (
          <button className="linkish todo-go" aria-label={`Start ${project.name}`}
                  onClick={() => onStart(project.id)}>▶ start</button>
        )}
        {!done && <button className="linkish" onClick={() => setEditing(true)}>edit</button>}
        <button className="x" aria-label={`Remove ${todo.text}`} onClick={() => onRemove(todo.id)}>×</button>
      </div>
    </div>
  );
}

export default function Todos({
  todos, projects, running, onStart, onOpen, onAdd, onToggle, onEdit, onRemove, onClearDone,
}) {
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const open = openTodos(todos);
  const done = doneTodos(todos);
  const row = (t) => (
    <Row key={t.id} todo={t} projects={projects} running={running} onStart={onStart}
         onOpen={onOpen} onToggle={onToggle} onEdit={onEdit} onRemove={onRemove} />
  );

  return (
    <div className="sec">
      <div className="sec-head">
        <span className="eyebrow">To do</span>
        <span className="eyebrow">{open.length > 0 && `${open.length} left`}</span>
      </div>
      <div className="panel todos">
        {open.length === 0 && done.length > 0 && !adding && (
          <div className="todo-clear">Everything on the list is done.</div>
        )}
        {open.map(row)}

        {adding ? (
          <Form projects={projects} label="Add" keepOpen start={{ text: "", projectId: "" }}
                onSave={onAdd} onCancel={() => setAdding(false)} />
        ) : (
          <button className={"linkish obj-add" + (open.length === 0 && done.length === 0 ? " first" : "")}
                  onClick={() => setAdding(true)}>
            + Add a to-do
          </button>
        )}

        {done.length > 0 && (
          <div className="todo-done">
            <div className="todo-done-head">
              <button className="linkish faintish" aria-expanded={showDone}
                      onClick={() => setShowDone((v) => !v)}>
                {showDone ? "▾" : "▸"} Done · {done.length}
              </button>
              {showDone && (
                <button className="linkish faintish" onClick={onClearDone}>Clear done</button>
              )}
            </div>
            {showDone && done.map(row)}
          </div>
        )}
      </div>
    </div>
  );
}
