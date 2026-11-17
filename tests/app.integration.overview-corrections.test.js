/**
 * Integration tests against the BUILT artifact, not the source. These catch
 * things unit tests structurally cannot: bundling mistakes, event wiring,
 * and CSS that silently fails (an inline element ignoring margin-top, say).
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { settle, boot, btn, bootDash, toProjects, setValue, guardBuiltApp } from "./app.integration.helpers.js";

guardBuiltApp();

describe("correcting a forgotten timer", () => {
  const HOUR = 3_600_000;
  // A session started at 09:00 that should have ended at 11:00 but ran to 18:00.
  const seed = () => {
    const day = new Date();
    day.setHours(9, 0, 0, 0);
    const start = day.getTime();
    return {
      projects: [{ id: "p1", name: "Acme", currentRate: 450, currency: "EGP", createdAt: start,
                   sessionGoal: null, overallGoal: null, tasks: [] }],
      sessions: [{ id: "s1", projectId: "p1", kind: "billed", taskId: null, rate: 450,
                   currency: "EGP", createdAt: start,
                   segments: [{ startedAt: start, endedAt: start + 9 * HOUR }],
                   closedAt: start + 9 * HOUR, deletedAt: null }],
      __start: start,
    };
  };
  const open = async (dom) => {
    const d = dom.window.document;
    await toProjects(d);
    d.querySelector(".card").click();
    await settle();
    if (!d.querySelectorAll(".row").length) { btn(d, /Ledger/i).click(); await settle(); }
    return d;
  };
  const stamp = (epoch) => {
    const p = (n) => String(n).padStart(2, "0");
    const x = new Date(epoch);
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
  };

  it("trims the session and drops the earnings to match", async () => {
    const data = seed();
    const dom = await boot(data);
    const { window } = dom;
    const d = await open(dom);
    expect(d.querySelector(".row-amt").textContent).toMatch(/4,050\.00/); // 9h

    btn(d, /^edit$/i).click();
    await settle();
    setValue(window, d.querySelectorAll(".prompt input")[1], stamp(data.__start + 2 * HOUR));
    await settle();
    // The preview shows the new figure before anything is committed.
    expect(d.querySelector(".preview-now").textContent).toContain("2h 00m");
    expect(d.querySelector(".preview-was").textContent).toContain("9h 00m");

    btn(d, /Save correction/i).click();
    await settle();

    expect(d.querySelector(".row-amt").textContent).toMatch(/900\.00/); // 2h at 450
    expect(d.querySelector(".row-when").textContent).toContain("Edited");
    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.sessions[0].original.closedAt).toBe(data.__start + 9 * HOUR);
  }, 30_000);

  it("keeps what the meter recorded, so it can be put back", async () => {
    const data = seed();
    const dom = await boot(data);
    const { window } = dom;
    const d = await open(dom);

    btn(d, /^edit$/i).click();
    await settle();
    setValue(window, d.querySelectorAll(".prompt input")[1], stamp(data.__start + 2 * HOUR));
    btn(d, /Save correction/i).click();
    await settle();
    expect(d.querySelector(".row-amt").textContent).toMatch(/900\.00/);

    btn(d, /^edit$/i).click();
    await settle();
    btn(d, /Undo correction/i).click();
    await settle();

    expect(d.querySelector(".row-amt").textContent).toMatch(/4,050\.00/);
    expect(d.querySelector(".row-when").textContent).not.toContain("Edited");
    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.sessions[0].original).toBeUndefined();
  }, 30_000);

  it("offers an undo straight after the correction", async () => {
    const data = seed();
    const dom = await boot(data);
    const { window } = dom;
    const d = await open(dom);
    btn(d, /^edit$/i).click();
    await settle();
    setValue(window, d.querySelectorAll(".prompt input")[1], stamp(data.__start + 2 * HOUR));
    btn(d, /Save correction/i).click();
    await settle();

    expect(d.querySelector(".toast")).not.toBeNull();
    btn(d, /Undo/i).click();
    await settle();
    expect(d.querySelector(".row-amt").textContent).toMatch(/4,050\.00/);
  }, 30_000);

  it("feeds the corrected hours into the project total", async () => {
    const data = seed();
    const dom = await boot(data);
    const { window } = dom;
    const d = await open(dom);
    btn(d, /^edit$/i).click();
    await settle();
    setValue(window, d.querySelectorAll(".prompt input")[1], stamp(data.__start + 2 * HOUR));
    btn(d, /Save correction/i).click();
    await settle();

    btn(d, /All projects/i).click();
    await settle();
    await toProjects(d);
    expect(d.querySelector(".grand-amt").textContent).toMatch(/900\.00/);
  }, 30_000);

  it("offers no edit link on a session that is still running", async () => {
    const now = Date.now();
    const dom = await boot({
      projects: [{ id: "p1", name: "Acme", currentRate: 450, currency: "EGP", createdAt: now - HOUR,
                   sessionGoal: null, overallGoal: null, tasks: [] }],
      sessions: [{ id: "s1", projectId: "p1", kind: "billed", taskId: null, rate: 450,
                   currency: "EGP", createdAt: now - HOUR,
                   segments: [{ startedAt: now - HOUR, endedAt: null, lastTick: now - 5000 }],
                   closedAt: null, deletedAt: null }],
    });
    const { document: d } = dom.window;
    btn(d, /This tab only/i).click();
    await settle();
    await toProjects(d);
    d.querySelector(".card").click();
    await settle();
    expect(btn(d, /^edit$/i)).toBeUndefined(); // stop it first
  }, 30_000);
});

describe("the overall view", () => {
  const HOUR = 3_600_000;
  const MIN = 60_000;

  /** Calendar boundaries worked out the way the app works them out, so the
   *  seeded sessions land inside a known window however this runs. */
  const dayStart = (daysAgo = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo).getTime();
  };

  const project = (id, name, rate = 450, currency = "EGP") => ({
    id, name, currentRate: rate, currency, createdAt: dayStart(30),
    sessionGoal: null, overallGoal: null, tasks: [],
  });

  const block = (id, projectId, startedAt, endedAt, extra = {}) => ({
    id, projectId, kind: "billed", taskId: null, rate: 450, currency: "EGP",
    createdAt: startedAt, segments: [{ startedAt, endedAt }],
    closedAt: endedAt, deletedAt: null, ...extra,
  });

  const tileValue = (d, label) => [...d.querySelectorAll(".tile")]
    .find((t) => t.querySelector(".eyebrow").textContent === label)
    .querySelector(".tile-val").textContent;

  it("opens on Today, not the project list", async () => {
    // Today leads because it is why the app gets opened at all. The Overview
    // answers how a month went, which nobody asks first. Plain `boot` on
    // purpose: this is the one test in here about where you land.
    const { document: d } = (await boot()).window;
    const today = [...d.querySelectorAll("[role=tab]")].find((t) => t.textContent === "Today");
    expect(today.getAttribute("aria-selected")).toBe("true");
    // Work and Life are places of their own, not sections of one list.
    expect([...d.querySelectorAll(".tabs [role=tab]")].map((t) => t.textContent))
      .toEqual(["Today", "Overview", "Work", "Life"]);
  });

  it("still gives the Overview its full range of spans", async () => {
    const { document: d } = (await bootDash()).window;
    await toProjects(d, "Overview");
    expect([...d.querySelectorAll(".dash-head .segmented .seg")].map((s) => s.textContent))
      .toEqual(["Day", "Week", "Month", "Year", "All"]);
  });

  it("switches to the project list and back without losing either view", async () => {
    const { document: d } = (await bootDash()).window;
    await toProjects(d);
    expect(btn(d, /New project/i)).toBeTruthy();
    // By its own label, not by ".segmented" — the theme switch in the footer
    // is one too, and the claim here is about the period control.
    expect(d.querySelector('[aria-label="Reporting period"]')).toBeNull();

    [...d.querySelectorAll("[role=tab]")].find((t) => t.textContent === "Overview").click();
    await settle();
    expect(d.querySelector('[aria-label="Reporting period"]')).not.toBeNull();
  });

  it("reports what today earned, in time and in money", async () => {
    // Two hours at 450 is 900, and it must read the same in both places.
    const dom = await bootDash({
      projects: [project("p1", "Acme")],
      sessions: [block("s1", "p1", dayStart() + HOUR, dayStart() + 3 * HOUR)],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await settle();

    expect(d.querySelector(".grand-amt").textContent).toMatch(/900\.00/);
    expect(tileValue(d, "Billed")).toBe("2h 00m");
  }, 20_000);

  it("counts a session that ran past midnight in both days, not once in either", async () => {
    // The figure the whole reporting layer exists to get right. 23:30 to 00:30
    // is half an hour of yesterday and half an hour of today, and filing it
    // whole under either day would move money onto the wrong date.
    const dom = await bootDash({
      projects: [project("p1", "Acme")],
      // Counted back from today's start rather than forward from yesterday's:
      // yesterday may have been a day the clocks changed, 23 or 25 hours long.
      sessions: [block("s1", "p1", dayStart() - 30 * MIN, dayStart() + 30 * MIN)],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await settle();

    expect(tileValue(d, "Billed")).toBe("30m");   // today's half
    d.querySelectorAll(".step")[0].click();        // step back to yesterday
    await settle();
    expect(tileValue(d, "Billed")).toBe("30m");   // yesterday's half
  }, 20_000);

  it("steps back through periods and refuses to step into the future", async () => {
    const dom = await bootDash({
      projects: [project("p1", "Acme")],
      sessions: [block("s1", "p1", dayStart(1) + 9 * HOUR, dayStart(1) + 10 * HOUR)],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await settle();

    const [back, forward] = d.querySelectorAll(".step");
    expect(forward.disabled).toBe(true);   // nothing is recorded ahead of now
    expect(d.querySelector(".grand-amt").textContent).toContain("—");

    back.click();
    await settle();
    expect(d.querySelector(".grand").textContent).toMatch(/Yesterday/);
    expect(d.querySelector(".grand-amt").textContent).toMatch(/450\.00/);
    expect(d.querySelectorAll(".step")[1].disabled).toBe(false);
  }, 20_000);

  it("keeps idle time out of the money while still reporting it", async () => {
    const dom = await bootDash({
      projects: [project("p1", "Acme")],
      sessions: [
        block("s1", "p1", dayStart() + HOUR, dayStart() + 2 * HOUR),
        block("s2", "p1", dayStart() + 2 * HOUR, dayStart() + 3 * HOUR, { kind: "idle" }),
      ],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await settle();

    // One billed hour only, though two hours were spent at the desk.
    expect(d.querySelector(".grand-amt").textContent).toMatch(/450\.00/);
    expect(tileValue(d, "Billed")).toBe("1h 00m");
    expect(tileValue(d, "Idle")).toBe("1h 00m");
    expect(tileValue(d, "Billed share")).toBe("50%");
  }, 20_000);

  it("compares against the period before and names it", async () => {
    // Yesterday against the day before it. Both are over, so they are set
    // whole against whole, which no hour of the day this runs at can change.
    // Today, still going, is set against the same point yesterday; that has
    // its own tests, on a clock they pin.
    const dom = await bootDash({
      projects: [project("p1", "Acme")],
      sessions: [
        block("s1", "p1", dayStart(1) + HOUR, dayStart(1) + 3 * HOUR),   // 2h yesterday
        block("s2", "p1", dayStart(2) + HOUR, dayStart(2) + 2 * HOUR),   // 1h the day before
      ],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await settle();
    d.querySelectorAll(".step")[0].click();
    await settle();

    const deltas = [...d.querySelectorAll(".delta")].map((x) => x.textContent);
    expect(deltas.some((t) => /\+100%/.test(t))).toBe(true);
    expect(deltas.some((t) => /the day before/.test(t))).toBe(true);
  }, 20_000);

  it("draws one trend bar per hour of the day and marks the worked one", async () => {
    const dom = await bootDash({
      projects: [project("p1", "Acme")],
      sessions: [block("s1", "p1", dayStart() + 9 * HOUR, dayStart() + 10 * HOUR)],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await settle();

    expect(d.querySelectorAll(".tcol")).toHaveLength(24);
    expect(d.querySelectorAll(".tseg.billed")).toHaveLength(1);
    // Every bar states its own figure, so identity never rests on colour alone.
    const filled = [...d.querySelectorAll(".tcol")].find((c) => c.querySelector(".tseg.billed"));
    expect(filled.getAttribute("aria-label")).toMatch(/1h 00m billed/);
  }, 20_000);

  it("says so plainly when a period recorded nothing", async () => {
    const dom = await bootDash({ projects: [project("p1", "Acme")], sessions: [] });
    const { document: d } = dom.window;
    btn(d, /^Week$/).click();
    await settle();
    expect(d.querySelector(".panel .empty")).not.toBeNull();
    expect(d.querySelectorAll(".tcol")).toHaveLength(0);
  }, 20_000);

  it("gives a week seven bars and a month one per day", async () => {
    const dom = await bootDash({
      projects: [project("p1", "Acme")],
      sessions: [block("s1", "p1", dayStart() + HOUR, dayStart() + 2 * HOUR)],
    });
    const { document: d } = dom.window;
    btn(d, /^Week$/).click();
    await settle();
    expect(d.querySelectorAll(".tcol")).toHaveLength(7);

    btn(d, /^Month$/).click();
    await settle();
    const today = new Date();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    expect(d.querySelectorAll(".tcol")).toHaveLength(daysInMonth);
  }, 25_000);

  it("breaks the period down by project, busiest first, and opens one on click", async () => {
    const dom = await bootDash({
      projects: [project("p1", "Acme"), project("p2", "Beta")],
      sessions: [
        block("s1", "p1", dayStart() + HOUR, dayStart() + 2 * HOUR),                 // 1h
        block("s2", "p2", dayStart() + 2 * HOUR, dayStart() + 5 * HOUR),             // 3h
      ],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await settle();

    const rows = [...d.querySelectorAll(".prow")];
    expect(rows.map((r) => r.querySelector(".prow-name").textContent)).toEqual(["Beta", "Acme"]);
    expect(rows[0].querySelector(".prow-amt").textContent).toMatch(/1,350\.00/); // 3h at 450

    rows[0].click();
    await settle();
    // Opening a project from the overall view lands on that project's meter.
    expect(d.querySelector(".plate-name").textContent).toBe("Beta");
  }, 20_000);

  it("keeps every project bar inside its track, whatever the idle mix", async () => {
    // Regression: the rows are ordered by BILLED time, so the first row is not
    // necessarily the longest overall. Scaling every bar to it let a row below
    // with more idle time compute a width above 100% and overrun its track.
    const dom = await bootDash({
      projects: [project("p1", "Mostly billed"), project("p2", "Mostly idle")],
      sessions: [
        block("s1", "p1", dayStart() + HOUR, dayStart() + 4 * HOUR),                        // 3h billed
        block("s2", "p2", dayStart() + 4 * HOUR, dayStart() + 6 * HOUR),                    // 2h billed
        block("s3", "p2", dayStart() + 6 * HOUR, dayStart() + 11 * HOUR, { kind: "idle" }), // 5h idle
      ],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await settle();

    const rows = [...d.querySelectorAll(".prow")];
    expect(rows.map((r) => r.querySelector(".prow-name").textContent))
      .toEqual(["Mostly billed", "Mostly idle"]);

    for (const row of rows) {
      const widths = [...row.querySelectorAll(".prow-billed, .prow-idle")]
        .map((el) => parseFloat(el.style.width));
      expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(100.01);
    }
  }, 20_000);

  it("leaves a project out of the breakdown when it logged nothing this period", async () => {
    const dom = await bootDash({
      projects: [project("p1", "Acme"), project("p2", "Dormant")],
      sessions: [block("s1", "p1", dayStart() + HOUR, dayStart() + 2 * HOUR)],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await settle();
    expect([...d.querySelectorAll(".prow-name")].map((n) => n.textContent)).toEqual(["Acme"]);
  }, 20_000);

  it("counts a session still running up to the current second", async () => {
    const now = Date.now();
    // An hour ago is YESTERDAY between midnight and 01:00, and the Day window
    // would then hold only the minutes since midnight — so this asserted 450
    // and got 277 for anyone who ran the suite just after midnight. The start
    // is clamped into today, and the expectation is derived from the overlap
    // the app is actually being asked about.
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    const started = Math.max(now - HOUR, midnight + 60_000);
    const dom = await bootDash({
      projects: [project("p1", "Acme")],
      sessions: [{
        id: "s1", projectId: "p1", kind: "billed", taskId: null, rate: 450, currency: "EGP",
        createdAt: started, segments: [{ startedAt: started, endedAt: null, lastTick: now }],
        closedAt: null, deletedAt: null,
      }],
    });
    const { document: d } = dom.window;
    btn(d, /This tab only/i).click();
    await settle();
    btn(d, /^Day$/).click();
    await settle();

    const shown = Number(d.querySelector(".grand-amt").textContent.replace(/[^0-9.]/g, ""));
    const expected = 450 * ((now - started) / HOUR);
    // At least the whole run so far, and no more than a few seconds beyond it:
    // the meter is still going while the test reads it.
    expect(shown).toBeGreaterThanOrEqual(expected - 0.01);
    expect(shown).toBeLessThan(expected + 450 * (10 / 3600));
  }, 20_000);
});

describe("off the clock, in the real UI", () => {
  const HOUR = 3_600_000;

  const dayStart = (daysAgo = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo).getTime();
  };
  const project = (id, name, extra = {}) => ({
    id, name, currentRate: 100, currency: "USD", createdAt: dayStart(30),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  const block = (id, projectId, startedAt, endedAt, extra = {}) => ({
    id, projectId, kind: "billed", taskId: null, rate: 100, currency: "USD",
    createdAt: startedAt, segments: [{ startedAt, endedAt }],
    closedAt: endedAt, deletedAt: null, ...extra,
  });
  const tileValue = (d, label) => [...d.querySelectorAll(".tile")]
    .find((t) => t.querySelector(".eyebrow").textContent === label)
    .querySelector(".tile-val").textContent;

  /** One hour of paid work and eight hours asleep, on the same day. */
  const seed = (offClock) => ({
    projects: [project("p1", "Acme"), project("p2", "Life", { offClock })],
    sessions: [
      block("s1", "p1", dayStart() + 8 * HOUR, dayStart() + 9 * HOUR),
      block("s2", "p2", dayStart() + 9 * HOUR, dayStart() + 17 * HOUR),
    ],
  });

  it("keeps off-clock hours out of earnings, billed time and billed share", async () => {
    const dom = await bootDash(seed(true));
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await settle();

    expect(d.querySelector(".grand-amt").textContent).toMatch(/100\.00/); // the one paid hour
    expect(tileValue(d, "Billed")).toBe("1h 00m");
    expect(tileValue(d, "Billed share")).toBe("100%");
    expect(tileValue(d, "Active hours")).toBe("1");
  }, 20_000);

  it("is what the rate hack could not do — the same data unflagged inflates everything", async () => {
    // Left as an ordinary project, those eight hours land in billed time and
    // in the breakdown no matter how small the rate is. This is the before.
    const dom = await bootDash(seed(false));
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await settle();

    expect(tileValue(d, "Billed")).toBe("9h 00m");
    expect([...d.querySelectorAll(".prow-name")].map((n) => n.textContent))
      .toEqual(["Life", "Acme"]);
  }, 20_000);

  it("reports off-clock time in its own panel instead of dropping it", async () => {
    const dom = await bootDash(seed(true));
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await settle();

    const heads = [...d.querySelectorAll(".sec-head")].map((h) => h.textContent);
    expect(heads.some((t) => /Off the clock/.test(t))).toBe(true);
    const off = d.querySelector(".prow.off");
    expect(off.querySelector(".prow-name").textContent).toBe("Life");
    expect(off.querySelector(".prow-amt").textContent).toBe("8h 00m");
    // and it is not in the work breakdown
    expect([...d.querySelectorAll(".prow:not(.off) .prow-name")].map((n) => n.textContent))
      .toEqual(["Acme"]);
  }, 20_000);

  it("leaves off-clock money out of the lifetime total on the Projects tab", async () => {
    const dom = await bootDash(seed(true));
    const { document: d } = dom.window;
    await toProjects(d);
    expect(d.querySelector(".grand-amt").textContent).toMatch(/100\.00/);
    // Work lists only work; Life is a tab of its own.
    expect([...d.querySelectorAll(".card-name")].map((n) => n.textContent)).toEqual(["Acme"]);
    await toProjects(d, "Life");
    expect(d.querySelector(".card.off .card-name").textContent).toContain("Life");
  }, 20_000);

  it("shows elapsed time rather than a meaningless zero on the meter face", async () => {
    const dom = await bootDash(seed(true));
    const { document: d } = dom.window;
    await toProjects(d, "Life");
    d.querySelector(".card.off").click();
    await settle();

    expect(d.querySelector(".plate-name").textContent).toBe("Life");
    expect(d.querySelector(".plate-rate").textContent).toMatch(/off the clock/i);
    // the headline figure is a duration, not 0.00
    expect(d.querySelector(".money-head").textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  }, 20_000);

  it("moves a project off the clock from its settings, and back again", async () => {
    const dom = await bootDash(seed(false));
    const { document: d } = dom.window;
    await toProjects(d);
    [...d.querySelectorAll(".card-name")].find((n) => n.textContent.includes("Life"))
      .closest(".card").click();
    await settle();

    btn(d, /^Open$/i).click();
    await settle();
    btn(d, /Off the clock/i).click();
    await settle();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.projects.find((p) => p.id === "p2").offClock).toBe(true);
    // the recorded hours are untouched — only how they are counted changed
    expect(saved.sessions.find((s) => s.id === "s2").segments)
      .toEqual(seed(false).sessions[1].segments);

    btn(d, /Paid work/i).click();
    await settle();
    expect(JSON.parse(dom.window.localStorage.getItem("meter:v1"))
      .projects.find((p) => p.id === "p2").offClock).toBe(false);
  }, 25_000);
});

describe("off-clock projects speak a different language", () => {
  const HOUR = 3_600_000;
  const dayStart = (daysAgo = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo).getTime();
  };
  const seed = (offClock) => ({
    projects: [{
      id: "p1", name: "Life", currentRate: 0, currency: "USD", createdAt: dayStart(30),
      sessionGoal: null, overallGoal: null, offClock,
      tasks: [{ id: "t1", label: "Sleep", createdAt: dayStart(5), rate: null }],
    }],
    sessions: [{
      id: "s1", projectId: "p1", kind: "billed", taskId: "t1", rate: 0, currency: "USD",
      createdAt: dayStart(1), closedAt: dayStart(1) + 7 * HOUR, deletedAt: null,
      segments: [{ startedAt: dayStart(1), endedAt: dayStart(1) + 7 * HOUR }],
    }],
  });
  const open = async (offClock) => {
    const dom = await boot(seed(offClock));
    const d = dom.window.document;
    await toProjects(d, offClock ? "Life" : "Work");
    d.querySelector(".card").click();
    await settle();
    return { dom, d };
  };

  it("calls them activities and entries, not tasks and sessions", async () => {
    const { d } = await open(true);
    const text = d.querySelector(".mtr").textContent;
    expect(text).toMatch(/By activity/);
    expect(text).toMatch(/History/);
    expect(text).toMatch(/Start tracking/);
    expect(text).not.toMatch(/By task/);
    expect(text).not.toMatch(/Ledger/);
    expect(text).not.toMatch(/Start the meter/);
  }, 20_000);

  it("keeps the work wording on an ordinary project", async () => {
    const { d } = await open(false);
    const text = d.querySelector(".mtr").textContent;
    expect(text).toMatch(/By task/);
    expect(text).toMatch(/Ledger/);
    expect(text).toMatch(/Start the meter/);
  }, 20_000);

  it("drops the billing-only controls, which have nothing to bill", async () => {
    const { d } = await open(true);
    expect(btn(d, /Start idle/i)).toBeUndefined();
    expect(d.querySelector(".rail")).toBeNull();      // counts out a billable hour
    expect(btn(d, /Start tracking/i)).toBeTruthy();
  }, 20_000);

  it("keeps them on a work project", async () => {
    const { d } = await open(false);
    expect(btn(d, /Start idle/i)).toBeTruthy();
    expect(d.querySelector(".rail")).not.toBeNull();
  }, 20_000);

  it("shows the elapsed figure once, not twice", async () => {
    // The headline already is the duration off the clock; the clock row
    // underneath would otherwise print the identical number again.
    const { d } = await open(true);
    expect(d.querySelector(".money-head").textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(d.querySelector(".clock-main")).toBeNull();
    expect(d.querySelector(".clock-note").textContent).toBe("not tracking");
  }, 20_000);

  it("offers a choice rather than two full-width buttons for how it counts", async () => {
    const { d } = await open(true);
    btn(d, /^Open$/i).click();
    await settle();
    const seg = [...d.querySelectorAll(".seg-btn")]
      .filter((b) => /Paid work|Off the clock/.test(b.textContent));
    expect(seg).toHaveLength(2);
    expect(seg.find((b) => /Off the clock/.test(b.textContent)).getAttribute("aria-selected"))
      .toBe("true");
  }, 20_000);

  it("offers only a time goal, since nothing here can earn", async () => {
    const { d } = await open(true);
    btn(d, /^Open$/i).click();
    await settle();
    const selects = [...d.querySelectorAll("select")];
    expect(selects.some((s) => [...s.options].some((o) => /Money earned/.test(o.textContent))))
      .toBe(false);
  }, 20_000);
});
