/**
 * Integration tests against the BUILT artifact, not the source. These catch
 * things unit tests structurally cannot: bundling mistakes, event wiring,
 * and CSS that silently fails (an inline element ignoring margin-top, say).
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { settle, btn, ALL_TIME, bootDash, toProjects, guardBuiltApp } from "./app.integration.helpers.js";

guardBuiltApp();

describe("pacing a target", () => {
  const HOUR = 3_600_000;
  const dayStart = (n = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
  };
  /** Monday 00:00 of the week being reported on, whatever day it is today. */
  const weekStart = () => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
  };
  /** Days of this week already finished — Monday 0, Sunday 6. Derived from the
   *  calendar rather than from the app, so it is an independent expectation. */
  const daysDone = () => (new Date().getDay() + 6) % 7;

  const project = (extra = {}) => ({
    id: "p1", name: "Acme", currentRate: 100, currency: "USD", createdAt: dayStart(60),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  const block = (from, to, extra = {}) => ({
    id: `s${from}`, projectId: "p1", kind: "billed", taskId: null, rate: 100, currency: "USD",
    createdAt: from, closedAt: to, deletedAt: null,
    segments: [{ startedAt: from, endedAt: to }], ...extra,
  });
  /** Three hours today — always inside both the current week and month. */
  const todaysWork = () => block(dayStart() + HOUR, dayStart() + 4 * HOUR);

  const overview = async (seed) => {
    const dom = await bootDash(seed);
    await settle();
    return { dom, d: dom.window.document };
  };

  it("shows a weekly target with how it is going", async () => {
    const { d } = await overview({
      projects: [project({ overallGoal: { type: "money", target: 1260, period: "week" } })],
      sessions: [todaysWork()],
    });
    const row = d.querySelector(".trg");
    expect(row).not.toBeNull();
    expect(row.textContent).toMatch(/Acme/);
    expect(row.textContent).toMatch(/this week/);
    expect(row.querySelector(".goal-val").textContent).toBe("$300.00 / $1,260.00");
    // Whatever day it is, there is a standing and a daily figure to act on.
    expect(row.querySelector(".goal-pace").textContent).toMatch(/needs \$[\d,.]+\/day/);
    expect(row.querySelector(".goal-pace").textContent).toMatch(/left|behind|ahead|On pace/);
  }, 25_000);

  it("marks where the finished days say you should be", async () => {
    // Nothing is owed on the first day of a period, so there is nothing to
    // mark; from the second day on the mark is the whole point.
    const { d } = await overview({
      projects: [project({ overallGoal: { type: "money", target: 1260, period: "week" } })],
      sessions: [todaysWork()],
    });
    const mark = d.querySelector(".trg .bar-mark");
    if (daysDone() === 0) expect(mark).toBeNull();
    else expect(mark).not.toBeNull();
  }, 25_000);

  it("says met rather than asking for more once the target is reached", async () => {
    const { d } = await overview({
      projects: [project({ overallGoal: { type: "money", target: 100, period: "week" } })],
      sessions: [todaysWork()],
    });
    expect(d.querySelector(".trg .goal-pace").textContent).toMatch(/^Met · \$200\.00 over$/);
    expect(d.querySelector(".trg .bar-mark")).toBeNull();
    expect(d.querySelector(".trg .bar-fill").className).toMatch(/done/);
  }, 25_000);

  it("leaves a lifetime goal out of it", async () => {
    // A target with no end cannot be late, so there is no pace to report.
    const { d } = await overview({
      projects: [project({ overallGoal: { type: "money", target: 50_000, period: "lifetime" } })],
      sessions: [todaysWork()],
    });
    expect(d.querySelector(".trg")).toBeNull();
    expect([...d.querySelectorAll(".eyebrow")].some((e) => e.textContent === "Targets")).toBe(false);
  }, 25_000);

  it("keeps sleep and play out of the work targets", async () => {
    const { d } = await overview({
      projects: [project({
        offClock: true, name: "Sleep",
        overallGoal: { type: "time", target: 3360, period: "week" },
      })],
      sessions: [todaysWork()],
    });
    expect(d.querySelector(".trg")).toBeNull();
  }, 25_000);

  it("does not follow the period control", async () => {
    // "Am I on for this week?" is a question about now. Stepping the report
    // back to last month must not change the answer.
    const { d } = await overview({
      projects: [project({ overallGoal: { type: "money", target: 1260, period: "week" } })],
      sessions: [todaysWork()],
    });
    const before = d.querySelector(".trg .goal-pace").textContent;

    btn(d, /^Month$/).click();
    await settle();
    d.querySelector(".step").click(); // step back a month
    await settle();

    expect(d.querySelector(".trg")).not.toBeNull();
    expect(d.querySelector(".trg .goal-pace").textContent).toBe(before);
  }, 25_000);

  it("counts the minutes that fell inside the week, not the ones that started there", async () => {
    // Regression: a session running 23:30 Sunday to 00:30 Monday is half an
    // hour of this week. Crediting it to whichever week it STARTED in gave the
    // goal a different answer from the Overview for the very same days.
    const { d } = await overview({
      projects: [project({ overallGoal: { type: "time", target: 600, period: "week" } })],
      sessions: [block(weekStart() - 30 * 60_000, weekStart() + 30 * 60_000)],
    });
    expect(d.querySelector(".trg .goal-val").textContent).toBe("30m / 10h 00m");

    // and the project's own goal bar must agree, which is where it did not
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    expect(d.querySelector(".goal .goal-val").textContent).toBe("30m / 10h 00m");
  }, 30_000);

  it("reads the same on the project page as on the overview", async () => {
    const { d } = await overview({
      projects: [project({ overallGoal: { type: "money", target: 1260, period: "week" } })],
      sessions: [todaysWork()],
    });
    const fromDash = {
      value: d.querySelector(".trg .goal-val").textContent,
      pace: d.querySelector(".trg .goal-pace").textContent,
    };

    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();

    expect(d.querySelector(".goal .goal-val").textContent).toBe(fromDash.value);
    expect(d.querySelector(".goal .goal-pace").textContent).toBe(fromDash.pace);
  }, 30_000);

  it("leaves a session goal unpaced", async () => {
    // A session has no deadline to be behind on.
    const { d } = await overview({
      projects: [project({ sessionGoal: { type: "money", target: 180 } })],
      sessions: [todaysWork()],
    });
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    expect(d.querySelector(".goal")).not.toBeNull();
    expect(d.querySelector(".goal .goal-pace")).toBeNull();
  }, 30_000);
});

describe("the activity calendar", () => {
  const HOUR = 3_600_000;
  const dayStart = (n = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
  };
  const project = (extra = {}) => ({
    id: "p1", name: "Acme", currentRate: 100, currency: "USD", createdAt: dayStart(400),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  const block = (id, pid, from, to, kind = "billed") => ({
    id, projectId: pid, kind, taskId: null, rate: 100, currency: "USD",
    createdAt: from, closedAt: to, deletedAt: null,
    segments: [{ startedAt: from, endedAt: to }],
  });
  const open = async (seed) => {
    const dom = await bootDash(seed);
    await settle();
    return { dom, d: dom.window.document };
  };
  const cell = (d, at) => d.querySelector(`.hm-cell[data-at="${at}"]`);
  /** The Activity toggle. Named for the section above it rather than for the
   *  tabs, so it cannot be mistaken for navigation. */
  const register = (d, name) =>
    [...d.querySelectorAll(".sec-head .seg")].find((b) => b.textContent === name);
  /** Four days of 1, 2, 3 and 4 hours, so every shade is represented. */
  const spread = (pid = "p1") => [1, 2, 3, 4].map((h, i) =>
    block(`s${pid}${i}`, pid, dayStart(i + 2) + 9 * HOUR, dayStart(i + 2) + (9 + h) * HOUR));

  it("draws a year of days, seven to a column", async () => {
    const { d } = await open({
      projects: [project()], sessions: [block("a", "p1", dayStart(3), dayStart(3) + 2 * HOUR)],
    });
    expect(d.querySelectorAll(".hm-col")).toHaveLength(53);
    expect(d.querySelectorAll(".hm-cell")).toHaveLength(371);
    // today is always in the last column, so the calendar ends where you are
    expect([...d.querySelectorAll(".hm-col")].pop().querySelector(`[data-at="${dayStart()}"]`))
      .not.toBeNull();
  }, 25_000);

  it("leaves the days that have not happened yet unshaded", async () => {
    const { d } = await open({
      projects: [project()], sessions: [block("a", "p1", dayStart(3), dayStart(3) + 2 * HOUR)],
    });
    const future = [...d.querySelectorAll(".hm-cell.future")];
    // between none (Sunday) and six (Monday), and never today or earlier
    expect(future.length).toBeLessThan(7);
    expect(future.every((c) => Number(c.dataset.at) > dayStart())).toBe(true);
    expect(cell(d, dayStart()).className).not.toMatch(/future/);
  }, 25_000);

  it("shades each day by how much it carried", async () => {
    const { d } = await open({ projects: [project()], sessions: spread() });
    expect(cell(d, dayStart(2)).dataset.level).toBe("1"); // 1h, the lightest
    expect(cell(d, dayStart(5)).dataset.level).toBe("4"); // 4h, the darkest
    expect(cell(d, dayStart(9)).dataset.level).toBe("0"); // nothing at all
  }, 25_000);

  it("puts every day on the same shade when they all carried the same", async () => {
    // Four identical days are not a gradient, and rendering them as one would
    // invent a difference the data does not have.
    const { d } = await open({
      projects: [project()],
      sessions: [2, 3, 4, 5].map((n) =>
        block(`s${n}`, "p1", dayStart(n) + 9 * HOUR, dayStart(n) + 12 * HOUR)),
    });
    expect([2, 3, 4, 5].map((n) => cell(d, dayStart(n)).dataset.level))
      .toEqual(["1", "1", "1", "1"]);
  }, 25_000);

  it("splits a session that ran past midnight across both days", async () => {
    // The same overlap rule as every other figure: one session, two days, and
    // neither of them coloured for the whole of it.
    const { d } = await open({
      projects: [project()],
      // Half an hour before day 2 began, counted back from it: added to day
      // 3's start, 23.5 hours ran into day 2 on the day Lord Howe's clocks
      // went forward half an hour, and day 3 had nothing in it.
      sessions: [block("a", "p1", dayStart(2) - 0.5 * HOUR, dayStart(2) + 2.5 * HOUR)],
    });
    expect(cell(d, dayStart(3)).dataset.level).not.toBe("0");
    expect(cell(d, dayStart(2)).dataset.level).not.toBe("0");
  }, 25_000);

  it("reads out the day and the hours on hover", async () => {
    const { dom, d } = await open({
      projects: [project()], sessions: [block("a", "p1", dayStart(3) + 9 * HOUR, dayStart(3) + 13 * HOUR)],
    });
    const read = () => d.querySelector(".hm-read").textContent;
    expect(read()).toMatch(/1 active day/);

    cell(d, dayStart(3)).dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
    await settle();
    expect(read()).toMatch(/4h 00m/);
    expect(read()).toMatch(new RegExp(String(new Date(dayStart(3)).getDate())));

    // an empty day says so, rather than reading as nothing at all
    cell(d, dayStart(4)).dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
    await settle();
    expect(read()).toMatch(/no billed/);

    // and the summary comes back when the pointer leaves
    d.querySelector(".hm-grid").dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true }));
    await settle();
  }, 25_000);

  it("keeps work and off-clock time on separate calendars", async () => {
    // Sleep must not darken a day on the work calendar, and the toggle is how
    // each is read without the other.
    const { d } = await open({
      projects: [project(), project({ id: "p2", name: "Sleep", offClock: true })],
      sessions: [
        block("w", "p1", dayStart(5) + 9 * HOUR, dayStart(5) + 13 * HOUR),
        block("s", "p2", dayStart(3) + 1 * HOUR, dayStart(3) + 8 * HOUR),
      ],
    });
    expect(cell(d, dayStart(5)).dataset.level).not.toBe("0");
    expect(cell(d, dayStart(3)).dataset.level).toBe("0");
    expect(d.querySelector(".hm-top").textContent).toMatch(/Billed per day/);

    register(d, "Off the clock").click();
    await settle();
    expect(cell(d, dayStart(3)).dataset.level).not.toBe("0");
    expect(cell(d, dayStart(5)).dataset.level).toBe("0");
    expect(d.querySelector(".hm-top").textContent).toMatch(/Tracked per day/);
  }, 30_000);

  it("offers no toggle when nothing is tracked off the clock", async () => {
    const { d } = await open({
      projects: [project()], sessions: [block("a", "p1", dayStart(3), dayStart(3) + 2 * HOUR)],
    });
    expect(d.querySelector(".hm")).not.toBeNull();
    expect(d.querySelector(".sec-head .segmented")).toBeNull();
  }, 25_000);

  it("states the thresholds rather than saying less and more", async () => {
    // They are quantiles of whatever is being shaded, so they mean nothing
    // unless the legend spells them out.
    const { d } = await open({
      projects: [project()],
      sessions: spread(),
    });
    const legend = [...d.querySelectorAll(".hm-legend .legend-item")].map((e) => e.textContent);
    expect(legend).toEqual(["to 1h 00m", "to 2h 00m", "to 3h 00m", "over 3h 00m"]);
  }, 25_000);

  it("does not follow the period control", async () => {
    const { d } = await open({ projects: [project()], sessions: spread() });
    const before = d.querySelector(".hm-top").textContent;
    btn(d, /^Day$/).click();
    await settle();
    d.querySelector(".step").click();
    await settle();
    expect(d.querySelector(".hm-top").textContent).toBe(before);
    expect(cell(d, dayStart(5)).dataset.level).toBe("4");
  }, 25_000);

  it("says so plainly when there is nothing to shade", async () => {
    const { d } = await open({ projects: [project()], sessions: [] });
    expect(d.querySelector(".hm-none").textContent).toMatch(/Nothing recorded in the last year/);
    expect(d.querySelector(".hm-legend")).toBeNull();
    expect([...d.querySelectorAll(".hm-cell")].every((c) => c.dataset.level !== "4")).toBe(true);
  }, 25_000);
});

describe("companies, and projects that have stopped", () => {
  const HOUR = 3_600_000;
  const dayStart = (n = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
  };
  const project = (id, extra = {}) => ({
    id, name: id, currentRate: 100, currency: "USD", createdAt: dayStart(300),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  const block = (id, pid, hours, back = 0, rate = 100, kind = "billed") => ({
    id, projectId: pid, kind, taskId: null, rate, currency: "USD",
    createdAt: dayStart(back) + 9 * HOUR, closedAt: dayStart(back) + (9 + hours) * HOUR,
    deletedAt: null,
    segments: [{ startedAt: dayStart(back) + 9 * HOUR, endedAt: dayStart(back) + (9 + hours) * HOUR }],
  });
  const open = async (seed) => {
    const dom = await bootDash(seed, ALL_TIME);
    await settle();
    return { dom, d: dom.window.document };
  };
  const crows = (d) => [...d.querySelectorAll(".crow")].map((r) => r.textContent);

  it("totals every project belonging to one company", async () => {
    const { d } = await open({
      projects: [
        project("a", { name: "Pref", company: "Northwind" }),
        project("b", { name: "Reviews", company: "Northwind" }),
        project("c", { name: "Lumen", company: "Lumen Labs", currentRate: 10 }),
      ],
      sessions: [block("s1", "a", 2), block("s2", "b", 3), block("s3", "c", 4, 0, 10)],
    });
    const rows = crows(d);
    expect(rows[0]).toMatch(/Northwind/);
    expect(rows[0]).toMatch(/\$500\.00/);        // 5h at $100
    expect(rows[0]).toMatch(/5h 00m/);
    expect(rows[0]).toMatch(/2 projects/);
  }, 25_000);

  it("reports what an hour of each client actually came to", async () => {
    // The figure a per-project rate cannot give you: one client is worth ten
    // of the other per hour, and only this says so.
    const { d } = await open({
      projects: [
        project("a", { company: "Rich", currentRate: 100 }),
        project("b", { company: "Cheap", currentRate: 10 }),
      ],
      sessions: [block("s1", "a", 2), block("s2", "b", 2, 0, 10)],
    });
    const rows = crows(d);
    expect(rows[0]).toMatch(/\$100\.00\/hr/);
    expect(rows[1]).toMatch(/\$10\.00\/hr/);
    expect(rows[0]).toMatch(/91% of revenue/);   // 200 of 220
  }, 25_000);

  it("shows unassigned work rather than quietly leaving it out of the shares", async () => {
    const { d } = await open({
      projects: [
        project("a", { company: "Northwind" }),
        project("b", { company: "Lumen Labs" }),
        project("c", {}),
      ],
      sessions: [block("s1", "a", 5), block("s2", "b", 3), block("s3", "c", 2)],
    });
    const rows = crows(d);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatch(/No company/);
    expect(rows[2]).toMatch(/20% of revenue/);
  }, 25_000);

  it("does not bother with a breakdown of one client", async () => {
    // The By project panel below already says everything it would.
    const { d } = await open({
      projects: [project("a", { company: "Northwind" })],
      sessions: [block("s1", "a", 2)],
    });
    expect(d.querySelector(".crow")).toBeNull();
  }, 25_000);

  it("never counts sleep as unassigned revenue", async () => {
    const { d } = await open({
      projects: [
        project("a", { company: "Northwind" }),
        project("b", { company: "Lumen Labs" }),
        project("z", { name: "Sleep", offClock: true }),
      ],
      sessions: [block("s1", "a", 2), block("s2", "b", 2), block("s3", "z", 8)],
    });
    expect(crows(d).some((r) => /No company/.test(r))).toBe(false);
    expect(crows(d)).toHaveLength(2);
  }, 25_000);

  it("drops a paused project from Targets but leaves it in the list", async () => {
    const goal = { type: "money", target: 1000, period: "week" };
    const { d } = await open({
      projects: [
        project("a", { name: "Live", overallGoal: goal }),
        project("b", { name: "Quiet", overallGoal: goal, status: "paused", statusAt: dayStart(5) }),
      ],
      sessions: [block("s1", "a", 2), block("s2", "b", 2)],
    });
    expect([...d.querySelectorAll(".trg-name")].map((e) => e.textContent)).toEqual(["Live"]);

    await toProjects(d, "Work");
    const cards = [...d.querySelectorAll(".card")].map((c) => c.textContent);
    expect(cards.some((c) => /Quiet/.test(c))).toBe(true);
    expect(d.querySelector(".card.stopped .tag").textContent).toBe("Paused");
    expect(d.querySelector(".done-head")).toBeNull();
  }, 30_000);

  it("files a finished project away without losing an hour of it", async () => {
    const { d } = await open({
      projects: [
        project("a", { name: "Live" }),
        project("b", { name: "Finished", status: "done", statusAt: dayStart(2) }),
      ],
      sessions: [block("s1", "a", 2), block("s2", "b", 3, 1)],
    });
    // the money and the hours are still in every figure on the Overview
    expect(d.querySelector(".grand-amt").textContent).toBe("$500.00");
    expect([...d.querySelectorAll(".prow-name")].map((e) => e.textContent).sort())
      .toEqual(["Finished", "Live"]);

    await toProjects(d, "Work");
    // but it is out of the working list
    expect([...d.querySelectorAll(".stack > .card")].map((c) => c.textContent)
      .some((t) => /Finished/.test(t))).toBe(false);
    expect(d.querySelector(".done-head").textContent).toMatch(/Done · 1/);

    d.querySelector(".done-head").click();
    await settle();
    expect([...d.querySelectorAll(".card")].some((c) => /Finished/.test(c.textContent))).toBe(true);
  }, 30_000);

  it("refuses new time until it is reopened, and says so", async () => {
    const { d } = await open({
      projects: [project("b", { name: "Finished", status: "done", statusAt: dayStart(2) })],
      sessions: [block("s2", "b", 3, 1)],
    });
    await toProjects(d, "Work");
    d.querySelector(".done-head").click();
    await settle();
    d.querySelector(".card").click();
    await settle();

    expect(btn(d, /Start the meter/i)).toBeUndefined();
    expect(btn(d, /add time/i)).toBeUndefined();
    expect(d.querySelector(".face").textContent).toMatch(/take new time/);

    btn(d, /Reopen this project/i).click();
    await settle();
    expect(btn(d, /Start the meter/i)).toBeDefined();
    expect(btn(d, /add time/i)).toBeDefined();
  }, 30_000);

  it("reports what a finished project came to", async () => {
    const { d } = await open({
      projects: [project("b", {
        name: "Finished", status: "done", statusAt: dayStart(2),
        overallGoal: { type: "money", target: 200, period: "lifetime" },
      })],
      sessions: [block("s2", "b", 3, 1), block("s3", "b", 1, 1, 100, "idle")],
    });
    await toProjects(d, "Work");
    d.querySelector(".done-head").click();
    await settle();
    d.querySelector(".card").click();
    await settle();

    const tiles = [...d.querySelectorAll(".tiles.closing .tile")].map((t) => t.textContent);
    expect(tiles[0]).toMatch(/\$300\.00/);      // earned
    expect(tiles[1]).toMatch(/3h 00m/);          // billed
    expect(tiles[1]).toMatch(/1h 00m idle/);
    expect(tiles[2]).toMatch(/\$100\.00\/hr/);   // what an hour came to
    expect(tiles[3]).toMatch(/Met/);             // goal outcome, not pacing
    // and the live meter is gone rather than reading $0.00 for ever
    expect(d.querySelector(".money")).toBeNull();
    expect(d.querySelector(".rail")).toBeNull();
  }, 30_000);

  it("counts the streak of consecutive days", async () => {
    const { d } = await open({
      projects: [project("a")],
      sessions: [0, 1, 2].map((n) => block(`s${n}`, "a", 2, n)),
    });
    expect(d.querySelector(".hm-read").textContent).toMatch(/3-day streak/);
  }, 25_000);

  it("does not break the streak just because today is not logged yet", async () => {
    const { d } = await open({
      projects: [project("a")],
      sessions: [1, 2, 3].map((n) => block(`s${n}`, "a", 2, n)),
    });
    const read = d.querySelector(".hm-read").textContent;
    expect(read).toMatch(/3-day streak/);
    expect(read).toMatch(/none today/);
  }, 25_000);
});
