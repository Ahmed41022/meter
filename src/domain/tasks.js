import { elapsedMs } from "./time.js";
import { earningsCents } from "./money.js";
import { isBilled, isIdle } from "./sessions.js";

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
export const addTask = (state, projectId, { id, label }, now) => {
  const clean = normaliseLabel(label);
  if (!clean) return state;
  return {
    ...state,
    projects: state.projects.map((p) => {
      if (p.id !== projectId) return p;
      const existing = tasksFor(p);
      if (existing.some((t) => t.id === id || key(t.label) === key(clean))) return p;
      return { ...p, tasks: [...existing, { id, label: clean, createdAt: now }] };
    }),
  };
};

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
        billedMs: 0, billedCents: 0, idleMs: 0, idleCents: 0, sessions: 0,
      });
    }
    return buckets.get(id);
  };

  for (const s of sessions) {
    const b = bucket(s.taskId);
    const ms = elapsedMs(s, now);
    b.sessions += 1;
    if (isBilled(s)) {
      b.billedMs += ms;
      b.billedCents += earningsCents(s, ms);
    } else if (isIdle(s)) {
      b.idleMs += ms;
      b.idleCents += earningsCents(s, ms);
    }
  }

  return [...buckets.values()].sort(
    (a, b) => b.billedCents - a.billedCents || b.billedMs - a.billedMs
  );
};
