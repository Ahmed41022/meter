import { elapsedMs } from "./time.js";
import { earningsCents } from "./money.js";
import { isBilled, isIdle } from "./sessions.js";
import { isCancelled } from "./earnings.js";
import { taskState } from "./taskState.js";

/**
 * A task is a record on the project, referenced by id — not a string stored on
 * each session. Free-text labels split silently on a typo ("1234" vs "1234 "),
 * and a per-task earnings total that quietly splits in two is the exact class
 * of bug this app exists to avoid. Ids also make renaming a one-field change.
 */

export const UNASSIGNED = "__unassigned__";

export const tasksFor = (project) => project?.tasks ?? [];

/** Labels are compared trimmed and case-insensitively, so the picker can't
 *  produce a duplicate the user would read as the same task. */
export const normaliseLabel = (label) => String(label ?? "").trim();
const key = (label) => normaliseLabel(label).toLowerCase();

export const findTaskByLabel = (project, label) =>
  tasksFor(project).find((t) => key(t.label) === key(label)) ?? null;

export const findTask = (project, taskId) =>
  tasksFor(project).find((t) => t.id === taskId) ?? null;

export const taskLabel = (project, taskId) =>
  findTask(project, taskId)?.label ?? "No task";

/** Adds a task unless one with the same id or label already exists.
 *  Callers generate the id, so they can reuse an existing task's id when the
 *  label already matches — see resolveTaskId. */
export const addTask = (state, projectId, { id, label, rate, factor, price, note }, now) => {
  const clean = normaliseLabel(label);
  if (!clean) return state;
  return {
    ...state,
    projects: state.projects.map((p) => {
      if (p.id !== projectId) return p;
      const existing = tasksFor(p);
      if (existing.some((t) => t.id === id || key(t.label) === key(clean))) return p;
      // Only fields that were actually given are written. An absent rate means
      // "as recorded" and an absent price means "the project's" — writing null
      // would say the same thing more loudly, and writing 0 would lie.
      const task = { id, label: clean, createdAt: now };
      if (amount(rate) !== null) task.rate = amount(rate);
      if (amount(factor) !== null) task.factor = amount(factor);
      if (amount(price) !== null) task.price = amount(price);
      // Whatever the label could not hold: a ticket URL, a platform id, what
      // the thing actually is. A label is what reports group by, so it has to
      // stay short and stable; this is where the rest goes.
      if (normaliseLabel(note)) task.note = normaliseLabel(note);
      return { ...p, tasks: [...existing, task] };
    }),
  };
};

/**
 * A number that can stand as a rate, a factor or a price, or null for "not
 * given".
 *
 * Zero counts. Empty already means "inherit whatever the project says", so
 * there has to be some way to say "this particular task pays nothing" —
 * onboarding, training, an unpaid trial — and without one the only route is to
 * type a number so small it rounds away, which is a lie that reports as income.
 */
const amount = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * What the user typed into a rate box, as either an absolute rate or a
 * proportion of whatever the session recorded.
 *
 * "30%" is not a shorthand for a number — it is a different kind of answer.
 * Assessments and overtime on some platforms pay a fixed share of the base
 * rate, so writing the arithmetic down as 4.92 makes it stale the moment the
 * base moves, and loses the one thing worth keeping: the rule. A factor keeps
 * tracking the base across every era of a project's history.
 */
export const parseTaskRate = (input) => {
  const text = String(input ?? "").trim();
  if (!text) return { rate: null, factor: null };
  if (text.endsWith("%")) {
    const pct = amount(text.slice(0, -1).trim());
    return { rate: null, factor: pct === null ? null : pct / 100 };
  }
  return { rate: amount(text), factor: null };
};

/** How a task's rate should be shown in a box the user can edit again. */
export const taskRateInput = (task) => {
  if (task?.rate != null) return String(task.rate);
  if (task?.factor != null) return `${+(task.factor * 100).toFixed(4)}%`;
  return "";
};

/**
 * The rate a session is actually valued at.
 *
 * A session snapshots the project rate when it starts, which is the right
 * default. But that snapshot is a projection of what you'll be paid, and the
 * real figure is fixed later — at submission, or whenever the client says so.
 * A rate on the task overrides the snapshot for every session filed under it,
 * so a whole task can be repriced after the fact without touching the one
 * thing that is a measurement: the hours.
 */
export const rateFor = (project, session) => {
  const task = findTask(project, session.taskId);
  if (task?.rate != null) return task.rate;
  // A proportion applies to the SNAPSHOT, never to the project's current rate.
  // Anything else would let today's rate change reach back into work already
  // recorded, which is the one thing the snapshot exists to prevent.
  if (task?.factor != null) return session.rate * task.factor;
  return session.rate;
};

/**
 * Pass null or "" to drop the override and fall back to each session's
 * snapshot. Accepts "30%" as readily as a number — see parseTaskRate.
 *
 * Setting one clears the other, always. A task holding both an absolute rate
 * and a proportion would have two answers to one question, and whichever the
 * resolver picked would surprise somebody.
 */
export const setTaskRate = (state, projectId, taskId, rate) => {
  const { rate: value, factor } = parseTaskRate(rate);
  return {
    ...state,
    projects: state.projects.map((p) =>
      p.id === projectId
        ? {
          ...p,
          tasks: tasksFor(p).map((t) =>
            (t.id === taskId ? { ...t, rate: value, factor } : t)),
        }
        : p
    ),
  };
};

/**
 * A free-text note on a task.
 *
 * Emptied means gone, not stored blank, so "has a note" stays a question with
 * one answer. Unlike the label it is never matched, grouped or compared —
 * which is exactly why it can hold the id, the link and the caveat that a
 * label being typed into a picker cannot.
 */
export const setTaskNote = (state, projectId, taskId, note) => {
  const clean = normaliseLabel(note);
  return {
    ...state,
    projects: state.projects.map((p) =>
      p.id === projectId
        ? {
          ...p,
          tasks: tasksFor(p).map((t) => {
            if (t.id !== taskId) return t;
            const next = { ...t };
            if (clean) next.note = clean;
            else delete next.note;
            return next;
          }),
        }
        : p
    ),
  };
};

/** What one accepted item pays under this task, overriding the project's own
 *  price the same way a task rate overrides the session snapshot. */
export const setTaskPrice = (state, projectId, taskId, price) => {
  const value = amount(price);
  return {
    ...state,
    projects: state.projects.map((p) =>
      p.id === projectId
        ? { ...p, tasks: tasksFor(p).map((t) => (t.id === taskId ? { ...t, price: value } : t)) }
        : p
    ),
  };
};

/** How many sessions would be unfiled if this task went away. */
export const sessionsUnderTask = (sessions, taskId) =>
  sessions.filter((s) => s.taskId === taskId && !s.deletedAt).length;

/**
 * Removes a task and unfiles its sessions rather than orphaning them — their
 * hours stay recorded and reappear under "No task". Callers keep the prior
 * state so this can be undone.
 */
export const removeTask = (state, projectId, taskId) => ({
  ...state,
  projects: state.projects.map((p) =>
    p.id === projectId ? { ...p, tasks: tasksFor(p).filter((t) => t.id !== taskId) } : p
  ),
  sessions: state.sessions.map((s) =>
    s.projectId === projectId && s.taskId === taskId ? { ...s, taskId: null } : s
  ),
});

export const renameTask = (state, projectId, taskId, label) => {
  const clean = normaliseLabel(label);
  if (!clean) return state;
  return {
    ...state,
    projects: state.projects.map((p) =>
      p.id === projectId
        ? { ...p, tasks: tasksFor(p).map((t) => (t.id === taskId ? { ...t, label: clean } : t)) }
        : p
    ),
  };
};

/** The id a label should map to: the existing task's, or the fresh one. */
export const resolveTaskId = (project, label, freshId) =>
  findTaskByLabel(project, label)?.id ?? freshId;

/**
 * Time and earnings grouped by task. Billed and idle are kept in separate
 * columns for the same reason they are everywhere else — idle time must never
 * be summed into an earnings figure.
 */
export const taskTotals = (project, sessions, now) => {
  const buckets = new Map();
  const bucket = (taskId) => {
    const id = taskId ?? UNASSIGNED;
    if (!buckets.has(id)) {
      buckets.set(id, {
        taskId: taskId ?? null,
        label: taskId ? taskLabel(project, taskId) : "No task",
        rate: taskId ? findTask(project, taskId)?.rate ?? null : null,
        factor: taskId ? findTask(project, taskId)?.factor ?? null : null,
        price: taskId ? findTask(project, taskId)?.price ?? null : null,
        note: taskId ? findTask(project, taskId)?.note ?? null : null,
        state: taskId ? taskState(findTask(project, taskId)) : null,
        submittedAt: taskId ? findTask(project, taskId)?.submittedAt ?? null : null,
        billedMs: 0, billedCents: 0, idleMs: 0, idleCents: 0, sessions: 0,
      });
    }
    return buckets.get(id);
  };

  for (const s of sessions) {
    const b = bucket(s.taskId);
    const ms = elapsedMs(s, now);
    // Work a rejection cancelled keeps its hours and loses its money. The
    // time happened and still counts; the money never arrived and belongs in
    // no figure, here or anywhere else.
    const cents = isCancelled(s) ? 0 : earningsCents(rateFor(project, s), ms);
    b.sessions += 1;
    if (isBilled(s)) {
      b.billedMs += ms;
      b.billedCents += cents;
    } else if (isIdle(s)) {
      b.idleMs += ms;
      b.idleCents += cents;
    }
  }

  return [...buckets.values()].sort(
    (a, b) => b.billedCents - a.billedCents || b.billedMs - a.billedMs
  );
};

/* ── reading the list in a different order ────────────────────────────────── */

/**
 * The questions a list of tasks gets asked.
 *
 * Most-earned-first answers "what is this project actually worth", which is
 * why it is the order `taskTotals` returns. But it is one question of four,
 * and the other three are not reachable from it: which batch is still owed
 * and when it went in, where the hours went, and where they leaked. A fixed
 * order quietly decides that only the first of those is ever worth asking.
 */
export const ORDER = {
  PAY: "pay", SUBMITTED: "submitted", TIME: "time", IDLE: "idle",
};

export const ORDERS = [
  [ORDER.PAY, "Amount"],
  [ORDER.SUBMITTED, "Handed in"],
  [ORDER.TIME, "Time taken"],
  [ORDER.IDLE, "Idle"],
];

const ORDER_OF = {
  [ORDER.PAY]: (row, payOf) => payOf(row),
  [ORDER.SUBMITTED]: (row) => row.submittedAt,
  [ORDER.TIME]: (row) => row.billedMs,
  [ORDER.IDLE]: (row) => row.idleMs,
};

const absent = (v) => !Number.isFinite(v);

/**
 * Task rows in a chosen order.
 *
 * Rows with nothing to compare sink to the bottom whichever way round the
 * sort is pointing. Reversing "handed in" should bring the oldest submission
 * to the top, not forty tasks that were never handed in at all — the absence
 * of a date is not an early date, and treating it as one would bury the
 * answer under every row that cannot have one.
 *
 * Ties keep the order they arrived in, which is `taskTotals`' own earned-first
 * one, so a column of equal zeroes still reads sensibly underneath.
 */
export const sortTaskRows = (rows, order, desc = true, payOf = (r) => r.billedCents) => {
  const value = ORDER_OF[order];
  if (!value) return rows;
  return rows
    .map((row, i) => ({ row, i, v: value(row, payOf) }))
    .sort((a, b) => {
      if (absent(a.v) || absent(b.v)) {
        if (absent(a.v) && absent(b.v)) return a.i - b.i;
        return absent(a.v) ? 1 : -1;
      }
      return (desc ? b.v - a.v : a.v - b.v) || a.i - b.i;
    })
    .map((k) => k.row);
};
