/**
 * To-dos: the general list on the Today tab.
 *
 * They are not objectives. An objective belongs to a project and is measured
 * against it — an estimate, the hours its task took. A to-do is anything you
 * mean to do ("renew the domain", "email Mars Corp"), most of it no project's
 * business, so it lives in its own list and asks for nothing but its words.
 *
 * One may name a project, and then it can start that project's meter. That is
 * the whole of the link: it measures nothing, so a to-do whose project is
 * removed simply reads as unlinked rather than vanishing with it. The intent
 * outlives the bucket, as an objective's does.
 *
 * Like every other record, a to-do is never removed, only stamped
 * `deletedAt`, so a delete syncs as an edit and comes back with Undo.
 */

/** Stores written before to-dos existed have no array at all, and that
 *  absence reads as "none" rather than needing a schema bump. */
export const allTodos = (state) => state.todos ?? [];

export const liveTodos = (state) => allTodos(state).filter((t) => !t.deletedAt);

export const isDone = (todo) => !!todo.done;

const mapTodos = (state, fn) => ({ ...state, todos: allTodos(state).map(fn) });

const clean = (text) => String(text ?? "").trim();

export const addTodo = (state, { text, projectId = null }, now, id) => {
  const words = clean(text);
  if (!words) return state;
  return {
    ...state,
    todos: [
      ...allTodos(state),
      { id, text: words, projectId: projectId || null, done: false, doneAt: null, createdAt: now, deletedAt: null },
    ],
  };
};

/** Ticking records when, so the done list can put the latest first. */
export const toggleTodo = (state, id, now) =>
  mapTodos(state, (t) => (t.id === id ? { ...t, done: !t.done, doneAt: t.done ? null : now } : t));

export const editTodo = (state, id, { text, projectId }) =>
  mapTodos(state, (t) => {
    if (t.id !== id) return t;
    const next = { ...t };
    if (text !== undefined) {
      const words = clean(text);
      if (!words) return t; // a blank rename is a slip, not an instruction
      next.text = words;
    }
    if (projectId !== undefined) next.projectId = projectId || null;
    return next;
  });

export const removeTodo = (state, id, now) =>
  mapTodos(state, (t) => (t.id === id ? { ...t, deletedAt: now } : t));

/** Every done to-do at once, for "Clear done". Returns the ids it cleared so
 *  the caller's Undo puts back those and only those — not one removed
 *  separately before. */
export const clearDone = (state, now) => {
  const ids = liveTodos(state).filter(isDone).map((t) => t.id);
  const gone = new Set(ids);
  return { state: mapTodos(state, (t) => (gone.has(t.id) ? { ...t, deletedAt: now } : t)), ids };
};

export const restoreTodos = (state, ids) => {
  const back = new Set(ids);
  return mapTodos(state, (t) => (back.has(t.id) ? { ...t, deletedAt: null } : t));
};

/** What is left, in the order it was written down. */
export const openTodos = (todos) =>
  todos.filter((t) => !isDone(t)).sort((a, b) => a.createdAt - b.createdAt);

/** What is finished, the latest first: the fold opens on what you just did. */
export const doneTodos = (todos) =>
  todos.filter(isDone).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));

/** The project a to-do names, while it still exists. A removed one is not in
 *  the list handed in, so its to-dos read as unlinked. */
export const linkedProject = (todo, projects) =>
  (todo.projectId && projects.find((p) => p.id === todo.projectId)) || null;
