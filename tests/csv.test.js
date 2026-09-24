import { describe, it, expect } from "vitest";
import { CSV_COLUMNS, toCsv } from "../src/domain/csv.js";
import { KIND } from "../src/domain/sessions.js";

const HOUR = 3_600_000;
const at = (d, h = 9, m = 0) => new Date(2026, 4, d, h, m).getTime();
const NOW = at(31, 12);

const project = (id, extra = {}) => ({
  id, name: id, currentRate: 20, currency: "USD", tasks: [], ...extra,
});
const session = (id, day, hrs, extra = {}) => ({
  id, projectId: "p1", kind: KIND.BILLED, taskId: null, rate: 20, currency: "USD",
  createdAt: at(day), closedAt: at(day) + hrs * HOUR, deletedAt: null,
  segments: [{ startedAt: at(day), endedAt: at(day) + hrs * HOUR }], ...extra,
});
const earning = (id, day, cents, extra = {}) => ({
  id, projectId: "p1", taskId: null, kind: "piece", cents, currency: "USD",
  at: at(day, 12), note: "", createdAt: at(day), deletedAt: null, ...extra,
});
const lines = (csv) => csv.trim().split("\n");
const cells = (line) => line.slice(1, -1).split('","');
const col = (csv, name) => {
  const i = CSV_COLUMNS.indexOf(name);
  return lines(csv).slice(1).map((l) => cells(l)[i]);
};

describe("the ledger as a spreadsheet", () => {
  const state = {
    projects: [project("p1", { name: "hyperion", company: "Outlier" })],
    sessions: [session("s1", 10, 2)],
    earnings: [],
  };

  it("leads with a header a spreadsheet can read", () => {
    expect(lines(toCsv(state, NOW))[0]).toBe(CSV_COLUMNS.map((c) => `"${c}"`).join(","));
  });

  it("writes one row per session, with the money it earned", () => {
    const c = cells(lines(toCsv(state, NOW))[1]);
    expect(c[CSV_COLUMNS.indexOf("Date")]).toBe("2026-05-10");
    expect(c[CSV_COLUMNS.indexOf("Project")]).toBe("hyperion");
    expect(c[CSV_COLUMNS.indexOf("Company")]).toBe("Outlier");
    expect(c[CSV_COLUMNS.indexOf("Hours")]).toBe("2.000");
    expect(c[CSV_COLUMNS.indexOf("Amount")]).toBe("40.00");
  });

  it("quotes every field, because these names contain commas and quotes", () => {
    // A reader that guesses wrong shifts every later column by one.
    const s = { ...state, projects: [project("p1", { name: 'a, "b" c' })] };
    const line = lines(toCsv(s, NOW))[1];
    expect(line).toContain('"a, ""b"" c"');
    expect(cells(line)[CSV_COLUMNS.indexOf("Project")]).toBe('a, ""b"" c');
  });

  it("dates rows by the LOCAL calendar day", () => {
    // Formatting through UTC moves every row east of Greenwich back a day, and
    // which tax year a row falls in is decided by this column.
    const late = { ...state, sessions: [session("s1", 10, 1, {
      createdAt: at(10, 23, 30), closedAt: at(10, 23, 30) + HOUR,
      segments: [{ startedAt: at(10, 23, 30), endedAt: at(10, 23, 30) + HOUR }],
    })] };
    expect(col(toCsv(late, NOW), "Date")[0]).toBe("2026-05-10");
  });

  it("puts money that no clock measured in the same table", () => {
    // More than half this ledger's income never touched a clock. A file that
    // left it out would understate a year by half.
    const s = { ...state, earnings: [earning("e1", 12, 300_000, { units: 6 })] };
    const csv = toCsv(s, NOW);
    expect(lines(csv)).toHaveLength(3);
    const kinds = col(csv, "Kind");
    expect(kinds).toContain("Per item");
    const i = kinds.indexOf("Per item");
    expect(col(csv, "Amount")[i]).toBe("3000.00");
    expect(col(csv, "Rate")[i]).toBe("500.00"); // 6 items at $500
    expect(col(csv, "Note")[i]).toMatch(/6 items/);
  });

  it("leaves hours BLANK on money that took no recorded time", () => {
    // Not 0.000: a zero invites an hourly rate to be computed from it.
    const s = { ...state, earnings: [earning("e1", 12, 100_00)] };
    const csv = toCsv(s, NOW);
    const i = col(csv, "Kind").indexOf("Per item");
    expect(col(csv, "Hours")[i]).toBe("");
  });

  it("gives idle time its hours but never any money", () => {
    const s = { ...state, sessions: [session("s1", 10, 2, { kind: KIND.IDLE })] };
    const csv = toCsv(s, NOW);
    expect(col(csv, "Kind")[0]).toBe("Idle");
    expect(col(csv, "Hours")[0]).toBe("2.000");
    expect(col(csv, "Amount")[0]).toBe("0.00");
  });

  it("orders by when it happened, so the file reads as a history", () => {
    const s = {
      ...state,
      sessions: [session("s2", 20, 1), session("s1", 5, 1)],
      earnings: [earning("e1", 12, 5_000)],
    };
    expect(col(toCsv(s, NOW), "Date")).toEqual(["2026-05-05", "2026-05-12", "2026-05-20"]);
  });

  it("leaves out what was deleted, which a backup still holds", () => {
    const s = {
      ...state,
      sessions: [session("s1", 10, 2), session("s2", 11, 2, { deletedAt: NOW })],
      earnings: [earning("e1", 12, 100, { deletedAt: NOW })],
    };
    expect(lines(toCsv(s, NOW))).toHaveLength(2);
  });

  it("marks whether a row was timed or typed in", () => {
    const s = {
      ...state,
      sessions: [session("s1", 10, 2), session("s2", 11, 2, { manual: true })],
    };
    expect(col(toCsv(s, NOW), "Recorded by")).toEqual(["timed", "typed in"]);
  });

  it("carries pending and cancelled through, rather than silently dropping them", () => {
    const s = {
      ...state,
      sessions: [session("s1", 10, 2, { status: "pending" })],
      earnings: [earning("e1", 12, 100, { status: "cancelled" })],
    };
    expect(col(toCsv(s, NOW), "Status")).toEqual(["pending", "cancelled"]);
  });

  it("exports a running session as what it has run so far", () => {
    const open = {
      ...state,
      sessions: [{
        ...session("s1", 31, 0), closedAt: null,
        segments: [{ startedAt: at(31, 9), endedAt: null }],
      }],
    };
    expect(col(toCsv(open, NOW), "Hours")[0]).toBe("3.000"); // 09:00 to 12:00
    expect(col(toCsv(open, NOW), "Ended")[0]).toBe("");
  });

  it("survives an empty ledger and one whose project has gone", () => {
    expect(lines(toCsv({ projects: [], sessions: [] }, NOW))).toHaveLength(1);
    const orphan = { projects: [], sessions: [session("s1", 10, 2)], earnings: [] };
    expect(col(toCsv(orphan, NOW), "Project")).toEqual([""]);
  });
});
