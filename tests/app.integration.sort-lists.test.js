/**
 * The sorts on the Overview's By project and By company, and on a project's
 * Earnings and Sessions lists, with the synced defaults that open them. Drives
 * the built artifact.
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import {
  ALL_TIME, boot, bootDash, btn, guardBuiltApp, setValue, settle, toProjects,
} from "./app.integration.helpers.js";
import { formatMoney } from "../src/domain/money.js";

guardBuiltApp();

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T = Date.now();

const project = (id, name, rate, currency, extra = {}) => ({
  id, name, currentRate: rate, currency, createdAt: T - 400 * DAY,
  sessionGoal: null, overallGoal: null, tasks: [], ...extra,
});
const sitting = (id, projectId, rate, currency, hours, daysBack, extra = {}) => {
  const start = T - daysBack * DAY;
  return {
    id, projectId, kind: "billed", taskId: null, rate, currency, createdAt: start,
    closedAt: start + hours * HOUR, deletedAt: null,
    segments: [{ startedAt: start, endedAt: start + hours * HOUR }],
    ...extra,
  };
};
const pref = (key, value) => ({ id: key, value, createdAt: 1, updatedAt: 1, deletedAt: null });
const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
const click = async (d, selector, label) => {
  [...d.querySelectorAll(selector)].find((b) => b.textContent.replace(/ [↓↑]$/, "") === label).click();
  await settle();
};
const defaultsSelect = (d, label) => [...d.querySelector("#settings-defaults").parentElement
  .querySelectorAll("label")].find((l) => l.textContent.startsWith(label)).querySelector("select");

// ---------------------------------------------------------------- Overview

// Each company has one project. The unassigned project is the biggest on every
// measure, so any order that let it rank would put it first.
//   Acme    EGP  4 h at 50   =  200 EGP      50/hr
//   Beta    EGP  1 h at 100  =  100 EGP     100/hr
//   Corp    USD  0.5 h at 500 = 250 USD     500/hr   (25,000 cents beats Acme's 20,000)
//   Dune    USD  3 h at 20   =   60 USD      20/hr
//   Loose   EGP  10 h at 1000 = 10,000 EGP, no company
// EGP has 15 h against 3.5 h of USD, so the EGP group leads.
const overviewSeed = {
  projects: [
    project("a", "Acme work", 50, "EGP", { company: "Acme" }),
    project("b", "Beta work", 100, "EGP", { company: "Beta" }),
    project("c", "Corp work", 500, "USD", { company: "Corp" }),
    project("d", "Dune work", 20, "USD", { company: "Dune" }),
    project("l", "Loose work", 1000, "EGP"),
  ],
  sessions: [
    sitting("s1", "a", 50, "EGP", 4, 3), sitting("s2", "b", 100, "EGP", 1, 4),
    sitting("s3", "c", 500, "USD", 0.5, 2), sitting("s4", "d", 20, "USD", 3, 5),
    sitting("s5", "l", 1000, "EGP", 10, 1),
  ],
};
const companies = (d) => [...d.querySelectorAll(".crow-name")].map((n) => n.textContent);
const projectsOn = (d) => [...d.querySelectorAll(".prow-name")].map((n) => n.textContent);
const labels = (d, group) => [...d.querySelectorAll(`[aria-label="${group}"] .seg`)]
  .map((b) => b.textContent);

describe("Overview, By company", () => {
  it("offers Time, An hour and Earned, and opens on Earned", async () => {
    const d = (await bootDash(overviewSeed, ALL_TIME)).window.document;
    expect(labels(d, "Order companies by")).toEqual(["Time", "An hour", "Earned"]);
    expect(d.querySelector('[aria-label="Order companies by"] .seg.on').textContent).toBe("Earned");
  }, 30_000);

  it("Earned groups by currency, most hours first, biggest inside each", async () => {
    const d = (await bootDash(overviewSeed, ALL_TIME)).window.document;
    expect(companies(d)).toEqual(["Acme", "Beta", "Corp", "Dune", "No company"]);
  }, 30_000);

  it("Time orders by hours and An hour by each currency's own rate, grouped", async () => {
    const d = (await bootDash(overviewSeed, ALL_TIME)).window.document;
    await click(d, '[aria-label="Order companies by"] .seg', "Time");
    expect(companies(d)).toEqual(["Acme", "Dune", "Beta", "Corp", "No company"]);
    await click(d, '[aria-label="Order companies by"] .seg', "An hour");
    // 100/hr and 50/hr in EGP, then 500/hr and 20/hr in USD: 500 USD an hour
    // is not set against 100 EGP.
    expect(companies(d)).toEqual(["Beta", "Acme", "Corp", "Dune", "No company"]);
  }, 30_000);

  it("keeps the unassigned row last under every order", async () => {
    const d = (await bootDash(overviewSeed, ALL_TIME)).window.document;
    for (const label of ["Time", "An hour", "Earned"]) {
      await click(d, '[aria-label="Order companies by"] .seg', label);
      expect(companies(d).at(-1)).toBe("No company");
    }
  }, 30_000);

  it("with one currency Earned is the rollup's own order: money, then time", async () => {
    const one = {
      projects: [
        project("a", "A", 50, "USD", { company: "Acme" }),
        project("b", "B", 200, "USD", { company: "Beta" }),
        project("c", "C", 40, "USD", { company: "Corp" }),
        project("l", "L", 900, "USD"),
      ],
      sessions: [
        sitting("s1", "a", 50, "USD", 4, 3), sitting("s2", "b", 200, "USD", 1, 4),
        sitting("s3", "c", 40, "USD", 3, 2), sitting("s4", "l", 900, "USD", 5, 1),
      ],
    };
    const d = (await bootDash(one, ALL_TIME)).window.document;
    // Acme and Beta are both $200; Acme has more hours so it goes first.
    expect(companies(d)).toEqual(["Acme", "Beta", "Corp", "No company"]);
  }, 30_000);

  it("shows no bar for a single company", async () => {
    const one = {
      projects: [project("a", "A", 50, "USD", { company: "Acme" }), project("b", "B", 50, "USD", { company: "Acme" })],
      sessions: [sitting("s1", "a", 50, "USD", 1, 1), sitting("s2", "b", 50, "USD", 2, 1)],
    };
    const d = (await bootDash(one, ALL_TIME)).window.document;
    expect(d.querySelector('[aria-label="Order companies by"]')).toBeNull();
  }, 30_000);

  it("opens on the synced default, and a pick lasts until the Overview is left", async () => {
    const dom = await bootDash({ ...overviewSeed, prefs: [pref("byCompanySort", "time")] }, ALL_TIME);
    const d = dom.window.document;
    expect(companies(d)).toEqual(["Acme", "Dune", "Beta", "Corp", "No company"]);
    await click(d, '[aria-label="Order companies by"] .seg', "Earned");
    expect(companies(d)).toEqual(["Acme", "Beta", "Corp", "Dune", "No company"]);
    await toProjects(d, "Work");
    await toProjects(d, "Overview");
    expect(companies(d)).toEqual(["Acme", "Dune", "Beta", "Corp", "No company"]);
  }, 30_000);

  it("is set in Settings and honoured after a reload", async () => {
    const dom = await boot(overviewSeed, ALL_TIME);
    await settle();
    await toProjects(dom.window.document, "Settings");
    setValue(dom.window, defaultsSelect(dom.window.document, "Overview, By company"), "rate");
    await settle();
    expect(stored(dom).prefs.find((r) => r.id === "byCompanySort").value).toBe("rate");
    const again = await bootDash(stored(dom), ALL_TIME);
    expect(companies(again.window.document)).toEqual(["Beta", "Acme", "Corp", "Dune", "No company"]);
  }, 40_000);
});

describe("Overview, By project", () => {
  it("offers Time and Earned across currencies, with An hour left out", async () => {
    const d = (await bootDash(overviewSeed, ALL_TIME)).window.document;
    expect(labels(d, "Order projects by")).toEqual(["Time", "Earned"]);
    expect(projectsOn(d)).toEqual(["Loose work", "Acme work", "Dune work", "Beta work", "Corp work"]);
  }, 30_000);

  it("Earned groups by currency and never ranks a dollar figure over an EGP one", async () => {
    const d = (await bootDash(overviewSeed, ALL_TIME)).window.document;
    await click(d, '[aria-label="Order projects by"] .seg', "Earned");
    // Corp's 25,000 cents is more than Acme's 20,000 and Beta's 10,000.
    expect(projectsOn(d)).toEqual(["Loose work", "Acme work", "Beta work", "Corp work", "Dune work"]);
  }, 30_000);

  it("offers An hour as well inside one currency, and Earned there too", async () => {
    const one = {
      projects: [project("a", "A", 20, "USD"), project("b", "B", 90, "USD"), project("c", "C", 50, "USD")],
      sessions: [
        sitting("s1", "a", 20, "USD", 10, 3), sitting("s2", "b", 90, "USD", 6, 2),
        sitting("s3", "c", 50, "USD", 2, 1),
      ],
    };
    const d = (await bootDash(one, ALL_TIME)).window.document;
    expect(labels(d, "Order projects by")).toEqual(["Time", "An hour", "Earned"]);
    expect(projectsOn(d)).toEqual(["A", "B", "C"]);
    await click(d, '[aria-label="Order projects by"] .seg', "Earned");
    expect(projectsOn(d)).toEqual(["B", "A", "C"]);
  }, 30_000);

  it("falls back to Time when the default is An hour and it is not on offer", async () => {
    const dom = await bootDash({ ...overviewSeed, prefs: [pref("byProjectSort", "rate")] }, ALL_TIME);
    expect(projectsOn(dom.window.document)[0]).toBe("Loose work");
    expect(dom.window.document.querySelector('[aria-label="Order projects by"] .seg.on').textContent)
      .toBe("Time");
  }, 30_000);

  it("opens on the synced default after a reload", async () => {
    const dom = await boot(overviewSeed, ALL_TIME);
    await settle();
    await toProjects(dom.window.document, "Settings");
    setValue(dom.window, defaultsSelect(dom.window.document, "Overview, By project"), "earned");
    await settle();
    const again = await bootDash(stored(dom), ALL_TIME);
    expect(projectsOn(again.window.document))
      .toEqual(["Loose work", "Acme work", "Beta work", "Corp work", "Dune work"]);
  }, 40_000);
});

// ---------------------------------------------------------- Project page

const day = (n) => T - n * DAY;
const earning = (id, cents, currency, daysBack, extra = {}) => ({
  id, projectId: "p", taskId: null, kind: "bonus", cents, currency, at: day(daysBack),
  note: "", createdAt: day(daysBack), deletedAt: null, ...extra,
});
// Project currency USD. Amounts, newest first:
//   e1 EGP 20 (0 days back), e2 EGP 5,000 (1), e3 USD 100 (2), e4 USD -50 (3),
//   e5 USD 300 (4), e6 USD 400 cancelled (5).
// 5,000 EGP is 500,000 cents against 30,000 for $300: a bare comparison puts
// EGP first, grouping by the project's own currency puts USD first.
const pageSeed = (extra = {}) => ({
  projects: [project("p", "Acme", 20, "USD")],
  sessions: [
    sitting("s1", "p", 20, "USD", 1, 5), sitting("s2", "p", 20, "USD", 3, 4),
    sitting("s3", "p", 100, "EGP", 1.5, 3), sitting("s4", "p", 800, "EGP", 0.5, 2),
    sitting("s5", "p", 20, "USD", 2, 1, { kind: "idle" }),
  ],
  earnings: [
    earning("e1", 2_000, "EGP", 0), earning("e2", 500_000, "EGP", 1),
    earning("e3", 10_000, "USD", 2), earning("e4", -5_000, "USD", 3),
    earning("e5", 30_000, "USD", 4), earning("e6", 40_000, "USD", 5, { status: "cancelled" }),
  ],
  ...extra,
});
const openProject = async (seed) => {
  const dom = await boot(seed);
  await settle();
  const d = dom.window.document;
  await toProjects(d, "Work");
  d.querySelector(".card").click();
  await settle();
  return { dom, d };
};
const money = (cents, cur) => formatMoney(cents, cur);
const earningAmounts = (d) => [...d.querySelectorAll(".ern-amt")].map((n) => n.textContent);
const sessionAmounts = (d) => [...d.querySelectorAll(".row.pick .row-amt")].map((n) => n.textContent);

describe("a project's Earnings list", () => {
  const E = {
    e1: money(2_000, "EGP"), e2: money(500_000, "EGP"), e3: money(10_000, "USD"),
    e4: money(-5_000, "USD"), e5: money(30_000, "USD"), e6: money(40_000, "USD"),
  };
  const bar = '[aria-label="Order the earnings by"] .sortbtn';

  it("opens newest first, today's order, with Newest marked", async () => {
    const { d } = await openProject(pageSeed());
    expect(earningAmounts(d)).toEqual([E.e1, E.e2, E.e3, E.e4, E.e5, E.e6]);
    expect([...d.querySelectorAll(bar)].map((b) => b.textContent.replace(/ [↓↑]$/, "")))
      .toEqual(["Newest", "Amount"]);
    expect(d.querySelector(`${bar}[aria-pressed=true]`).textContent).toMatch(/^Newest/);
  }, 30_000);

  it("Amount is grouped by currency, the project's own first, signed inside, nothing filtered", async () => {
    const { d } = await openProject(pageSeed());
    await click(d, bar, "Amount");
    // USD: the cancelled 400, then 300, 100, and the deduction last. Then EGP.
    expect(earningAmounts(d)).toEqual([E.e6, E.e5, E.e3, E.e4, E.e2, E.e1]);
  }, 30_000);

  it("turns round for each order", async () => {
    const { d } = await openProject(pageSeed());
    await click(d, bar, "Amount");
    await click(d, bar, "Amount");
    expect(earningAmounts(d)).toEqual([E.e4, E.e3, E.e5, E.e6, E.e1, E.e2]);
    await click(d, bar, "Newest");
    expect(earningAmounts(d)).toEqual([E.e1, E.e2, E.e3, E.e4, E.e5, E.e6]);
    await click(d, bar, "Newest");
    expect(earningAmounts(d)).toEqual([E.e6, E.e5, E.e4, E.e3, E.e2, E.e1]);
  }, 30_000);

  it("opens on the synced default after a reload", async () => {
    const dom = await boot(pageSeed());
    await settle();
    await toProjects(dom.window.document, "Settings");
    setValue(dom.window, defaultsSelect(dom.window.document, "A project’s earnings"), "amount");
    await settle();
    const { d } = await openProject(stored(dom));
    expect(earningAmounts(d)).toEqual([E.e6, E.e5, E.e3, E.e4, E.e2, E.e1]);
  }, 40_000);
});

describe("a project's Sessions ledger", () => {
  // Amounts as the rows show them. s5 is idle and shows what its rate would
  // make of two hours, but it earns nothing and sinks.
  const A = {
    s1: money(2_000, "USD"), s2: money(6_000, "USD"), s3: money(15_000, "EGP"),
    s4: money(40_000, "EGP"), s5: money(4_000, "USD"),
  };
  const bar = '[aria-label="Order the sessions by"] .sortbtn';

  it("opens newest first, today's order", async () => {
    const { d } = await openProject(pageSeed());
    expect(sessionAmounts(d)).toEqual([A.s5, A.s4, A.s3, A.s2, A.s1]);
    expect([...d.querySelectorAll(bar)].map((b) => b.textContent.replace(/ [↓↑]$/, "")))
      .toEqual(["Newest", "Amount"]);
  }, 30_000);

  it("Amount groups by currency, most hours first, idle last", async () => {
    const { d } = await openProject(pageSeed());
    await click(d, bar, "Amount");
    // USD has 6 h against 2 h of EGP. The 400 EGP sitting is worth more than
    // any dollar one as a bare number and still comes after them.
    expect(sessionAmounts(d)).toEqual([A.s2, A.s1, A.s4, A.s3, A.s5]);
  }, 30_000);

  it("turns round, with the idle sitting still last", async () => {
    const { d } = await openProject(pageSeed());
    await click(d, bar, "Amount");
    await click(d, bar, "Amount");
    expect(sessionAmounts(d)).toEqual([A.s1, A.s2, A.s3, A.s4, A.s5]);
    await click(d, bar, "Newest");
    await click(d, bar, "Newest");
    expect(sessionAmounts(d)).toEqual([A.s1, A.s2, A.s3, A.s4, A.s5]);
  }, 30_000);

  it("keeps selection and its bulk actions working under Amount", async () => {
    const { dom, d } = await openProject(pageSeed());
    await click(d, bar, "Amount");
    // The first row now is s2: tick it, and it is the one that is selected.
    d.querySelector(".row.pick .row-check").click();
    await settle();
    expect(d.querySelector(".selbar-count").textContent).toBe("1 selected");
    expect(d.querySelector(".row.pick.sel .row-amt").textContent).toBe(A.s2);
    // The selection survives the order turning round.
    await click(d, bar, "Amount");
    expect(d.querySelector(".row.pick.sel .row-amt").textContent).toBe(A.s2);
    btn(d, /^Mark pending$/).click();
    await settle();
    const saved = stored(dom).sessions.find((s) => s.id === "s2");
    expect(JSON.stringify(saved)).toMatch(/pending/i);
    expect(d.querySelector(".selbar")).toBeNull();
    // And select-all covers every row of the arranged list.
    btn(d, /^Select all 5$/).click();
    await settle();
    expect(d.querySelector(".selbar-count").textContent).toBe("5 selected");
  }, 40_000);

  it("opens on the synced default after a reload", async () => {
    const dom = await boot(pageSeed());
    await settle();
    await toProjects(dom.window.document, "Settings");
    setValue(dom.window, defaultsSelect(dom.window.document, "A project’s sessions"), "amount");
    await settle();
    expect(stored(dom).prefs.find((r) => r.id === "sessionsSort").value).toBe("amount");
    const { d } = await openProject(stored(dom));
    expect(sessionAmounts(d)).toEqual([A.s2, A.s1, A.s4, A.s3, A.s5]);
  }, 40_000);
});
