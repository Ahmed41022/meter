/**
 * Integration tests against the BUILT artifact, not the source. These catch
 * things unit tests structurally cannot: bundling mistakes, event wiring,
 * and CSS that silently fails (an inline element ignoring margin-top, say).
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { settle, boot, btn, ALL_TIME, bootDash, toProjects, setValue, startMeter, guardBuiltApp } from "./app.integration.helpers.js";

guardBuiltApp();

describe("money the clock never measured", () => {
  const HOUR = 3_600_000;
  const dayStart = (n = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
  };
  const project = (id, extra = {}) => ({
    id, name: id, currentRate: 20.5, currency: "USD", createdAt: dayStart(300),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  const block = (id, pid, hours, back = 0, extra = {}) => ({
    id, projectId: pid, kind: "billed", taskId: null, rate: 20.5, currency: "USD",
    createdAt: dayStart(back) + 9 * HOUR, closedAt: dayStart(back) + (9 + hours) * HOUR,
    deletedAt: null,
    segments: [{ startedAt: dayStart(back) + 9 * HOUR, endedAt: dayStart(back) + (9 + hours) * HOUR }],
    ...extra,
  });
  const earning = (id, pid, cents, back = 0, extra = {}) => ({
    id, projectId: pid, taskId: null, kind: "piece", cents, currency: "USD",
    at: dayStart(back) + 12 * HOUR, note: "", createdAt: dayStart(back), deletedAt: null, ...extra,
  });
  const open = async (seed) => {
    const dom = await bootDash(seed, ALL_TIME);
    await settle();
    return { dom, d: dom.window.document };
  };

  it("adds money with no hours to the total without moving the clock", async () => {
    const { d } = await open({
      projects: [project("a")],
      sessions: [block("s1", "a", 2)],
      earnings: [earning("e1", "a", 300_000, 1, { units: 6 })],
    });
    // 2h at $20.50 = $41.00, plus a $3,000 settlement that took no time
    expect(d.querySelector(".grand-amt").textContent).toBe("$3,041.00");
    expect([...d.querySelectorAll(".tile-val")][0].textContent).toBe("2h 00m");
  }, 25_000);

  it("quotes the rate two ways when most of the money was never timed", async () => {
    const { d } = await open({
      projects: [project("a")],
      sessions: [block("s1", "a", 2)],
      earnings: [earning("e1", "a", 300_000, 1)],
    });
    const tile = [...d.querySelectorAll(".tile")].find((t) => /An hour came to/i.test(t.textContent));
    expect(tile.textContent).toMatch(/\$1,520\.50\/hr/);      // all money over 2h
    expect(tile.textContent).toMatch(/\$20\.50\/hr on timed work/);
    expect(tile.textContent).toMatch(/99% earned no tracked time/);
  }, 25_000);

  it("says nothing about a second rate when every penny was timed", async () => {
    const { d } = await open({ projects: [project("a")], sessions: [block("s1", "a", 2)] });
    const tile = [...d.querySelectorAll(".tile")].find((t) => /An hour came to/i.test(t.textContent));
    expect(tile.textContent).toMatch(/\$20\.50\/hr/);
    expect(tile.textContent).not.toMatch(/on timed work/);
  }, 25_000);

  it("keeps pending money out of the headline and on its own line", async () => {
    const { d } = await open({
      projects: [project("a")],
      sessions: [block("s1", "a", 2), block("s2", "a", 4, 1, { status: "pending" })],
    });
    expect(d.querySelector(".grand-amt").textContent).toBe("$41.00");
    expect(d.querySelector(".grand-pending").textContent).toMatch(/\$82\.00 pending/);
  }, 25_000);

  it("counts cancelled money nowhere but keeps its hours", async () => {
    const { d } = await open({
      projects: [project("a")],
      sessions: [block("s1", "a", 2), block("s2", "a", 4, 1, { status: "cancelled" })],
    });
    expect(d.querySelector(".grand-amt").textContent).toBe("$41.00");
    expect(d.querySelector(".grand-pending")).toBeNull();
  }, 25_000);

  it("does not let a project whose money is all pending read as earning nothing", async () => {
    const { d } = await open({
      projects: [project("a", { name: "Live" }), project("b", { name: "Waiting" })],
      sessions: [block("s1", "a", 2), block("s2", "b", 4, 1, { status: "pending" })],
    });
    const waiting = [...d.querySelectorAll(".prow")].find((r) => /Waiting/.test(r.textContent));
    expect(waiting.textContent).toMatch(/\$82\.00 pending/);
  }, 25_000);

  it("keeps a project with no session at all in the breakdown", async () => {
    // Its whole income was paid per accepted item; filtering on hours would
    // drop the project that earned the most.
    const { d } = await open({
      projects: [project("a", { name: "PieceOnly" })],
      sessions: [],
      earnings: [earning("e1", "a", 975_000, 1)],
    });
    expect([...d.querySelectorAll(".prow-name")].map((e) => e.textContent)).toContain("PieceOnly");
    expect(d.querySelector(".grand-amt").textContent).toBe("$9,750.00");
  }, 25_000);

  it("lists what was earned without the clock on the project page", async () => {
    const { d } = await open({
      projects: [project("a")],
      sessions: [block("s1", "a", 2)],
      earnings: [
        earning("e1", "a", 300_000, 1, { units: 6 }),
        earning("e2", "a", 14_735, 2, { kind: "bonus", note: "mission reward" }),
        earning("e3", "a", -1_181, 3, { kind: "adjust", status: "cancelled" }),
      ],
    });
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();

    const rows = [...d.querySelectorAll(".ern")].map((r) => r.textContent);
    expect(rows[0]).toMatch(/6 × \$500\.00/);       // the fact, not just the total
    expect(rows.join(" ")).toMatch(/mission reward/);
    expect(d.querySelector(".ern.cancelled")).not.toBeNull();
    // the header totals only what actually counts
    const head = [...d.querySelectorAll(".sec-head")].find((h) => /without the clock/i.test(h.textContent));
    expect(head.textContent).toMatch(/\$3,147\.35/);
  }, 30_000);

  it("adds an amount by hand and leaves the hours alone", async () => {
    const { dom, d } = await open({ projects: [project("a")], sessions: [block("s1", "a", 2)] });
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();

    btn(d, /Add earnings/i).click();
    await settle();
    setValue(dom.window, d.querySelector('.ern-form input[type="number"]'), "250");
    await settle();
    btn(d, /^Add$/).click();
    await settle();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.earnings).toHaveLength(1);
    expect(saved.earnings[0].cents).toBe(25_000);
    expect(saved.earnings[0]).not.toHaveProperty("segments");
    // the ledger is untouched: this was money, not time
    expect(saved.sessions).toHaveLength(1);
  }, 30_000);

  it("starts the meter pending on a project that pays once accepted", async () => {
    const { dom, d } = await open({
      projects: [project("a", { paysOnAcceptance: true })], sessions: [],
    });
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    await startMeter(dom, { task: "Batch 1" });

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.sessions[0].status).toBe("pending");
  }, 30_000);

  it("settles a batch of sessions from the ledger", async () => {
    const { dom, d } = await open({
      projects: [project("a")],
      /**
       * Both today, on purpose. The Overview opens on the week, so a fixture
       * dated "2 days ago" sits outside it every Monday and Tuesday and this
       * assertion fails on the calendar rather than on the code. The test is
       * about pending money, not about dates, so it should not have one.
       */
      sessions: [
        block("s1", "a", 2, 0, { status: "pending" }),
        block("s2", "a", 3, 0, {
          status: "pending",
          createdAt: dayStart() + 13 * HOUR,
          closedAt: dayStart() + 16 * HOUR,
          segments: [{ startedAt: dayStart() + 13 * HOUR, endedAt: dayStart() + 16 * HOUR }],
        }),
      ],
    });
    // an em dash, not $0.00: nothing has been earned yet, which is a different
    // statement from having earned zero
    expect(d.querySelector(".grand-amt").textContent).toBe("—");
    expect(d.querySelector(".grand-pending").textContent).toMatch(/\$102\.50 pending/);

    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    btn(d, /Select all/i).click();
    await settle();
    btn(d, /^Mark paid$/).click();
    await settle();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.sessions.every((s) => s.status === undefined)).toBe(true);
  }, 30_000);
});

describe("the project list counts money that had no hours", () => {
  const HOUR = 3_600_000;
  const dayStart = (n = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
  };
  const seed = (earnings) => ({
    projects: [{
      id: "p1", name: "Acme", currentRate: 100, currency: "USD", createdAt: dayStart(300),
      sessionGoal: null, overallGoal: null, tasks: [],
    }],
    sessions: [{
      id: "s1", projectId: "p1", kind: "billed", taskId: null, rate: 100, currency: "USD",
      createdAt: dayStart(1) + 9 * HOUR, closedAt: dayStart(1) + 11 * HOUR, deletedAt: null,
      segments: [{ startedAt: dayStart(1) + 9 * HOUR, endedAt: dayStart(1) + 11 * HOUR }],
    }],
    earnings,
  });
  const earning = (extra = {}) => ({
    id: "e1", projectId: "p1", taskId: null, kind: "piece", cents: 300_000, currency: "USD",
    at: dayStart(2) + 12 * HOUR, note: "", createdAt: dayStart(2), deletedAt: null, ...extra,
  });

  it("adds it to the all-time headline and to the card", async () => {
    // Left out, this understated the headline by more than half on a ledger
    // where most of the work was paid per accepted item.
    const dom = await boot(seed([earning()]));
    const d = dom.window.document;
    await toProjects(d, "Work");
    expect(d.querySelector(".grand-amt").textContent).toBe("$3,200.00");
    expect(d.querySelector(".card-amt").textContent).toBe("$3,200.00");
  }, 25_000);

  it("leaves pending money out of both and says so on the card", async () => {
    const dom = await boot(seed([earning({ status: "pending" })]));
    const d = dom.window.document;
    await toProjects(d, "Work");
    expect(d.querySelector(".grand-amt").textContent).toBe("$200.00");
    expect(d.querySelector(".card-dur").textContent).toMatch(/\$3,000\.00 pending/);
  }, 25_000);

  it("counts cancelled money nowhere", async () => {
    const dom = await boot(seed([earning({ status: "cancelled" })]));
    const d = dom.window.document;
    await toProjects(d, "Work");
    expect(d.querySelector(".grand-amt").textContent).toBe("$200.00");
  }, 25_000);
});

describe("a year on the overview", () => {
  const HOUR = 3_600_000;
  const dayAt = (y, m, d, h = 9) => new Date(y, m, d, h).getTime();
  const thisYear = new Date().getFullYear();
  const project = (id, extra = {}) => ({
    id, name: id, currentRate: 100, currency: "USD", createdAt: dayAt(thisYear - 2, 0, 1),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  const block = (id, pid, hours, y, m, d) => ({
    id, projectId: pid, kind: "billed", taskId: null, rate: 100, currency: "USD",
    createdAt: dayAt(y, m, d), closedAt: dayAt(y, m, d) + hours * HOUR, deletedAt: null,
    segments: [{ startedAt: dayAt(y, m, d), endedAt: dayAt(y, m, d) + hours * HOUR }],
  });
  const open = async (seed) => {
    const dom = await bootDash(seed);
    await settle();
    return { dom, d: dom.window.document };
  };
  const toYear = async (d) => {
    [...d.querySelectorAll(".dash-head .seg")].find((b) => b.textContent === "Year").click();
    await settle();
  };

  it("offers a year beside the day, week and month", async () => {
    const { d } = await open({ projects: [project("a")], sessions: [] });
    expect([...d.querySelectorAll(".dash-head .segmented .seg")].map((b) => b.textContent))
      .toEqual(["Day", "Week", "Month", "Year", "All"]);
  }, 25_000);

  it("totals the whole calendar year and charts it by month", async () => {
    const { d } = await open({
      projects: [project("a")],
      sessions: [
        block("s1", "a", 2, thisYear, 0, 15),   // January
        block("s2", "a", 3, thisYear, 5, 10),   // June
        block("s3", "a", 4, thisYear - 1, 5, 10), // last year, must not count
      ],
    });
    await toYear(d);
    expect(d.querySelector(".grand-amt").textContent).toBe("$500.00");
    expect(d.querySelector(".trend-top").textContent).toMatch(/Time per month/i);
    expect(d.querySelectorAll(".tcol")).toHaveLength(12);
    expect([...d.querySelectorAll(".tlab")].map((e) => e.textContent).filter(Boolean))
      .toHaveLength(12);
  }, 30_000);

  it("counts active months rather than active days", async () => {
    const { d } = await open({
      projects: [project("a")],
      sessions: [block("s1", "a", 2, thisYear, 0, 15), block("s2", "a", 3, thisYear, 5, 10)],
    });
    await toYear(d);
    const tile = [...d.querySelectorAll(".tile")].find((t) => /Active months/i.test(t.textContent));
    expect(tile.textContent).toMatch(/2/);
    expect(tile.textContent).toMatch(/of 12/);
  }, 30_000);

  it("names the year and steps back through them", async () => {
    const { d } = await open({
      projects: [project("a")],
      sessions: [block("s1", "a", 2, thisYear - 1, 5, 10)],
    });
    await toYear(d);
    expect(d.querySelector(".grand .eyebrow").textContent).toMatch(/This year/);
    expect(d.querySelector(".dash-sub").textContent).toMatch(new RegExp(`Jan – Dec ${thisYear}`));

    d.querySelector(".stepper .step").click();
    await settle();
    expect(d.querySelector(".grand .eyebrow").textContent).toMatch(/Last year/);
    expect(d.querySelector(".grand-amt").textContent).toBe("$200.00");
  }, 30_000);
});

describe("the company panel showing up at all", () => {
  const HOUR = 3_600_000;
  const dayStart = (n = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
  };
  const project = (id, extra = {}) => ({
    id, name: id, currentRate: 100, currency: "USD", createdAt: dayStart(300),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  const block = (id, pid, hours) => ({
    id, projectId: pid, kind: "billed", taskId: null, rate: 100, currency: "USD",
    createdAt: dayStart(1) + 9 * HOUR, closedAt: dayStart(1) + (9 + hours) * HOUR, deletedAt: null,
    segments: [{ startedAt: dayStart(1) + 9 * HOUR, endedAt: dayStart(1) + (9 + hours) * HOUR }],
  });
  const open = async (seed) => {
    const dom = await bootDash(seed, ALL_TIME);
    await settle();
    return dom.window.document;
  };

  it("appears for one company once it carries several projects", async () => {
    // The case a whole imported history lands in: forty projects, one client.
    const d = await open({
      projects: [
        project("a", { company: "Northwind" }),
        project("b", { company: "Northwind" }),
      ],
      sessions: [block("s1", "a", 2), block("s2", "b", 3)],
    });
    expect(d.querySelector(".crow")).not.toBeNull();
    expect(d.querySelector(".crow-name").textContent).toBe("Northwind");
    expect([...d.querySelectorAll(".sec-head")].some((h) => /1 company\b/.test(h.textContent)))
      .toBe(true);
  }, 25_000);

  it("still skips one company on one project, which is just its name again", async () => {
    const d = await open({
      projects: [project("a", { company: "Northwind" })],
      sessions: [block("s1", "a", 2)],
    });
    expect(d.querySelector(".crow")).toBeNull();
  }, 25_000);
});

describe("reaching further back on the calendar", () => {
  const HOUR = 3_600_000;
  const daysAgo = (n) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
  };
  const seedWith = (backDays) => ({
    projects: [{
      id: "p1", name: "Acme", currentRate: 100, currency: "USD", createdAt: daysAgo(900),
      sessionGoal: null, overallGoal: null, tasks: [],
    }],
    sessions: backDays.map((n, i) => ({
      id: `s${i}`, projectId: "p1", kind: "billed", taskId: null, rate: 100, currency: "USD",
      createdAt: daysAgo(n) + 9 * HOUR, closedAt: daysAgo(n) + 11 * HOUR, deletedAt: null,
      segments: [{ startedAt: daysAgo(n) + 9 * HOUR, endedAt: daysAgo(n) + 11 * HOUR }],
    })),
  });

  it("offers no stepper when everything fits in one calendar", async () => {
    const dom = await bootDash(seedWith([1, 2, 3]));
    await settle();
    expect(dom.window.document.querySelector(".hm-head .step")).toBeNull();
  }, 25_000);

  it("steps back a whole calendar at a time and stops at the oldest record", async () => {
    const dom = await bootDash(seedWith([1, 400]));
    const d = dom.window.document;
    await settle();
    const steps = () => [...d.querySelectorAll(".hm-head .step")];
    expect(steps()).toHaveLength(2);
    expect(steps()[1].disabled).toBe(true);           // nothing later than now

    const firstSpan = d.querySelector(".hm-span").textContent;
    expect(d.querySelector(".hm-read").textContent).toMatch(/1 active day/);

    steps()[0].click();
    await settle();
    expect(d.querySelector(".hm-span").textContent).not.toBe(firstSpan);
    expect(d.querySelector(".hm-read").textContent).toMatch(/1 active day/);
    expect(steps()[0].disabled).toBe(true);           // nothing older than that
    expect(steps()[1].disabled).toBe(false);
  }, 30_000);
});

describe("all time on the overview", () => {
  const HOUR = 3_600_000;
  const dayAt = (y, m, d, h = 9) => new Date(y, m, d, h).getTime();
  const thisYear = new Date().getFullYear();
  const project = (id, extra = {}) => ({
    id, name: id, currentRate: 100, currency: "USD", createdAt: dayAt(thisYear - 3, 0, 1),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  const block = (id, pid, hours, start) => ({
    id, projectId: pid, kind: "billed", taskId: null, rate: 100, currency: "USD",
    createdAt: start, closedAt: start + hours * HOUR, deletedAt: null,
    segments: [{ startedAt: start, endedAt: start + hours * HOUR }],
  });
  /**
   * History reaching back across two new years, so all time really has to
   * span years. Every session is in the past whatever the date: the newest
   * used to be 20 January of the current year, which from the 1st to the
   * 19th had not happened yet, and the total read $500 and 5h, not $900 and 9h.
   */
  const history = {
    projects: [project("a")],
    sessions: [
      block("s1", "a", 2, dayAt(thisYear - 2, 0, 15)), // Jan, two years ago
      block("s2", "a", 3, dayAt(thisYear - 1, 5, 10)), // Jun, last year
      block("s3", "a", 4, Date.now() - 2 * 86_400_000), // two days ago
    ],
  };
  const open = async (seed) => {
    const dom = await bootDash(seed);
    await settle();
    return { dom, d: dom.window.document };
  };
  const toAll = async (d) => {
    [...d.querySelectorAll(".dash-head .seg")].find((b) => b.textContent === "All").click();
    await settle();
  };

  it("offers All as a fifth period, after the ones that repeat", async () => {
    const { d } = await open(history);
    expect([...d.querySelectorAll(".dash-head .segmented .seg")].map((b) => b.textContent))
      .toEqual(["Day", "Week", "Month", "Year", "All"]);
  }, 25_000);

  it("totals every year at once and charts it month by month", async () => {
    const { d } = await open(history);
    await toAll(d);
    expect(d.querySelector(".grand .eyebrow").textContent).toMatch(/All time/);
    expect(d.querySelector(".grand-amt").textContent).toBe("$900.00"); // 9h at 100
    expect(d.querySelector(".trend-top").textContent).toMatch(/Time per month/i);
  }, 30_000);

  it("names the span, so a total with no dates on it cannot be misread", async () => {
    const { d } = await open(history);
    await toAll(d);
    // toContain, not a built regex: a backslash class inside a template literal
    // is one escaping mistake away from silently matching something else.
    expect(d.querySelector(".dash-sub").textContent)
      .toContain(`Jan ${thisYear - 2} – `);
    expect(d.querySelector(".dash-sub").textContent).toContain(String(thisYear));
  }, 30_000);

  it("offers no stepper, because there is exactly one all time", async () => {
    const { d } = await open(history);
    expect(d.querySelector(".dash-head .stepper")).not.toBeNull();
    await toAll(d);
    expect(d.querySelector(".dash-head .stepper")).toBeNull();
  }, 30_000);

  it("draws no comparison figures, having nothing to compare against", async () => {
    // A delta here would have to invent a previous all time. Reading "0%"
    // against a period that cannot exist is worse than reading nothing.
    const { d } = await open(history);
    await toAll(d);
    expect(d.querySelector(".dash-sub .delta")).toBeNull();
    expect(d.querySelector(".tiles .delta")).toBeNull();
    // the figures themselves are still there
    expect([...d.querySelectorAll(".tile-val")][0].textContent).toBe("9h 00m");
  }, 30_000);

  it("counts a project paid per accepted item, which owns no session", async () => {
    const { d } = await open({
      projects: [project("a", { name: "PieceOnly" })],
      sessions: [],
      earnings: [{
        id: "e1", projectId: "a", taskId: null, kind: "piece", cents: 975_000,
        currency: "USD", at: dayAt(thisYear - 2, 3, 9, 12), note: "",
        createdAt: dayAt(thisYear - 2, 3, 9), deletedAt: null,
      }],
    });
    await toAll(d);
    // The window has to open where the MONEY starts; a window built from
    // sessions alone would begin after this and report nothing.
    expect(d.querySelector(".grand-amt").textContent).toBe("$9,750.00");
  }, 30_000);
});
