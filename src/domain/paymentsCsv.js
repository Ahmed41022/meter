/**
 * The payment history as a spreadsheet, for an accountant or a tax return.
 *
 * One row per line of each payday, the lines the payment is made of and the
 * lines somebody marked paid one by one, so a total built from it is the
 * ledger's own. A payday's figures (expected, received, difference) are on its
 * FIRST row only: repeated down every line they would be summed several times
 * by whoever filters and adds a column. A payday with no lines is one row of
 * its figures alone.
 *
 * Every amount is a plain decimal in the row's own currency and never a
 * converted one: the file is a record of what was paid, and an exchange rate is
 * not. The encoding, the quoting and the guard against text a spreadsheet would
 * run as a formula are csv.js's, shared on purpose.
 *
 * `Dated by` says where a paid line's day came from: "recorded" when it was
 * marked paid with a day, "schedule" when it was worked out from the client's
 * payday rules because none was kept.
 *
 * Like the rest of `domain/`, nothing here reads the clock or storage.
 */
import { csvRow } from "./csv.js";
import { STATUS } from "./payHistory.js";

export const PAYMENTS_CSV_COLUMNS = [
  "Date", "Company", "Currency", "Status", "Expected", "Received", "Difference",
  "Line kind", "Line label", "Project", "Line amount", "Paid line by line", "Paid on", "Dated by",
];
const NUMERIC = new Set(["Expected", "Received", "Difference", "Line amount"]
  .map((name) => PAYMENTS_CSV_COLUMNS.indexOf(name)));

export const STATUS_WORD = {
  [STATUS.PAID]: "Paid", [STATUS.PARTIAL]: "Partly paid", [STATUS.CANCELLED]: "Cancelled",
  [STATUS.UNANSWERED]: "Not answered", [STATUS.LINES_PAID]: "Paid line by line",
};

const KIND_NAMES = { hours: "Hours", piece: "Per accepted item", bonus: "Bonus", adjust: "Adjustment" };

/** A line as a kind and a label: "Bonus" and "batch 4417", as the screen
 *  prints them. */
export const lineWords = (line) => {
  if (line.kind === "reward") return { kind: "Reward", label: `${line.label} · ${line.covers} tasks` };
  if (line.kind === "extra") {
    return {
      kind: KIND_NAMES[line.part] ?? "Other",
      label: [line.label, line.taskLabel].filter(Boolean).join(" · "),
    };
  }
  return { kind: KIND_NAMES[line.part] ?? "Other", label: line.label };
};

const amount = (cents) => (cents / 100).toFixed(2);

/** The history rows (newest first, as `paymentHistory` gives them) as CSV text,
 *  without the byte-order mark, which the download adds. */
export const paymentsCsv = (rows) => {
  const out = [csvRow(PAYMENTS_CSV_COLUMNS, NUMERIC)];
  for (const r of rows ?? []) {
    const lines = [
      ...r.lines.map((l) => ({ l, paid: false })),
      ...r.paidLines.map((l) => ({ l, paid: true })),
    ];
    const head = [
      r.date, r.company, r.currency, STATUS_WORD[r.status] ?? r.status,
      // Lines paid on top (one by one, or dated by the schedule) count in
      // both, as they do on screen and in the totals.
      amount(r.expectedCents + (r.paidLinesCents ?? 0)), amount(r.receivedCents + (r.paidLinesCents ?? 0)),
      // Only a paid payment has a difference: a cancellation has its own
      // figure on screen and in the totals, and is not a difference twice.
      r.status === STATUS.PAID && r.differenceCents !== null ? amount(r.differenceCents) : "",
    ];
    if (lines.length === 0) out.push(csvRow([...head, "", "", "", "", "", "", ""], NUMERIC));
    lines.forEach(({ l, paid }, i) => {
      const { kind, label } = lineWords(l);
      out.push(csvRow([
        ...(i === 0 ? head : [r.date, r.company, r.currency, STATUS_WORD[r.status] ?? r.status, "", "", ""]),
        kind, label, l.project ?? "", amount(l.cents),
        paid && !l.worked ? "Yes" : "No", paid ? l.receivedOn : "", paid ? (l.inferred ? "schedule" : "recorded") : "",
      ], NUMERIC));
    });
  }
  return `${out.join("\n")}\n`;
};
