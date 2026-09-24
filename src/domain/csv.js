/**
 * The ledger as a spreadsheet.
 *
 * The JSON backup exists so the app can read itself back. This exists so
 * something else can read it: a tax return, a spreadsheet, an accountant. Those
 * readers want one row per thing you were paid for, not a nested document.
 *
 * Money that no clock measured sits in the same table as timed work, because
 * on this ledger it is more than half the income and a file that quietly
 * omitted it would understate a year by half. The `Kind` column is what tells
 * them apart, and a piece-rate row simply has no hours.
 *
 * Nothing here reads the clock — `now` is passed in, so an open session exports
 * as what it has run so far rather than as an error.
 */
import { elapsedMs } from "./time.js";
import { rateFor, taskLabel } from "./tasks.js";
import { earningsCents } from "./money.js";
import { isBilled } from "./sessions.js";
import { payStateOf } from "./earnings.js";
import { companyOf } from "./projects.js";

const HOUR = 3_600_000;

export const CSV_COLUMNS = [
  "Date", "Project", "Company", "Task", "Kind", "Status",
  "Started", "Ended", "Hours", "Rate", "Currency", "Amount", "Recorded by", "Note",
];

const pad = (n) => String(n).padStart(2, "0");

/** The LOCAL calendar date. Formatting via UTC would move every row east of
 *  Greenwich back a day, and a tax year is decided by the date in the column. */
const isoDate = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const isoTime = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * Every field is quoted, always.
 *
 * Project names here contain commas, quotes and non-breaking spaces, and a
 * reader that guesses wrong shifts every later column by one. Quoting
 * unconditionally costs a few bytes and removes the guess. A quote inside a
 * field is doubled, which is what the format says and what every spreadsheet
 * expects.
 */
const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const row = (values) => values.map(cell).join(",");

/** Hours to three places: a six-minute task is 0.100, and rounding it to two
 *  would make a column of short tasks add up visibly wrong. */
const hours = (ms) => (ms / HOUR).toFixed(3);
const amount = (cents) => (cents / 100).toFixed(2);

/**
 * One row per session and one per earning, newest last, so the file reads as a
 * history rather than a leaderboard.
 *
 * Deleted records are left out: they were removed on purpose, and a backup
 * already holds them if they are ever wanted back.
 */
export const toCsv = (state, now) => {
  const projects = state?.projects ?? [];
  const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
  const rows = [];

  for (const s of state?.sessions ?? []) {
    if (s.deletedAt) continue;
    const project = byId[s.projectId];
    const ms = elapsedMs(s, now);
    const rate = project ? rateFor(project, s) : s.rate;
    const segments = s.segments ?? [];
    const startedAt = segments.length ? segments[0].startedAt : s.createdAt;
    const endedAt = s.closedAt ?? (segments.length ? segments[segments.length - 1].endedAt : null);
    rows.push({
      at: startedAt,
      values: [
        isoDate(startedAt),
        project?.name ?? "",
        companyOf(project) ?? "",
        project ? taskLabel(project, s.taskId) : "",
        isBilled(s) ? "Billed" : "Idle",
        payStateOf(s),
        isoTime(startedAt),
        endedAt === null ? "" : isoTime(endedAt),
        hours(ms),
        rate ?? "",
        s.currency ?? "",
        // Idle time is not income. It carries its hours so the file still
        // accounts for the day, and a zero in the money column so no total
        // built from it can ever include time that was never billable.
        isBilled(s) ? amount(earningsCents(rate, ms)) : "0.00",
        s.manual ? "typed in" : "timed",
        "",
      ],
    });
  }

  for (const e of state?.earnings ?? []) {
    if (e.deletedAt) continue;
    const project = byId[e.projectId];
    rows.push({
      at: e.at,
      values: [
        isoDate(e.at),
        project?.name ?? "",
        companyOf(project) ?? "",
        "",
        e.kind === "bonus" ? "Bonus" : e.kind === "adjust" ? "Adjustment" : "Per item",
        payStateOf(e),
        "", "",
        // No hours, and deliberately blank rather than 0.000: this money took
        // time that was never recorded against it, and a zero would invite an
        // hourly rate to be computed from it.
        "",
        // Units, where the money covers a countable number of accepted items —
        // "6 x $500" is the fact and "$3,000" only its consequence.
        e.units ? amount(Math.round(e.cents / e.units)) : "",
        e.currency ?? "",
        amount(e.cents),
        "typed in",
        e.units ? `${e.units} items${e.note ? ` · ${e.note}` : ""}` : (e.note ?? ""),
      ],
    });
  }

  rows.sort((a, b) => a.at - b.at);
  return [row(CSV_COLUMNS), ...rows.map((r) => row(r.values))].join("\n") + "\n";
};
