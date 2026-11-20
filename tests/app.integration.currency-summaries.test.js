/**
 * Converted rankings and converted summary figures. Drives the built artifact
 * with a pre-seeded rates cache and a fetch that rejects: nothing here reaches
 * a real host.
 *
 * Two rules are on trial. Under As earned everything is as it always was, and
 * the individual records (a session row, an earning row, a payline) and
 * everything that writes to the ledger stay in their own currency.
 */
import { describe, it, expect } from "vitest";
import {
  ALL_TIME, boot, bootDash, btn, guardBuiltApp, settle, toProjects,
} from "./app.integration.helpers.js";

guardBuiltApp();

const T = Date.now();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const pref = (id, value) => ({ id, value, createdAt: 1, updatedAt: 1, deletedAt: null });
const STUB = "window.__calls = []; window.fetch = (u) => { window.__calls.push(u); return Promise.reject(new Error('no network in tests')); };";
const rates = (table = { USD: 1, EGP: 53.83, EUR: 0.9 }) => JSON.stringify({
  base: "USD", date: "2026-11-19", fetchedAt: Date.now() - 60_000, rates: table,
});
const project = (id, name, rate, currency, extra = {}) => ({
  id, name, currentRate: rate, currency, createdAt: T - 30 * DAY,
  sessionGoal: null, overallGoal: null, tasks: [], ...extra,
});
const sitting = (id, projectId, rate, currency, startAgo, endAgo, extra = {}) => ({
  id, projectId, kind: "billed", taskId: null, rate, currency, createdAt: T - startAgo,
  closedAt: T - endAgo, deletedAt: null, segments: [{ startedAt: T - startAgo, endedAt: T - endAgo }],
  ...extra,
});
const earning = (id, projectId, cents, currency, ago = 5 * MIN) => ({
  id, projectId, taskId: null, kind: "piece", cents, currency, at: T - ago, note: "",
  createdAt: T - ago, deletedAt: null,
});
const withPrefs = (state, extra) => ({
  ...state,
  prefs: [pref("fxOn", true), pref("favourites", ["USD", "EGP"]), ...extra],
});
const bootFx = async (state, settings = {}, script = STUB) => {
  const dom = await boot(state, { ...ALL_TIME, "meter:rates": rates(), ...settings }, script);
  await settle();
  return dom;
};
const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
const text = (els) => [...els].map((e) => e.textContent);
const names = (d, selector) => text(d.querySelectorAll(selector));

// ---------------------------------------------------------------- rankings --

// Cairo earns EGP 5,000 (about $92.88 at 53.83) and Boston earns $200, both for
// one hour. Grouped by currency, EGP comes first (tied hours, then code), so
// 5,000 sits above 200. Ranked in dollars, Boston is the bigger earner.
const trap = () => ({
  projects: [
    project("c", "Cairo", 5000, "EGP", { company: "Cairo Co" }),
    project("b", "Boston", 200, "USD", { company: "Boston Co" }),
  ],
  sessions: [
    sitting("s1", "c", 5000, "EGP", 3 * HOUR, 2 * HOUR),
    sitting("s2", "b", 200, "USD", 3 * HOUR, 2 * HOUR),
  ],
});

describe("rankings in the display currency", () => {
  it("ranks Work cards by Earned as one converted group", async () => {
    const as = (choice) => withPrefs(trap(), [pref("cardsSort", "earned"), pref("displayCurrency", choice)]);
    const native = await bootFx(as("earned"));
    await toProjects(native.window.document, "Work");
    expect(names(native.window.document, ".card-name")).toEqual(["Cairo", "Boston"]);

    const usd = await bootFx(as("USD"));
    await toProjects(usd.window.document, "Work");
    expect(names(usd.window.document, ".card-name")).toEqual(["Boston", "Cairo"]);
  }, 40_000);

  it("keeps the grouping for the whole list when one row has no rate", async () => {
    const state = trap();
    state.projects.push(project("m", "Marks", 10, "SEK"));
    state.sessions.push(sitting("s3", "m", 10, "SEK", 3 * HOUR, 2 * HOUR));
    const dom = await bootFx(
      withPrefs(state, [pref("cardsSort", "earned"), pref("displayCurrency", "USD")]));
    await toProjects(dom.window.document, "Work");
    // SEK is not in the table, so nothing is converted and nothing is mixed:
    // currencies stay grouped, EGP then SEK then USD by code at equal hours.
    expect(names(dom.window.document, ".card-name")).toEqual(["Cairo", "Marks", "Boston"]);
  }, 30_000);

  it("keeps the grouping with rates off", async () => {
    const dom = await boot(
      { ...trap(), prefs: [pref("cardsSort", "earned"), pref("displayCurrency", "USD")] },
      { "meter:rates": rates() }, STUB);
    await settle();
    await toProjects(dom.window.document, "Work");
    expect(names(dom.window.document, ".card-name")).toEqual(["Cairo", "Boston"]);
    expect(dom.window.__calls).toEqual([]);
  }, 30_000);

  it("ranks the Overview By project Earned in the display currency", async () => {
    const as = (choice) => withPrefs(trap(), [pref("byProjectSort", "earned"), pref("displayCurrency", choice)]);
    const native = await bootFx(as("earned"));
    await toProjects(native.window.document, "Overview");
    expect(names(native.window.document, ".prow-name")).toEqual(["Cairo", "Boston"]);
    const usd = await bootFx(as("USD"));
    await toProjects(usd.window.document, "Overview");
    expect(names(usd.window.document, ".prow-name")).toEqual(["Boston", "Cairo"]);
  }, 40_000);

  it("ranks By company on Earned and on An hour in the display currency", async () => {
    for (const sort of ["earned", "rate"]) {
      const as = (choice) => withPrefs(trap(), [pref("byCompanySort", sort), pref("displayCurrency", choice)]);
      const native = await bootFx(as("earned"));
      await toProjects(native.window.document, "Overview");
      expect(names(native.window.document, ".crow-name")).toEqual(["Cairo Co", "Boston Co"]);
      const usd = await bootFx(as("USD"));
      await toProjects(usd.window.document, "Overview");
      expect(names(usd.window.document, ".crow-name")).toEqual(["Boston Co", "Cairo Co"]);
    }
  }, 60_000);

  it("ranks a project's Earnings and Sessions on Amount in the display currency", async () => {
    // The project is in EGP, so its own currency leads the native grouping.
    const state = {
      projects: [project("m", "Mixed", 5000, "EGP")],
      sessions: [
        sitting("s1", "m", 5000, "EGP", 6 * HOUR, 5 * HOUR),
        sitting("s2", "m", 200, "USD", 4 * HOUR, 3 * HOUR),
      ],
      earnings: [earning("e1", "m", 500_000, "EGP", 3 * HOUR), earning("e2", "m", 20_000, "USD", 2 * HOUR)],
    };
    const amounts = async (choice) => {
      const dom = await bootFx(withPrefs(state, [
        pref("earningsSort", "amount"), pref("sessionsSort", "amount"), pref("displayCurrency", choice),
      ]));
      const d = dom.window.document;
      await toProjects(d, "Work");
      d.querySelector(".card").click();
      await settle();
      return {
        earnings: names(d, ".ern-amt"), sessions: names(d, ".row.pick .row-amt"),
      };
    };
    const native = await amounts("earned");
    expect(native.earnings[0]).toMatch(/5,000\.00/);
    expect(native.sessions[0]).toMatch(/5,000\.00/);
    const usd = await amounts("USD");
    expect(usd.earnings[0]).toMatch(/\$200\.00/);
    expect(usd.earnings[1]).toMatch(/5,000\.00/);
    expect(usd.sessions[0]).toMatch(/\$200\.00/);
    // The rows themselves stay in their own currency.
    expect(usd.earnings.join("")).not.toMatch(/≈/);
    expect(usd.sessions.join("")).not.toMatch(/≈/);
  }, 60_000);
});

// ------------------------------------------------------- summary figures --

// Orion: $20 of work (6 min at $200/h) on a task, 6 idle minutes beside it, and
// a EUR 5.00 settlement. Sphinx: EGP 100.00, all in its own currency.
const rich = () => ({
  projects: [
    project("o", "Orion", 200, "USD", {
      company: "Acme", tasks: [{ id: "t1", label: "T-1", createdAt: T - 30 * DAY }],
    }),
    project("s", "Sphinx", 1000, "EGP", { company: "Nile" }),
  ],
  sessions: [
    sitting("o1", "o", 200, "USD", 30 * MIN, 24 * MIN, { taskId: "t1" }),
    { ...sitting("o2", "o", 200, "USD", 20 * MIN, 14 * MIN), kind: "idle" },
    sitting("s1", "s", 1000, "EGP", 30 * MIN, 24 * MIN),
  ],
  earnings: [earning("e1", "o", 500, "EUR")],
});
// 20 USD + 5 EUR at 0.9 to the dollar, in EGP at 53.83 to the dollar.
const ORION_EGP = /≈ EGP.1,?\s?\d{3}\.\d\d/;

describe("summary figures in the display currency", () => {
  const as = (choice) => withPrefs(rich(), [pref("displayCurrency", choice)]);

  it("converts Today's project rows and the Recent day headings, and leaves single-currency ones", async () => {
    const dom = await bootFx(as("EGP"));
    const d = dom.window.document;
    const rows = names(d, ".trow-amt");
    expect(rows.some((r) => ORION_EGP.test(r))).toBe(true);
    expect(rows.some((r) => /^EGP.100\.00$/.test(r))).toBe(true);
    expect(d.querySelector(".day .day-sum").textContent).toMatch(/^≈ EGP/);
    expect(d.querySelector(".day .day-sum").getAttribute("title")).toMatch(/rates$/);
    // The session rows beneath stay native.
    const sessions = names(d, ".day .row-amt, .day .trow-amt");
    expect(sessions.join("")).not.toMatch(/≈/);
  }, 30_000);

  it("converts the Overview By project and By company rows", async () => {
    const dom = await bootFx(as("EGP"));
    const d = dom.window.document;
    await toProjects(d, "Overview");
    expect(names(d, ".prow-amt").some((t) => ORION_EGP.test(t))).toBe(true);
    expect(names(d, ".prow-amt")).toContain(names(d, ".prow-amt").find((t) => /^EGP.100\.00$/.test(t)));
    expect(names(d, ".crow-amt").some((t) => ORION_EGP.test(t))).toBe(true);
    // Per-hour rates are not converted.
    expect(d.querySelector(".crow-meta").textContent).not.toMatch(/≈/);
  }, 30_000);

  it("converts a project's Earnings heading, its tasks and its unearned figure, but not its records", async () => {
    const dom = await bootFx(as("EGP"));
    const d = dom.window.document;
    await toProjects(d, "Work");
    [...d.querySelectorAll(".card")].find((c) => c.textContent.includes("Orion")).click();
    await settle();
    const head = [...d.querySelectorAll(".sec-head")].find((h) => /Earned without the clock/.test(h.textContent));
    expect(head.textContent).toMatch(/≈ EGP.268\.|≈ EGP.2\d\d\.\d\d/);
    expect(d.body.textContent).toMatch(/≈ EGP.1,076\.60 unearned/);
    expect(names(d, ".trow-amt").some((t) => /≈ EGP.1,076\.60/.test(t))).toBe(true);
    // The earning row itself is still the EUR amount.
    expect(names(d, ".ern-amt")).toEqual(["€5.00"]);
  }, 30_000);

  it("shows all of it as earned under As earned", async () => {
    const dom = await bootFx(as("earned"));
    const d = dom.window.document;
    expect(names(d, ".trow-amt").join("|")).toMatch(/\$20\.00 · €5\.00/);
    await toProjects(d, "Overview");
    expect(names(d, ".prow-amt")).toContain("$20.00");
    expect(d.body.textContent).not.toMatch(/≈/);
    await toProjects(d, "Work");
    [...d.querySelectorAll(".card")].find((c) => c.textContent.includes("Orion")).click();
    await settle();
    expect(d.body.textContent).toMatch(/\$20\.00 unearned/);
    expect(d.body.textContent).not.toMatch(/≈/);
  }, 30_000);
});

// ------------------------------------------------------- upcoming payments --

describe("Upcoming payments in the display currency", () => {
  const ASKED = { "meter:payouts-asked": "1" };
  const WEEKLY = { kind: "weekly", cutoff: 1, payday: 3, after: 0 };
  /** One payday well in the past and one still to come, both Northwind's, $40 each. */
  const owed = () => {
    const now = Date.now();
    const done = (id, ago) => ({
      id, label: id, createdAt: now - 80 * DAY, state: "accepted", stateAt: now - ago,
      submittedAt: now - ago - HOUR,
    });
    const tasks = [done("old0", 30 * DAY), done("new", HOUR)];
    return {
      projects: [{
        id: "a", name: "Gateway", company: "Northwind", currentRate: 40, currency: "USD",
        createdAt: now - 80 * DAY, sessionGoal: null, overallGoal: null, tasks,
      }],
      sessions: tasks.map((t, i) => ({
        id: `s-${t.id}`, projectId: "a", kind: "billed", taskId: t.id, rate: 40, currency: "USD",
        createdAt: now - (i + 3) * HOUR, closedAt: now - (i + 2) * HOUR, deletedAt: null,
        segments: [{ startedAt: now - (i + 3) * HOUR, endedAt: now - (i + 2) * HOUR }],
      })),
      earnings: [],
      companies: [{
        id: "co:northwind", name: "Northwind", payPeriod: WEEKLY, createdAt: now - 80 * HOUR, deletedAt: null,
      }],
    };
  };
  const dash = (choice) => bootDash(
    withPrefs(owed(), [pref("displayCurrency", choice)]),
    { ...ASKED, "meter:rates": rates() },
  );
  const head = (d) => [...d.querySelectorAll(".sec-head")].find((h) => /Upcoming payments/.test(h.textContent));
  const rowTotals = (d) => names(d, ".payrow .trow-amt");

  it("converts the heading totals and each row's total", async () => {
    const d = (await dash("EGP")).window.document;
    // $40 at 53.83 to the dollar.
    expect(head(d).textContent).toMatch(/≈ EGP.2,153\.20 overdue · ≈ EGP.2,153\.20 confirmed/);
    expect(rowTotals(d)).toHaveLength(2);
    expect(rowTotals(d).every((t) => /^≈ EGP.2,153\.20$/.test(t))).toBe(true);
  }, 30_000);

  it("leaves them as earned under As earned", async () => {
    const d = (await dash("earned")).window.document;
    expect(head(d).textContent).toMatch(/\$40\.00 overdue · \$40\.00 confirmed/);
    expect(rowTotals(d)).toEqual(["$40.00", "$40.00"]);
  }, 30_000);

  it("keeps the lines inside an opened row native", async () => {
    const d = (await dash("EGP")).window.document;
    d.querySelectorAll(".payrow .trow")[0].click();
    await settle();
    expect(names(d, ".payline").join("")).not.toMatch(/≈/);
    expect(names(d, ".payline").join("")).toMatch(/\$/);
  }, 30_000);

  it("stores a payment answered while EGP is shown in the row's own USD cents", async () => {
    const dom = await dash("EGP");
    const d = dom.window.document;
    d.querySelectorAll(".payrow .trow")[0].click();
    await settle();
    btn(d.querySelector(".paylist"), /^Paid in full$/).click();
    await settle();
    // The form is prefilled with what is owed, in the currency it is owed in.
    expect(d.querySelector(".paylist").textContent).not.toMatch(/≈/);
    btn(d.querySelector(".paylist"), /^Save$/).click();
    await settle();
    const payouts = stored(dom).payouts;
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ outcome: "paid", client: "Northwind", currency: "USD" });
    const saved = JSON.stringify(payouts[0]);
    expect(saved).toMatch(/4000/);
    expect(saved).not.toMatch(/215320|2153/);
  }, 30_000);
});

// ------------------------------------------------------------- no fetching --

describe("with live rates off", () => {
  it("fetches nothing while the new figures are on screen", async () => {
    const dom = await boot(
      { ...rich(), prefs: [pref("displayCurrency", "EGP")] }, { ...ALL_TIME, "meter:rates": rates() }, STUB);
    await settle();
    const d = dom.window.document;
    for (const tab of ["Overview", "Work", "Today"]) await toProjects(d, tab);
    expect(dom.window.__calls).toEqual([]);
    expect(d.body.textContent).not.toMatch(/≈/);
  }, 40_000);
});
