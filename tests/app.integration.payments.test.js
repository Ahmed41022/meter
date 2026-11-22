/**
 * The Payments tab: Upcoming payments moved out of the Overview, and the
 * history of what was paid, by payday and by company, with print and CSV.
 * Drives the built artifact in jsdom with the clock pinned to Tue 17 Nov 2026,
 * so every payday below is a fixed date and no test depends on the day it runs.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  DIST, boot, btn, guardBuiltApp, setValue, settle, toProjects,
} from "./app.integration.helpers.js";
import { csvRow } from "../src/domain/csv.js";
import { paymentsCsv, PAYMENTS_CSV_COLUMNS } from "../src/domain/paymentsCsv.js";

guardBuiltApp();

const HOUR = 3_600_000;
const at = (d, h = 12, m = 10) => Date.UTC(2026, m, d, h);
const NOW = at(17);
const PIN = `Date.now = () => ${NOW};`;
const ASKED = { "meter:payouts-asked": "1" };
const UTC_WEEKLY = { kind: "weekly", cutoff: 1, payday: 3, after: 0, closesAt: 0, zone: "UTC" };
const pref = (id, value) => ({ id, value, createdAt: 1, updatedAt: 1, deletedAt: null });
const task = (id, handedIn) => ({
  id, label: id, createdAt: at(1), state: "submitted", stateAt: handedIn, submittedAt: handedIn,
});
const sittings = (projectId, tasks, currency) => tasks.map((t) => ({
  id: `s-${projectId}-${t.id}`, projectId, kind: "billed", taskId: t.id, rate: 40, currency,
  deletedAt: null, createdAt: t.submittedAt - 3 * HOUR, closedAt: t.submittedAt - 2 * HOUR,
  segments: [{ startedAt: t.submittedAt - 3 * HOUR, endedAt: t.submittedAt - 2 * HOUR }],
}));
const answer = (id, scheduled, currency, fields) => ({
  id, client: "Larkspur", currency, scheduled, answeredAt: at(16), createdAt: at(16), deletedAt: null, ...fields,
});

/**
 * Larkspur, weekly: in before Monday, paid Wednesday, $40 a task, on a UTC
 * clock. Today is Tue 17 Nov. What is in it:
 *   Wed 14 Oct  a $9 bonus added already paid, undated: "Paid line by line"
 *   Wed 28 Oct  paid, $39 of $40 came ($1 less)
 *   Wed  4 Nov  cancelled, $40
 *   Wed 11 Nov  $40 not answered, and $40 of its other task paid line by line
 *   Wed 25 Nov  EUR: €15 of €40 came, the rest moved here from the 11th (partial)
 *   Wed 18 Nov  $40 still coming: Upcoming payments, not the history
 */
const seed = (extra = {}) => {
  const usd = [task("t7", at(22, 12, 9)), task("t8", at(29, 12, 9)),
    { ...task("t9", at(5)), hoursReceived: true, hoursReceivedOn: "2026-11-11" },
    task("t9b", at(5, 13)), task("t1", at(12))];
  const eur = [task("e1", at(5))];
  return {
    projects: [
      { id: "p", name: "Gateway", company: "Larkspur", currentRate: 40, currency: "USD", createdAt: at(1), tasks: usd },
      { id: "q", name: "Atlas", company: "Larkspur", currentRate: 40, currency: "EUR", createdAt: at(1), tasks: eur },
      { id: "z", name: "Other", company: "Fernhill", currentRate: 10, currency: "USD", createdAt: at(1), tasks: [] },
    ],
    sessions: [...sittings("p", usd, "USD"), ...sittings("q", eur, "EUR")],
    earnings: [{
      id: "b1", projectId: "p", kind: "bonus", cents: 900, currency: "USD", taskIds: [], note: "Spot bonus",
      at: at(8, 12, 9), createdAt: at(8, 12, 9), deletedAt: null, received: true,
    }],
    companies: [{ id: "co:larkspur", name: "Larkspur", payPeriod: UTC_WEEKLY, createdAt: at(1), deletedAt: null }],
    payouts: [
      answer("a1", "2026-10-28", "USD", { outcome: "paid", expectedCents: 4_000, receivedCents: 3_900 }),
      answer("a2", "2026-11-04", "USD", { outcome: "cancelled", expectedCents: 4_000, receivedCents: 0 }),
      answer("a3", "2026-11-11", "EUR", { outcome: "partial", expectedCents: 4_000, receivedCents: 1_500, movedTo: "2026-11-25" }),
    ],
    ...extra,
  };
};

const open = (extra, settings = ASKED, script = PIN) =>
  boot(seed(extra), settings, script).then(async (dom) => {
    await settle();
    await toProjects(dom.window.document, "Payments");
    return dom;
  });
const text = (els) => [...els].map((e) => e.textContent);
const rows = (d) => [...d.querySelectorAll(".hist-row")];
const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
const click = async (d, selectorOrEl) => {
  (typeof selectorOrEl === "string" ? d.querySelector(selectorOrEl) : selectorOrEl).click();
  await settle();
};
const period = (d, name) => [...d.querySelectorAll('[aria-label="Period"] button')].find((b) => b.textContent === name);
const view = (d, name) => [...d.querySelectorAll('[aria-label="History view"] [role=tab]')].find((b) => b.textContent === name);
/** The file's text with its byte-order mark KEPT: readAsText would strip it. */
const blobText = (win, blob) => new Promise((resolve) => {
  const r = new win.FileReader();
  r.onload = () => resolve(new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(r.result)));
  r.readAsArrayBuffer(blob);
});
/** Stubs the download and the print, and hands back what they received. */
const hook = (dom) => {
  const got = { blobs: [], names: [], prints: 0 };
  dom.window.URL.createObjectURL = (b) => { got.blobs.push(b); return "blob:x"; };
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = function click() { got.names.push(this.download); };
  dom.window.print = () => { got.prints++; };
  return got;
};

describe("the Payments tab", () => {
  it("is the third of six tabs, and opens Upcoming payments above the history", async () => {
    const dom = await open();
    const d = dom.window.document;
    expect(text(d.querySelectorAll(".tabs [role=tab]")))
      .toEqual(["Today", "Overview", "Payments", "Work", "Life", "Settings"]);
    expect(d.querySelector("[role=tab][aria-selected=true]").textContent).toBe("Payments");
    const heads = text(d.querySelectorAll(".sec-head .eyebrow"));
    expect(heads.findIndex((h) => /Upcoming payments/.test(h)))
      .toBeLessThan(heads.findIndex((h) => h === "History"));
    expect(heads.findIndex((h) => /Upcoming payments/.test(h))).toBe(0);
  }, 30_000);

  it("has six tabs that fit 375px: the CSS narrows the type and sides, and the bar still wraps", () => {
    const css = readFileSync(DIST, "utf8");
    // The measured five-tab rule is untouched (pinned in fixes-data-clock); the
    // sixth word is paid for by the phone-only rules after it.
    expect(css).toMatch(/@media \(max-width:420px\)\{\s*\.tabs\{gap:2px;\}\s*\.tab\{font-size:12px;padding:8px clamp\(3px,calc\(\(100vw - 300px\) \/ 15\),6px\);\}/);
    expect(css).toMatch(/@media \(max-width:350px\)\{\s*\.tab\{font-size:11px;\}/);
    expect(css.match(/\.topbar\{([^}]*)/)?.[1]).toContain("flex-wrap:wrap");
    // At 375px: 12px type and (375-300)/15 = 5px sides, six tabs, a 2px gap.
    // Eight-character words are about 58px at 13px, so 54px at 12px; the six
    // words are about 252px, the padding 6 x 10 = 60px, the gaps 10px and the
    // bar's own 6px: 328px, inside the 351px a 375px screen leaves.
    const width = 252 + 6 * 2 * 5 + 5 * 2 + 6;
    expect(width).toBeLessThanOrEqual(375 - 24);
  });

  it("no longer holds Upcoming payments on the Overview, and says where it went only when it matters", async () => {
    const dom = await boot(seed(), ASKED, PIN);
    const d = dom.window.document;
    await settle();
    await toProjects(d, "Overview");
    expect(text(d.querySelectorAll(".sec-head")).join(" ")).not.toMatch(/Upcoming payments/);
    expect(d.querySelector(".payrow")).toBeNull();
    // Asked already: nothing owed an answer in a place nobody looks, so no link.
    expect(d.querySelector(".wrap").textContent).not.toMatch(/now in Payments/);
    // Not asked yet, with a payday past: the one-time question lives in
    // Payments, so the Overview points at it.
    const fresh = await boot(seed(), null, PIN);
    await settle();
    await toProjects(fresh.window.document, "Overview");
    const link = btn(fresh.window.document, /Upcoming payments are now in Payments/);
    expect(link).toBeTruthy();
    await click(fresh.window.document, link);
    expect(fresh.window.document.querySelector("[role=tab][aria-selected=true]").textContent).toBe("Payments");
    expect(fresh.window.document.querySelector(".payrow")).not.toBeNull();
  }, 40_000);

  it("keeps answering working: Already paid on a coming payday lands in the history", async () => {
    const dom = await open();
    const d = dom.window.document;
    // The coming Wed 18 Nov is the only row that is not overdue.
    const coming = [...d.querySelectorAll(".payrow")].find((r) => !/Overdue/.test(r.textContent));
    await click(d, coming.querySelector(".trow"));
    await click(d, btn(d.querySelector(".paylist"), /^Already paid$/));
    await click(d, btn(d.querySelector(".paylist"), /^Save$/));
    expect(stored(dom).payouts.some((p) => p.outcome === "paid" && p.scheduled === "2026-11-18")).toBe(true);
    // Answered, so it is history now: a Paid row on that day.
    expect(text(d.querySelectorAll(".hist-date")).some((t) => /November 18/.test(t))).toBe(true);
    await click(d, btn(d.querySelector(".toast"), /^Undo$/));
    expect(text(d.querySelectorAll(".hist-date")).some((t) => /November 18/.test(t))).toBe(false);
  }, 40_000);

  it("still answers the app-wide notice from another tab, and the history follows", async () => {
    const dom = await boot(seed(), ASKED, PIN);
    const d = dom.window.document;
    await settle();
    // On Today: the oldest overdue payday asks what happened.
    const notice = [...d.querySelectorAll(".banner")].find((b) => /A payday has passed/.test(b.textContent));
    expect(notice).toBeTruthy();
    await click(d, btn(notice, /^Paid in full$/));
    await click(d, btn(d.querySelector(".banner"), /^Save$/));
    expect(stored(dom).payouts.some((p) => p.outcome === "paid" && p.scheduled === "2026-11-11" && p.currency === "USD")).toBe(true);
    await toProjects(d, "Payments");
    const day = [...d.querySelectorAll(".hist-day")].find((x) => /November 11/.test(x.querySelector(".hist-date").textContent));
    expect(day.textContent).toMatch(/Paid/);
  }, 40_000);

  it("marks a single line paid from Payments, which then reads as paid line by line", async () => {
    const dom = await open();
    const d = dom.window.document;
    const overdue = [...d.querySelectorAll(".payrow")].find((r) => /Overdue/.test(r.textContent));
    await click(d, overdue.querySelector(".trow"));
    d.querySelector(".paylist .row-check").click();
    await settle();
    await click(d, btn(d.querySelector(".paylist"), /^Mark paid$/));
    const t9b = stored(dom).projects[0].tasks.find((t) => t.id === "t9b");
    expect(t9b.hoursReceived).toBe(true);
    expect(t9b.hoursReceivedOn).toBe("2026-11-11");
  }, 40_000);
});

describe("History, by payday", () => {
  it("lists every kind of row, newest day first, with its figures", async () => {
    const d = (await open()).window.document;
    expect(text(d.querySelectorAll(".hist-date")).map((t) => t.replace(/^.*?, /, "")))
      .toEqual(["November 25", "November 11", "November 4", "October 28", "October 14"]);
    const by = (status) => rows(d).find((r) => r.dataset.status === status);
    expect(rows(d).map((r) => r.dataset.status))
      .toEqual(["partial", "unanswered", "cancelled", "paid", "lines-paid"]);

    expect(by("paid").textContent).toMatch(/Paid/);
    expect(by("paid").querySelector(".trow-sub").textContent)
      .toBe("Expected $40.00 · Received $39.00 · $1.00 less");
    expect(by("cancelled").querySelector(".trow-sub").textContent).toBe("Expected $40.00 · Received $0.00");
    expect(by("cancelled").textContent).toMatch(/Cancelled/);
    // The other task of that payday was paid line by line: it came as listed,
    // so it is in expected and received alike.
    expect(by("unanswered").querySelector(".trow-sub").textContent).toBe("Expected $80.00 · Received $40.00");
    expect(by("unanswered").textContent).toMatch(/Not answered/);
    expect(by("partial").querySelector(".trow-sub").textContent)
      .toMatch(/^Expected €40\.00 · Received €15\.00 · moved from .*November 11$/);
    expect(by("partial").textContent).toMatch(/Partly paid/);
    expect(by("lines-paid").querySelector(".trow-sub").textContent).toBe("Expected $9.00 · Received $9.00");
    expect(by("lines-paid").textContent).toMatch(/Paid line by line/);
  }, 30_000);

  it("opens a row to its lines, marks the paid ones, and never says a date is unknown", async () => {
    const d = (await open()).window.document;
    const unanswered = rows(d).find((r) => r.dataset.status === "unanswered");
    expect(unanswered.querySelector(".paylist")).toBeNull();
    await click(d, unanswered.querySelector(".trow"));
    const lines = text(unanswered.querySelectorAll(".payline"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Hours · t9b · Gateway$40.00");
    expect(lines[1]).toBe("Hours · t9 · Gatewaypaid line by line$40.00");
    expect(unanswered.querySelector(".row-check")).toBeNull();

    const bonus = rows(d).find((r) => r.dataset.status === "lines-paid");
    await click(d, bonus.querySelector(".trow"));
    // Undated in the ledger, dated by the schedule, and shown like any other.
    expect(bonus.querySelector(".payline").textContent).toBe("Bonus · Spot bonus · Gatewaypaid line by line$9.00");
    expect(d.body.textContent).not.toMatch(/date not recorded|date unknown|unknown date/i);
  }, 30_000);

  it("shows each month with what came and what is still outstanding, per currency", async () => {
    const d = (await open()).window.document;
    const heads = text(d.querySelectorAll(".hist-month .sec-head"));
    expect(heads).toHaveLength(2);
    // November: $40 of the 11th and the $40 paid line came, $40 is outstanding;
    // €15 of the €40 came and €25 is outstanding. Currencies stay apart.
    expect(heads[0]).toBe("November 2026€15.00 received, €25.00 outstanding · $40.00 received, $40.00 outstanding");
    // October: $39 and the $9 bonus came, nothing is outstanding.
    expect(heads[1]).toBe("October 2026$48.00 received, $0.00 outstanding");
  }, 30_000);

  it("says so when a period has nothing in it", async () => {
    const d = (await open()).window.document;
    await click(d, period(d, "Last year"));
    expect(d.querySelector(".hist-month")).toBeNull();
    expect(d.querySelector(".pay-tab [role=status]").textContent).toMatch(/No payments in this period/);
    expect(btn(d, /^Export CSV$/).disabled).toBe(true);
  }, 30_000);
});

describe("the period filter", () => {
  it("opens on This year, and the named spans cut the history by day", async () => {
    const d = (await open()).window.document;
    expect(period(d, "This year").getAttribute("aria-pressed")).toBe("true");
    expect(rows(d)).toHaveLength(5);
    await click(d, period(d, "This month"));
    expect(text(d.querySelectorAll(".hist-date")).map((t) => t.replace(/^.*?, /, "")))
      .toEqual(["November 25", "November 11", "November 4"]);
    await click(d, period(d, "Last month"));
    expect(text(d.querySelectorAll(".hist-date")).map((t) => t.replace(/^.*?, /, "")))
      .toEqual(["October 28", "October 14"]);
    await click(d, period(d, "All"));
    expect(rows(d)).toHaveLength(5);
  }, 30_000);

  it("takes two days of your own, either of which may be left open", async () => {
    const d = (await open()).window.document;
    await click(d, period(d, "Custom"));
    const win = d.defaultView;
    setValue(win, d.querySelector('input[aria-label="From"]'), "2026-10-20");
    await settle();
    expect(rows(d)).toHaveLength(4);
    setValue(win, d.querySelector('input[aria-label="To"]'), "2026-11-05");
    await settle();
    expect(text(d.querySelectorAll(".hist-date")).map((t) => t.replace(/^.*?, /, "")))
      .toEqual(["November 4", "October 28"]);
  }, 30_000);

  it("is remembered on this device, custom days included, and a bad value falls back to This year", async () => {
    const dom = await open();
    const d = dom.window.document;
    await click(d, period(d, "Last month"));
    expect(dom.window.localStorage.getItem("meter:statement-period")).toBe("last-month");
    const again = await open(undefined, { ...ASKED, "meter:statement-period": "last-month" });
    expect(period(again.window.document, "Last month").getAttribute("aria-pressed")).toBe("true");
    expect(rows(again.window.document)).toHaveLength(2);

    const custom = await open(undefined, { ...ASKED, "meter:statement-period": "custom|2026-11-01|2026-11-30" });
    const c = custom.window.document;
    expect(c.querySelector('input[aria-label="From"]').value).toBe("2026-11-01");
    expect(rows(c)).toHaveLength(3);

    const bad = await open(undefined, { ...ASKED, "meter:statement-period": "next-decade" });
    expect(period(bad.window.document, "This year").getAttribute("aria-pressed")).toBe("true");
  }, 60_000);
});

describe("History, by company", () => {
  const byCompany = async (extra, settings, script) => {
    const dom = await open(extra, settings, script);
    await click(dom.window.document, view(dom.window.document, "By company"));
    return dom;
  };
  const card = (d, cur) => d.querySelector(`[aria-label="Totals in ${cur}"]`);
  const fig = (d, cur, metric) => card(d, cur).querySelector(`[data-metric=${metric}]`).textContent;

  it("lists only companies that are in the history, and shows a card per currency, never summed", async () => {
    const d = (await byCompany()).window.document;
    expect(text(d.querySelectorAll('select[aria-label="Company"] option'))).toEqual(["Larkspur"]);
    expect(fig(d, "USD", "received")).toBe("$88.00");
    expect(fig(d, "USD", "expected")).toBe("$169.00");
    expect(fig(d, "USD", "outstanding")).toBe("$40.00");
    expect(fig(d, "USD", "cancelled")).toBe("$40.00");
    expect(fig(d, "USD", "difference")).toBe("$1.00 less");
    expect(fig(d, "EUR", "received")).toBe("€15.00");
    expect(fig(d, "EUR", "expected")).toBe("€40.00");
    expect(fig(d, "EUR", "outstanding")).toBe("€25.00");
    expect(fig(d, "EUR", "cancelled")).toBe("€0.00");
    // Two cards for two currencies, and nothing that adds them.
    expect(d.querySelectorAll(".stmt-card:not(.stmt-approx)")).toHaveLength(2);
    expect(d.querySelector(".stmt-approx").textContent).toMatch(/Each currency is shown as it was paid/);
    expect(d.querySelector(".pay-tab").textContent).not.toMatch(/≈/);
    // Its paydays follow, the same rows without repeating the company.
    expect(rows(d)).toHaveLength(5);
    expect(rows(d)[0].querySelector(".hist-co")).toBeNull();
  }, 30_000);

  it("follows the period filter", async () => {
    const d = (await byCompany()).window.document;
    await click(d, period(d, "Last month"));
    expect(rows(d)).toHaveLength(2);
    expect(fig(d, "USD", "received")).toBe("$48.00");
    expect(card(d, "EUR")).toBeNull();
    await click(d, period(d, "Last year"));
    expect(d.querySelector(".pay-tab [role=status]").textContent).toMatch(/Nothing from Larkspur/);
  }, 30_000);

  it("shows a ≈ total in the display currency when rates are on, marked and dated", async () => {
    const rates = JSON.stringify({
      base: "USD", date: "2026-11-19", fetchedAt: Date.now() - 60_000, rates: { USD: 1, EGP: 53.83, EUR: 0.9 },
    });
    const prefs = [pref("fxOn", true), pref("favourites", ["USD", "EGP"]), pref("displayCurrency", "EGP")];
    const d = (await byCompany({ prefs }, { ...ASKED, "meter:rates": rates })).window.document;
    const approx = d.querySelector(".stmt-approx");
    const received = approx.querySelector("[data-metric=received]").textContent;
    expect(received).toMatch(/^≈ EGP.[\d,]+\.\d\d$/);
    // $88 and €15: 4,737.04 and about 897.17 at those rates.
    const value = Number(received.replace(/[^\d.]/g, ""));
    expect(value).toBeGreaterThan(5_600);
    expect(value).toBeLessThan(5_670);
    expect(approx.querySelector(".stmt-fig").getAttribute("title")).toMatch(/^at (19 Nov|Nov 19) rates$/);
    // The per-currency cards stay what was paid.
    expect(fig(d, "USD", "received")).toBe("$88.00");
    expect(fig(d, "EUR", "received")).toBe("€15.00");
    // And As earned turns it off again.
    const as = await byCompany({ prefs: [pref("fxOn", true), pref("displayCurrency", "earned")] },
      { ...ASKED, "meter:rates": rates });
    expect(as.window.document.querySelector(".pay-tab").textContent).not.toMatch(/≈/);
  }, 60_000);
});

describe("printing", () => {
  it("has a print-only statement with a title, the date, the totals and the paydays with lines", async () => {
    const dom = await open();
    const d = dom.window.document;
    await click(d, view(d, "By company"));
    const sheet = d.querySelector(".print-sheet");
    expect(sheet.querySelector("h1").textContent).toBe("Statement — Larkspur — This year (2026-01-01 to 2026-12-31)");
    expect(sheet.textContent).toMatch(/Generated .*2026\. All amounts in their own currency\./);
    expect([...sheet.querySelectorAll(".sheet-totals tbody tr")].map((r) => r.firstChild.textContent).sort())
      .toEqual(["EUR", "USD"]);
    expect(sheet.querySelectorAll(".sheet-day")).toHaveLength(5);
    expect(sheet.textContent).toMatch(/Hours · t9 · Gateway.*paid line by line.*\$40\.00/);
    expect(sheet.querySelector(".sheet-approx")).toBeNull();
    await click(d, view(d, "By payday"));
    expect(d.querySelector(".print-sheet h1").textContent).toBe("Statement — All companies — This year (2026-01-01 to 2026-12-31)");
  }, 30_000);

  it("prints with window.print, from a Print statement button and a Print button", async () => {
    const dom = await open();
    const d = dom.window.document;
    const got = hook(dom);
    await click(d, btn(d, /^Print$/));
    expect(got.prints).toBe(1);
    await click(d, view(d, "By company"));
    await click(d, btn(d, /^Print statement$/));
    expect(got.prints).toBe(2);
  }, 30_000);

  it("shows the ≈ line in the statement only when it is on screen", async () => {
    const rates = JSON.stringify({ base: "USD", date: "2026-11-19", fetchedAt: Date.now(), rates: { USD: 1, EGP: 53.83, EUR: 0.9 } });
    const prefs = [pref("fxOn", true), pref("favourites", ["USD", "EGP"]), pref("displayCurrency", "EGP")];
    const d = (await open({ prefs }, { ...ASKED, "meter:rates": rates })).window.document;
    expect(d.querySelector(".sheet-approx").textContent).toMatch(/Received ≈ EGP/);
  }, 30_000);

  it("hides the screen, the tabs, the footer and the banners when printing, and prints black on white", async () => {
    const dom = await open();
    const d = dom.window.document;
    const hidden = (el) => el.classList.contains("print-hide");
    expect(hidden(d.querySelector(".topbar"))).toBe(true);
    expect(hidden(d.querySelector(".foot"))).toBe(true);
    expect(hidden(d.querySelector(".stmt-actions"))).toBe(true);
    // Everything on screen in the tab is inside a print-hide wrapper; only the
    // sheet is outside one.
    for (const el of d.querySelectorAll(".pay-tab > *")) {
      expect(hidden(el) || el.classList.contains("sec") || el.classList.contains("print-sheet")).toBe(true);
    }
    for (const el of d.querySelectorAll(".pay-tab > .sec > *")) {
      expect(hidden(el) || el.classList.contains("print-sheet"), el.className).toBe(true);
    }
    const css = readFileSync(DIST, "utf8");
    const printed = css.slice(css.indexOf("@media print"));
    expect(printed).toMatch(/\.print-hide,\.topbar,\.foot,\.toast,\.runbar,\.banner\{display:none !important;\}/);
    expect(printed).toMatch(/\.print-sheet\{display:block/);
    expect(printed).toMatch(/\.sheet-day\{break-inside:avoid;page-break-inside:avoid;/);
    expect(printed).toMatch(/color:var\(--print-ink\) !important;background:transparent !important/);
    expect(printed).toMatch(/--print-paper:#fff;--print-ink:#000/);
    // On screen the sheet is not there.
    expect(css).toMatch(/\.print-sheet\{display:none;\}/);
  }, 30_000);
});

describe("CSV", () => {
  const exportFor = async (pickView) => {
    const dom = await open();
    const d = dom.window.document;
    const got = hook(dom);
    if (pickView) await click(d, view(d, pickView));
    await click(d, btn(d, /^Export CSV$/));
    expect(got.blobs).toHaveLength(1);
    return { text: await blobText(dom.window, got.blobs[0]), names: got.names };
  };

  it("starts with the byte-order mark and the exact header", async () => {
    const { text: csv, names } = await exportFor();
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    expect(csv.slice(1).split("\n")[0]).toBe(csvRow(PAYMENTS_CSV_COLUMNS, new Set([4, 5, 6, 10])));
    expect(csv.slice(1).split("\n")[0]).toBe(
      '"Date","Company","Currency","Status","Expected","Received","Difference","Line kind","Line label","Project","Line amount","Paid line by line","Paid on","Dated by"');
    expect(names[0]).toMatch(/^meter-\d{4}-\d{2}-\d{2}-payments\.csv$/);
  }, 30_000);

  it("has a row per line with plain decimals in their own currency, and no converted figures", async () => {
    const { text: csv } = await exportFor();
    const lines = csv.slice(1).trimEnd().split("\n").slice(1);
    // Newest first: the EUR partial, the 11th (a line to pay, a line paid),
    // the cancelled, the paid, and the bonus.
    expect(lines).toEqual([
      '"2026-11-25","Larkspur","EUR","Partly paid","40.00","15.00","","Hours","e1","Atlas","40.00","No","",""',
      '"2026-11-11","Larkspur","USD","Not answered","40.00","0.00","","Hours","t9b","Gateway","40.00","No","",""',
      '"2026-11-11","Larkspur","USD","Not answered","","","","Hours","t9","Gateway","40.00","Yes","2026-11-11","recorded"',
      '"2026-11-04","Larkspur","USD","Cancelled","40.00","0.00","","Hours","t8","Gateway","40.00","No","",""',
      '"2026-10-28","Larkspur","USD","Paid","40.00","39.00","-1.00","Hours","t7","Gateway","40.00","No","",""',
      '"2026-10-14","Larkspur","USD","Paid line by line","0.00","0.00","","Bonus","Spot bonus","Gateway","9.00","Yes","2026-10-14","schedule"',
    ]);
  }, 30_000);

  it("exports a company's own rows from By company", async () => {
    const { text: csv, names } = await exportFor("By company");
    expect(csv.slice(1).trimEnd().split("\n")).toHaveLength(7);
    expect(names[0]).toMatch(/-payments-Larkspur\.csv$/);
  }, 30_000);

  it("exports only the filtered period", async () => {
    const dom = await open();
    const d = dom.window.document;
    const got = hook(dom);
    await click(d, period(d, "Last month"));
    await click(d, btn(d, /^Export CSV$/));
    const lines = (await blobText(dom.window, got.blobs[0])).slice(1).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.every((l, i) => i === 0 || /^"2026-10-/.test(l))).toBe(true);
  }, 30_000);
});

describe("CSV encoding", () => {
  const row = (over) => ({
    date: "2026-11-04", company: "Acme", currency: "USD", status: "paid", expectedCents: 100,
    receivedCents: 100, differenceCents: 0, lines: [], paidLines: [], ...over,
  });
  const line = (over) => ({ key: "k", kind: "task", part: "hours", label: "x", project: "P", cents: 100, ...over });

  it("doubles quotes, quotes every field and keeps a negative amount a number", () => {
    const csv = paymentsCsv([row({ company: 'Say "hi", Ltd', differenceCents: -250, lines: [line()] })]);
    expect(csv.split("\n")[1]).toBe(
      '"2026-11-04","Say ""hi"", Ltd","USD","Paid","1.00","1.00","-2.50","Hours","x","P","1.00","No","",""');
  });

  it("makes text a spreadsheet would run as a formula inert, in every text column", () => {
    const csv = paymentsCsv([row({
      company: "=HYPERLINK(\"http://example.com\")",
      lines: [line({ label: "@cmd", project: "-pair-review", cents: -500 })],
    })]);
    const out = csv.split("\n")[1];
    expect(out).toContain(`"'=HYPERLINK(""http://example.com"")"`);
    expect(out).toContain('"\'@cmd"');
    expect(out).toContain('"\'-pair-review"');
    // The amount is a number and stays one, even negative.
    expect(out).toContain('"-5.00"');
  });

  it("puts a payday's figures on its first row only, so no filter can sum them twice", () => {
    const csv = paymentsCsv([row({ lines: [line({ key: "a" }), line({ key: "b", label: "y" })] })]).split("\n");
    expect(csv[1]).toContain('"1.00","1.00","0.00"');
    expect(csv[2]).toMatch(/^"2026-11-04","Acme","USD","Paid","","","","Hours","y"/);
  });

  it("writes a payday with no lines as one row of its figures", () => {
    const csv = paymentsCsv([row()]).split("\n");
    expect(csv).toHaveLength(3);
    expect(csv[1]).toBe('"2026-11-04","Acme","USD","Paid","1.00","1.00","0.00","","","","","","",""');
  });
});
