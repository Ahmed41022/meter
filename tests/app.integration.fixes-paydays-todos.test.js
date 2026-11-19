/**
 * Integration tests against the BUILT artifact, not the source. These catch
 * things unit tests structurally cannot: bundling mistakes, event wiring,
 * and CSS that silently fails (an inline element ignoring margin-top, say).
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM, DIST, until, settle, appReady, COUNTER, boot, btn, ALL_TIME, bootDash, toProjects, setValue, startMeter, guardBuiltApp } from "./app.integration.helpers.js";

guardBuiltApp();

describe("fixes: paydays and settling", () => {
  const HOUR = 3_600_000;
  const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));

  /** Boots a ledger and opens its first project. */
  const openFirst = async (seed, settings = null) => {
    const dom = await boot(seed, settings);
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    return { dom, d };
  };

  /** Ticks one task's row in By task. */
  const tick = async (d, label) => {
    const row = [...d.querySelectorAll(".trow")]
      .find((r) => r.querySelector(".trow-label")?.textContent.startsWith(label));
    row.querySelector("input.row-check").click();
    await settle();
  };

  const press = async (d, re) => {
    btn(d, re).click();
    await settle();
  };

  /** A project paying $40 an hour plus $50 per accepted item, with one
   *  finished hour on task 1234 that ended `endedAgo` ms ago. */
  const priced = (endedAgo = 2 * HOUR) => {
    const now = Date.now();
    return {
      projects: [{
        id: "a", name: "Gateway", company: "Northwind", currentRate: 40, perTask: 50,
        currency: "USD", paysOnAcceptance: true, createdAt: now - 30 * HOUR,
        sessionGoal: null, overallGoal: null,
        tasks: [{ id: "t1", label: "1234", createdAt: now - 30 * HOUR }],
      }],
      sessions: [{
        id: "s1", projectId: "a", kind: "billed", taskId: "t1", rate: 40, currency: "USD",
        status: "pending", createdAt: now - endedAgo - HOUR, closedAt: now - endedAgo,
        deletedAt: null, segments: [{ startedAt: now - endedAgo - HOUR, endedAt: now - endedAgo }],
      }],
      earnings: [],
    };
  };

  it("pays a task's reward once when it is rejected, reopened, handed in again and accepted", async () => {
    // It used to write a second reward beside the one the rejection had
    // cancelled, and accepting paid both: $140 for $40 of hours and a $50 item.
    const { dom, d } = await openFirst(priced(), ALL_TIME);
    await tick(d, "1234");
    await press(d, /^Submit 1$/);
    await tick(d, "1234");
    await press(d, /^Rejected 1$/);
    await tick(d, "1234");
    await press(d, /^Reopen 1$/);
    expect(d.querySelector(".toast").textContent).toMatch(/money is pending until it is accepted again/);
    await tick(d, "1234");
    await press(d, /^Submit 1$/);
    await tick(d, "1234");
    await press(d, /^Accepted 1$/);

    const live = stored(dom).earnings.filter((e) => !e.deletedAt);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ cents: 5_000, taskIds: ["t1"] });
    expect(live[0].status).toBeUndefined();

    btn(d, /All projects/).click();
    await settle();
    await toProjects(d, "Overview");
    expect(d.querySelector(".grand-amt").textContent).toBe("$90.00");
  }, 30_000);

  it("stops a meter still running on a task when the task is handed in", async () => {
    // It used to keep running on the submitted task, adding time and money to
    // work that could take no more of either.
    const { dom, d } = await openFirst(priced());
    await startMeter(dom, { existing: "1234" });
    expect(d.querySelector(".runbar")).not.toBeNull();
    await tick(d, "1234");
    await press(d, /^Submit 1$/);

    const { sessions, projects } = stored(dom);
    expect(projects[0].tasks[0].state).toBe("submitted");
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.closedAt != null
      && s.segments.every((g) => g.endedAt != null))).toBe(true);
    expect(d.querySelector(".runbar")).toBeNull();
    expect(d.querySelector(".toast").textContent).toMatch(/The meter on it is stopped/);
  }, 30_000);

  /** Task 1234 still open, last worked two days ago; task 1235 handed in an
   *  hour ago, its sitting ending just before. */
  const openAndHandedIn = () => {
    const now = Date.now();
    const sitting = (id, taskId, endedAgo) => ({
      id, projectId: "a", kind: "billed", taskId, rate: 40, currency: "USD",
      createdAt: now - endedAgo - HOUR, closedAt: now - endedAgo, deletedAt: null,
      segments: [{ startedAt: now - endedAgo - HOUR, endedAt: now - endedAgo }],
    });
    return {
      projects: [{
        id: "a", name: "Gateway", currentRate: 40, currency: "USD", createdAt: now - 80 * HOUR,
        sessionGoal: null, overallGoal: null,
        tasks: [
          { id: "t1", label: "1234", createdAt: now - 80 * HOUR },
          { id: "t2", label: "1235", createdAt: now - 80 * HOUR,
            state: "submitted", stateAt: now - HOUR, submittedAt: now - HOUR },
        ],
      }],
      sessions: [sitting("s1", "t1", 50 * HOUR), sitting("s2", "t2", 2 * HOUR)],
      earnings: [],
    };
  };
  /** A moment cut to its minute on the local clock, as the box records it. */
  const minuteOf = (t) => new Date(t).setSeconds(0, 0);

  it("dates an answer at the minute it is pressed, whatever was ticked when the bar opened", async () => {
    // The box used to take its default once, from the first selection: tick
    // an open task, tick a submitted one, untick the open one, and Accepted
    // recorded the open task's last sitting — two days early, a payday early.
    const seed = openAndHandedIn();
    const { dom, d } = await openFirst(seed);
    await tick(d, "1234");
    await tick(d, "1235");
    await tick(d, "1234");
    const before = minuteOf(Date.now());
    await press(d, /^Accepted 1$/);

    const t2 = stored(dom).projects[0].tasks.find((t) => t.id === "t2");
    expect(t2.state).toBe("accepted");
    expect(t2.stateAt).toBeGreaterThanOrEqual(before);
    expect(t2.stateAt).toBeLessThanOrEqual(Date.now());
  }, 30_000);

  it("dates a submission from the open task's last sitting, not from one already handed in", async () => {
    const seed = openAndHandedIn();
    const { dom, d } = await openFirst(seed);
    await tick(d, "1234");
    await tick(d, "1235");
    // Both defaults are said outright, because the box can show only one.
    const hint = [...d.querySelectorAll(".hint")].map((h) => h.textContent).join(" ");
    expect(hint).toMatch(/Submit records .*when the last sitting on this task ended/);
    expect(hint).toMatch(/Accepted and Rejected record the minute you press them/);
    await press(d, /^Submit 1$/);

    const t1 = stored(dom).projects[0].tasks.find((t) => t.id === "t1");
    expect(t1.submittedAt).toBe(minuteOf(seed.sessions[0].closedAt));
  }, 30_000);

  it("uses a typed time for every button until it is put back to the defaults", async () => {
    const { dom, d } = await openFirst(openAndHandedIn());
    await tick(d, "1235");
    const box = d.querySelector(".selbar-when input");
    const typed = minuteOf(Date.now() - 30 * HOUR);
    const p = (n) => String(n).padStart(2, "0");
    const x = new Date(typed);
    setValue(dom.window, box,
      `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`);
    await settle();
    expect(d.querySelector(".wrap").textContent).toMatch(/Every button records the time in the box/);
    btn(d, /^use the defaults$/).click();
    await settle();
    expect(d.querySelector(".wrap").textContent).not.toMatch(/Every button records the time in the box/);
    const before = minuteOf(Date.now());
    await press(d, /^Rejected 1$/);
    expect(stored(dom).projects[0].tasks.find((t) => t.id === "t2").stateAt)
      .toBeGreaterThanOrEqual(before);
  }, 30_000);

  /** A ledger whose companies carry the given schedules, with `tasks` on one
   *  project under `company` and an hour of work on each task. */
  const scheduled = ({ company = "Ganges", rules = {}, tasks, projects = null }) => {
    const now = Date.now();
    const list = projects ?? [{
      id: "a", name: "Gateway", company, currentRate: 40, currency: "USD",
      createdAt: now - 80 * HOUR, sessionGoal: null, overallGoal: null, tasks,
    }];
    return {
      projects: list,
      sessions: list.flatMap((p) => (p.tasks ?? []).map((t, i) => ({
        id: `s-${p.id}-${t.id}`, projectId: p.id, kind: "billed", taskId: t.id, rate: 40,
        currency: "USD", createdAt: now - (i + 3) * HOUR, closedAt: now - (i + 2) * HOUR,
        deletedAt: null,
        segments: [{ startedAt: now - (i + 3) * HOUR, endedAt: now - (i + 2) * HOUR }],
      }))),
      earnings: [],
      companies: Object.entries(rules).map(([name, payPeriod]) => ({
        id: `co:${name.toLowerCase()}`, name, payPeriod, createdAt: now - 80 * HOUR, deletedAt: null,
      })),
    };
  };
  const payLabels = (d) => [...d.querySelectorAll(".payrow .trow-label")].map((e) => e.textContent);
  const payRows = (d) => [...d.querySelectorAll(".payrow .trow-sub")].map((e) => e.textContent);
  /** A weekly schedule on this device's clock: in before Monday, paid Wednesday. */
  const WEEKLY = { kind: "weekly", cutoff: 1, payday: 3, after: 0 };

  it("prints a client's payday on the client's calendar, not the day before", async () => {
    // Kolkata's Wednesday begins on Cairo's Tuesday evening, and printing that
    // midnight on this clock read "Tue". Every payday here is a Wednesday.
    const now = Date.now();
    const d = (await bootDash(scheduled({
      rules: { Ganges: { kind: "weekly", cutoff: 1, payday: 3, after: 0, closesAt: 0, zone: "Asia/Kolkata" } },
      tasks: [{ id: "t1", label: "1234", createdAt: now - 80 * HOUR,
                state: "accepted", stateAt: now - HOUR, submittedAt: now - 2 * HOUR }],
    }))).window.document;
    expect(payLabels(d)).toHaveLength(1);
    expect(payLabels(d)[0]).toMatch(/^Wed/);
  }, 30_000);

  /**
   * Boots with the page's clock `skew` ms off the real one, and
   * `window.__skew` there to move it, so a test can stand just before a
   * cutoff and then step over it. Timers still run on real time.
   */
  const bootSkewed = async (seed, skew) => {
    const clock = `window.__skew = ${skew};`
      + "(() => { const real = Date.now.bind(Date); Date.now = () => real() + window.__skew; })();";
    const store = `localStorage.setItem('meter:v1', ${JSON.stringify(JSON.stringify(seed))});`;
    const html = readFileSync(DIST, "utf8").replace('<div id="root"></div>',
      `<div id="root"></div><script>${clock}${store}</script>${COUNTER}`);
    const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/" });
    await appReady(dom);
    return dom;
  };

  it("moves the soonest date for work under review the minute a cutoff passes", async () => {
    // The forecast was worked out once a day, so a week shutting at 02:00
    // kept promising that week's payday all day long after it had shut.
    const rule = { kind: "weekly", cutoff: 1, payday: 3, after: 0, closesAt: 120, zone: "UTC" };
    // The next Monday on the UTC calendar, from calendar fields.
    const today = new Date();
    const [y, m] = [today.getUTCFullYear(), today.getUTCMonth()];
    const monday = today.getUTCDate() + ((1 - today.getUTCDay() + 7) % 7 || 7);
    const cutoff = Date.UTC(y, m, monday, 2, 0);
    const skew = cutoff - 30_000 - Date.now();
    const at = Date.now() + skew; // the page's now: half a minute before it shuts
    const payday = (days) => new Date(Date.UTC(y, m, monday + days)).toLocaleDateString(undefined, {
      timeZone: "UTC", weekday: "short", day: "numeric", month: "long",
    });
    const seed = {
      projects: [
        // Paid once accepted, so work under review waits with a floor.
        { id: "a", name: "Gateway", company: "Clockwork", currentRate: 40, currency: "USD",
          paysOnAcceptance: true, createdAt: at - 80 * HOUR, sessionGoal: null, overallGoal: null,
          tasks: [{ id: "t1", label: "1234", createdAt: at - 80 * HOUR,
                    state: "submitted", stateAt: at - HOUR, submittedAt: at - HOUR }] },
        // A meter going elsewhere, so the page's clock ticks every second.
        { id: "b", name: "Ticker", currentRate: 10, currency: "USD", createdAt: at - 80 * HOUR,
          sessionGoal: null, overallGoal: null, tasks: [] },
      ],
      sessions: [
        { id: "s1", projectId: "a", kind: "billed", taskId: "t1", rate: 40, currency: "USD",
          createdAt: at - 3 * HOUR, closedAt: at - 2 * HOUR, deletedAt: null,
          segments: [{ startedAt: at - 3 * HOUR, endedAt: at - 2 * HOUR }] },
        { id: "s2", projectId: "b", kind: "billed", taskId: null, rate: 10, currency: "USD",
          createdAt: at - HOUR, closedAt: null, deletedAt: null, device: "elsewhere",
          segments: [{ startedAt: at - HOUR, endedAt: null, lastTick: at }] },
      ],
      earnings: [],
      companies: [{ id: "co:clockwork", name: "Clockwork", payPeriod: rule,
                    createdAt: at - 80 * HOUR, deletedAt: null }],
    };
    const dom = await bootSkewed(seed, skew);
    const d = dom.window.document;
    await settle();
    await toProjects(d, "Overview");
    expect(payLabels(d)).toEqual([`Not before ${payday(2)}`]);

    dom.window.__skew += 60_000;
    await until(() => payLabels(d).join() === `Not before ${payday(9)}`,
      { what: "the pay labels to follow the skewed clock" });
    expect(payLabels(d)).toEqual([`Not before ${payday(9)}`]);
  }, 30_000);

  it("lists a reward shared across tasks with the payday it rides", async () => {
    // A reward naming several tasks was left off Upcoming payments entirely.
    const now = Date.now();
    const accepted = (id) => ({ id, label: id, createdAt: now - 80 * HOUR,
                                state: "accepted", stateAt: now - HOUR, submittedAt: now - 2 * HOUR });
    const seed = scheduled({ company: "Northwind", rules: { Northwind: WEEKLY },
                             tasks: [accepted("1234"), accepted("1235")] });
    seed.earnings = [{
      id: "bonus", projectId: "a", kind: "bonus", cents: 6_000, currency: "USD",
      taskIds: ["1234", "1235"], units: 2, note: "Two-task bonus", status: "pending",
      at: now - HOUR, createdAt: now - HOUR, deletedAt: null,
    }];
    const d = (await bootDash(seed)).window.document;
    expect(payRows(d)).toEqual(["Northwind · 2 tasks · 1 shared reward"]);
    d.querySelector(".payrow .trow").click();
    await settle();
    const lines = [...d.querySelectorAll(".payline")].map((e) => e.textContent);
    expect(lines).toContain("Two-task bonus · 2 tasks · Gateway$60.00");
  }, 30_000);

  it("opens a payday into a line for each kind of a task's money", async () => {
    // Hours, a per-item payment, a bonus and an adjustment were one line, so a
    // bonus could not be told from the time it came with.
    const now = Date.now();
    const seed = scheduled({
      company: "Northwind", rules: { Northwind: WEEKLY },
      tasks: [{ id: "1234", label: "1234", createdAt: now - 80 * HOUR,
                state: "accepted", stateAt: now - HOUR, submittedAt: now - 2 * HOUR }],
    });
    const earning = (id, kind, cents) => ({
      id, projectId: "a", taskId: "1234", kind, cents, currency: "USD", units: 1,
      at: now - HOUR, createdAt: now - HOUR, deletedAt: null,
    });
    seed.earnings = [earning("e1", "piece", 1_200), earning("e2", "bonus", 1_500),
                     earning("e3", "adjust", 400), earning("e4", "adjust", -250)];
    const d = (await bootDash(seed)).window.document;
    // One task, whatever the number of lines, and the row's figure unchanged:
    // an hour at 40, plus 12 + 15 + 4 (71). The deduction is not in it.
    expect(payRows(d)).toEqual(["Northwind · 1 task"]);
    expect(d.querySelector(".payrow .trow-amt").textContent).toBe("$71.00");
    d.querySelector(".payrow .trow").click();
    await settle();
    const lines = [...d.querySelectorAll(".payline")].map((e) => e.textContent);
    expect(lines).toEqual([
      "Hours · 1234 · Gateway$40.00",
      "Per accepted item · 1234 · Gateway$12.00",
      "Bonus · 1234 · Gateway$15.00",
      "Adjustment · 1234 · Gateway$4.00",
    ]);
  }, 30_000);

  it("adds a bonus tied to no task for a payday picked in the form, and lists it there", async () => {
    // Money with no task was never in Upcoming payments. Offered the client's
    // real paydays, the owner picks one and it lands on that very date.
    // An unanswered task on the project, so the Overview has work to show; it
    // is not handed in and has no payday of its own.
    const open = { id: "t1", label: "1234", createdAt: Date.now() - 80 * HOUR };
    const { dom, d } = await openFirst(scheduled({ company: "Northwind", rules: { Northwind: WEEKLY }, tasks: [open] }));
    btn(d, /Add earnings/i).click();
    await settle();
    const form = d.querySelector(".ern-form");
    setValue(dom.window, form.querySelector('input[type="number"]'), "60");
    setValue(dom.window, form.querySelector("select"), "bonus"); // What for
    const when = form.querySelector('select[aria-label="When is it paid?"]');
    // The default says which day it is, a real one.
    expect(when.options[0].textContent).toMatch(/^Next payday — Wed/);
    setValue(dom.window, when, "other");
    await settle();
    const pick = d.querySelector('select[aria-label="Which payday"]');
    expect(pick.options).toHaveLength(6);
    const chosen = pick.options[2].value;
    setValue(dom.window, pick, chosen);
    await settle();
    btn(d, /^Add$/).click();
    await settle();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.earnings).toHaveLength(1);
    expect(saved.earnings[0]).toMatchObject({ cents: 6_000, payday: chosen });
    expect(saved.earnings[0]).not.toHaveProperty("received");

    // Out of the project, back to the tabs.
    d.querySelector(".linkbtn").click();
    await settle();
    await toProjects(d, "Overview");
    const label = new Date(`${chosen}T00:00:00Z`).toLocaleDateString(undefined, {
      timeZone: "UTC", weekday: "short", day: "numeric", month: "long",
    });
    expect(payLabels(d)).toEqual([label]);
    expect(payRows(d)).toEqual(["Northwind · 1 bonus"]);
    d.querySelector(".payrow .trow").click();
    await settle();
    expect([...d.querySelectorAll(".payline")].map((e) => e.textContent)).toEqual(["Bonus · Gateway$60.00"]);
  }, 30_000);

  it("offers no payday on a project whose company has no schedule", async () => {
    const { d } = await openFirst(scheduled({ company: "Northwind", rules: {}, tasks: [] }));
    btn(d, /Add earnings/i).click();
    await settle();
    expect(d.querySelector('select[aria-label="When is it paid?"]')).toBeNull();
  }, 30_000);

  describe("answering a payment", () => {
    const ASKED = { "meter:payouts-asked": "1" };
    const DAY = 24 * HOUR;
    /** One payday well in the past and one still to come, both Northwind's. */
    const withOverdue = (ages = [30]) => {
      const now = Date.now();
      const done = (id, ago) => ({ id, label: id, createdAt: now - 80 * DAY, state: "accepted",
                                  stateAt: now - ago, submittedAt: now - ago - HOUR });
      return scheduled({ company: "Northwind", rules: { Northwind: WEEKLY },
                         tasks: [...ages.map((d, i) => done(`old${i}`, d * DAY)), done("new", HOUR)] });
    };
    const longDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
      timeZone: "UTC", weekday: "short", day: "numeric", month: "long",
    });
    const localIso = (daysAhead) => {
      const t = new Date(Date.now() + daysAhead * DAY);
      const two = (n) => String(n).padStart(2, "0");
      return `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())}`;
    };
    const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    const asking = (d) => [...d.querySelectorAll(".banner")].find((b) => /Past paydays/.test(b.textContent));
    const open = async (d, which = 0) => {
      d.querySelectorAll(".payrow .trow")[which].click();
      await settle();
    };

    it("lists a payday that passed unanswered as overdue, first, with its own total", async () => {
      const d = (await bootDash(withOverdue(), ASKED)).window.document;
      const labels = payLabels(d);
      expect(labels).toHaveLength(2);
      expect(labels[0]).toMatch(/^Overdue · /);
      expect(labels[1]).not.toMatch(/Overdue/);
      const head = [...d.querySelectorAll(".sec-head")].find((h) => /Upcoming payments/.test(h.textContent));
      expect(head.textContent).toMatch(/overdue · .* confirmed/);
    }, 30_000);

    it("marks a payment already paid, and brings it back with Undo", async () => {
      const dom = await bootDash(withOverdue(), ASKED);
      const d = dom.window.document;
      await open(d, 0);
      // An overdue row asks what happened; the form is the one in the open row.
      btn(d.querySelector(".paylist"), /^Paid in full$/).click();
      await settle();
      btn(d.querySelector(".paylist"), /^Save$/).click();
      await settle();
      expect(payLabels(d)).toHaveLength(1);
      expect(stored(dom).payouts).toHaveLength(1);
      expect(stored(dom).payouts[0]).toMatchObject({ outcome: "paid", client: "Northwind", currency: "USD" });
      btn(d.querySelector(".toast"), /^Undo$/).click();
      await settle();
      expect(payLabels(d)).toHaveLength(2);
      expect(payLabels(d)[0]).toMatch(/^Overdue · /);
      // Undone as an edit the other device can see: the answer is tombstoned,
      // not dropped from the list, or a sync would bring it back.
      expect(stored(dom).payouts).toHaveLength(1);
      expect(stored(dom).payouts[0].deletedAt).toEqual(expect.any(Number));
    }, 30_000);

    it("puts an earlier answer back when a later one is undone", async () => {
      const dom = await bootDash(withOverdue(), ASKED);
      const d = dom.window.document;
      // The payment still to come is the second row, after the overdue one.
      await open(d, 1);
      btn(d.querySelector(".paylist"), /^Change date$/).click();
      await settle();
      const target = localIso(12);
      setValue(dom.window, d.querySelector('input[aria-label="New payday"]'), target);
      await settle();
      btn(d.querySelector(".paylist"), /^Save$/).click();
      await settle();
      const moved = stored(dom).payouts[0];
      // Now the moved payment is said to have arrived, and that is undone.
      // A moved payment keeps its key, so it may still be open from the move.
      const at = payLabels(d).indexOf(longDay(target));
      if (!d.querySelectorAll(".payrow .trow")[at].classList.contains("on")) await open(d, at);
      btn(d.querySelector(".paylist"), /^Already paid$/).click();
      await settle();
      btn(d.querySelector(".paylist"), /^Save$/).click();
      await settle();
      expect(stored(dom).payouts[0]).toMatchObject({ id: moved.id, outcome: "paid" });
      btn(d.querySelector(".toast"), /^Undo$/).click();
      await settle();
      expect(stored(dom).payouts).toHaveLength(1);
      expect(stored(dom).payouts[0]).toMatchObject({ id: moved.id, outcome: "moved", movedTo: target, deletedAt: null });
      expect(payLabels(d)).toContain(longDay(target));
    }, 30_000);

    it("moves a payment to another date, says where it came from, and refuses the past", async () => {
      const dom = await bootDash(withOverdue(), ASKED);
      const d = dom.window.document;
      await open(d, 1);
      btn(d, /^Change date$/).click();
      await settle();
      const box = d.querySelector('input[aria-label="New payday"]');
      // Yesterday is refused, and nothing is saved.
      setValue(dom.window, box, localIso(-1));
      await settle();
      expect(btn(d.querySelector(".paylist"), /^Save$/).disabled).toBe(true);
      expect(d.querySelector(".paylist .payact").textContent).toMatch(/today or a later day/i);
      const target = localIso(12);
      setValue(dom.window, box, target);
      await settle();
      btn(d.querySelector(".paylist"), /^Save$/).click();
      await settle();
      expect(stored(dom).payouts[0]).toMatchObject({ outcome: "moved", movedTo: target });
      // The overdue payment is untouched, and this one is listed on its new date.
      expect(payLabels(d).filter((l) => /Overdue/.test(l))).toHaveLength(1);
      expect(payLabels(d)).toContain(longDay(target));
      expect(payRows(d).some((r) => /moved from/.test(r))).toBe(true);
    }, 30_000);

    /** The notice that follows a passed payday, wherever you are in the app. */
    const notice = (d) => [...d.querySelectorAll(".banner")].find((b) => /A payday has passed/.test(b.textContent));
    const answerIn = async (box, choice) => {
      btn(box, new RegExp(`^${choice}$`)).click();
      await settle();
    };
    const earnedCents = (dom) => stored(dom).earnings.filter((e) => !e.deletedAt)
      .reduce((sum, e) => sum + e.cents, 0);

    it("asks what happened to the oldest passed payday, then the next one", async () => {
      const dom = await bootDash(withOverdue([30, 45]), ASKED);
      const d = dom.window.document;
      expect(notice(d).textContent).toMatch(/Northwind.s payday on .* \(\$40\.00\) has passed\. What happened\?/);
      const first = notice(d).textContent;
      await answerIn(notice(d), "Paid in full");
      btn(notice(d), /^Save$/).click();
      await settle();
      expect(stored(dom).payouts).toHaveLength(1);
      // The next oldest, a different date.
      expect(notice(d)).toBeDefined();
      expect(notice(d).textContent).not.toBe(first);
      await answerIn(notice(d), "Paid in full");
      btn(notice(d), /^Save$/).click();
      await settle();
      expect(notice(d)).toBeUndefined();
      expect(stored(dom).payouts).toHaveLength(2);
    }, 30_000);

    it("does not ask while the one-time question about every past payday is waiting", async () => {
      const d = (await bootDash(withOverdue())).window.document;
      expect(asking(d)).toBeDefined();
      expect(notice(d)).toBeUndefined();
    }, 30_000);

    it("records $41 received for an expected $40 as a one dollar adjustment", async () => {
      const dom = await bootDash(withOverdue(), ASKED);
      const d = dom.window.document;
      await answerIn(notice(d), "Paid in full");
      // Found by the name a screen reader gives it, not by its type.
      const box = notice(d).querySelector('input[aria-label="Received (USD)"]');
      expect(box.value).toBe("40");
      setValue(dom.window, box, "41");
      await settle();
      expect(notice(d).textContent).toMatch(/\$1\.00 more than the \$40\.00 expected/);
      const before = earnedCents(dom);
      btn(notice(d), /^Save$/).click();
      await settle();
      const saved = stored(dom);
      expect(saved.payouts[0]).toMatchObject({ outcome: "paid", expectedCents: 4_000, receivedCents: 4_100 });
      const adjust = saved.earnings.find((e) => e.kind === "adjust");
      expect(adjust).toMatchObject({ cents: 100, received: true, currency: "USD" });
      expect(earnedCents(dom)).toBe(before + 100);
      // Undo takes the answer and the dollar back together.
      btn(d.querySelector(".toast"), /^Undo$/).click();
      await settle();
      expect(earnedCents(dom)).toBe(before);
      expect(stored(dom).payouts[0].deletedAt).toEqual(expect.any(Number));
    }, 30_000);

    it("moves the rest of a partly received payment to a new date, showing what is left", async () => {
      const dom = await bootDash(withOverdue(), ASKED);
      const d = dom.window.document;
      await answerIn(notice(d), "Not yet / partly");
      const received = notice(d).querySelector('input[aria-label="Received so far (USD)"]');
      const date = notice(d).querySelector('input[aria-label="New payday"]');
      setValue(dom.window, received, "15");
      const target = localIso(10);
      setValue(dom.window, date, target);
      await settle();
      btn(notice(d), /^Save$/).click();
      await settle();
      expect(stored(dom).payouts[0]).toMatchObject({ outcome: "partial", receivedCents: 1_500, movedTo: target, expectedCents: 4_000 });
      // No money moves until it closes.
      expect(stored(dom).earnings.some((e) => e.kind === "adjust")).toBe(false);
      expect(notice(d)).toBeUndefined();
      expect(payLabels(d)).toContain(longDay(target));
      expect(payRows(d).some((r) => /partly received: \$15\.00 of \$40\.00 · moved from/.test(r))).toBe(true);
      const at = payLabels(d).indexOf(longDay(target));
      expect(d.querySelectorAll(".payrow .trow-amt")[at].textContent).toBe("$25.00");
    }, 30_000);

    it("cancels a payment and takes its money off the earnings", async () => {
      const dom = await bootDash(withOverdue(), ASKED);
      const d = dom.window.document;
      await answerIn(notice(d), "Cancelled");
      expect(notice(d).textContent).toMatch(/\$40\.00 comes off your earnings/);
      const before = earnedCents(dom);
      btn(notice(d), /^Save$/).click();
      await settle();
      expect(stored(dom).payouts[0]).toMatchObject({ outcome: "cancelled", receivedCents: 0 });
      expect(earnedCents(dom)).toBe(before - 4_000);
      expect(payLabels(d).some((l) => /^Overdue/.test(l))).toBe(false);
    }, 30_000);

    it("marks a payment still to come as paid, and records what came", async () => {
      const now = Date.now();
      const seed = scheduled({ company: "Northwind", rules: { Northwind: WEEKLY }, tasks: [
        { id: "new", label: "new", createdAt: now - 80 * DAY, state: "accepted", stateAt: now - HOUR, submittedAt: now - 2 * HOUR },
      ] });
      const dom = await bootDash(seed, ASKED);
      const d = dom.window.document;
      expect(notice(d)).toBeUndefined();
      await open(d, 0);
      btn(d.querySelector(".paylist"), /^Already paid$/).click();
      await settle();
      const box = d.querySelector('.paylist input[type="number"]');
      expect(box.value).toBe("40");
      setValue(dom.window, box, "42");
      await settle();
      btn(d.querySelector(".paylist"), /^Save$/).click();
      await settle();
      expect(stored(dom).payouts[0]).toMatchObject({ outcome: "paid", receivedCents: 4_200 });
      expect(stored(dom).earnings.find((e) => e.kind === "adjust").cents).toBe(200);
      expect(payLabels(d)).toEqual([]);
    }, 30_000);

    it("puts the notice off until tomorrow with Later", async () => {
      const dom = await bootDash(withOverdue(), ASKED);
      const d = dom.window.document;
      btn(notice(d), /^Later$/).click();
      await settle();
      expect(notice(d)).toBeUndefined();
      const day = dom.window.localStorage.getItem("meter:payout-later");
      expect(day).toBe(localIso(0));
      // Still hidden on a reload the same day, shown again on a later one.
      expect(notice((await bootDash(stored(dom), { ...ASKED, "meter:payout-later": day })).window.document)).toBeUndefined();
      expect(notice((await bootDash(stored(dom), { ...ASKED, "meter:payout-later": localIso(-1) })).window.document)).toBeDefined();
    }, 60_000);

    it("asks once about past paydays, and marks them all received in one go", async () => {
      const dom = await bootDash(withOverdue([30, 45]));
      const d = dom.window.document;
      const banner = () => asking(d);
      expect(banner().textContent).toMatch(/2 past paydays have no answer\. Mark them all as received\?/);
      expect(payLabels(d).filter((l) => /^Overdue/.test(l))).toHaveLength(2);
      btn(banner(), /^Mark all received$/).click();
      await settle();
      expect(banner()).toBeUndefined();
      expect(payLabels(d).some((l) => /^Overdue/.test(l))).toBe(false);
      expect(stored(dom).payouts).toHaveLength(2);
      expect(dom.window.localStorage.getItem("meter:payouts-asked")).toBe("1");
      // One Undo gives back both.
      btn(d.querySelector(".toast"), /^Undo$/).click();
      await settle();
      expect(payLabels(d).filter((l) => /^Overdue/.test(l))).toHaveLength(2);
    }, 30_000);

    it("keeps them listed on request, and does not ask again after a reload", async () => {
      const seed = withOverdue();
      const dom = await bootDash(seed);
      const d = dom.window.document;
      btn(d, /^Keep them listed$/).click();
      await settle();
      expect(asking(d)).toBeUndefined();
      expect(payLabels(d)[0]).toMatch(/^Overdue · /);
      const asked = dom.window.localStorage.getItem("meter:payouts-asked");
      const again = (await bootDash(stored(dom), { "meter:payouts-asked": asked })).window.document;
      expect(asking(again)).toBeUndefined();
      expect(payLabels(again)[0]).toMatch(/^Overdue · /);
    }, 60_000);

    describe("single lines of a payment", () => {
      const amounts = (d) => [...d.querySelectorAll(".payrow .trow-amt")].map((e) => e.textContent);
      const pick = async (d, re) => {
        const line = [...d.querySelectorAll(".paylist .payline")].find((l) => re.test(l.textContent));
        line.querySelector("input.row-check").click();
        await settle();
      };
      const picked = (d) => d.querySelector('.paylist [aria-label="Selected lines"]');
      /** Two tasks accepted an hour ago, both on Northwind's next payday. */
      const twoComing = () => {
        const now = Date.now();
        const done = (id) => ({ id, label: id, createdAt: now - 80 * DAY, state: "accepted",
                                stateAt: now - HOUR, submittedAt: now - 2 * HOUR });
        return scheduled({ company: "Northwind", rules: { Northwind: WEEKLY }, tasks: [done("alpha"), done("beta")] });
      };

      it("marks one task's hours paid on a payment still to come, and Undo puts them back", async () => {
        const dom = await bootDash(twoComing(), ASKED);
        const d = dom.window.document;
        expect(amounts(d)).toEqual(["$80.00"]);
        await open(d, 0);
        // A box on every line, and nothing to do until one is ticked.
        expect(d.querySelectorAll(".paylist input.row-check")).toHaveLength(2);
        expect(picked(d)).toBeNull();
        await pick(d, /Hours · alpha/);
        expect(picked(d).textContent).toMatch(/1 selected · \$40\.00/);
        btn(picked(d), /^Mark paid$/).click();
        await settle();
        expect(amounts(d)).toEqual(["$40.00"]);
        expect(d.querySelector(".toast").textContent).toMatch(/1 line marked as paid/);
        const alpha = () => stored(dom).projects[0].tasks.find((t) => t.id === "alpha");
        expect(alpha().hoursReceived).toBe(true);
        // No answer for the payment as a whole: the rest of it is still coming.
        expect(stored(dom).payouts ?? []).toEqual([]);
        btn(d.querySelector(".toast"), /^Undo$/).click();
        await settle();
        expect(amounts(d)).toEqual(["$80.00"]);
        expect(alpha()).not.toHaveProperty("hoursReceived");
      }, 30_000);

      it("moves a line of an overdue payment to a coming day, and refuses the past", async () => {
        const dom = await bootDash(withOverdue(), ASKED);
        const d = dom.window.document;
        expect(payLabels(d)[0]).toMatch(/^Overdue · /);
        await open(d, 0);
        await pick(d, /Hours · old0/);
        btn(picked(d), /^Move…$/).click();
        await settle();
        const date = picked(d).querySelector('input[aria-label="Move selected to"]');
        setValue(dom.window, date, localIso(-3));
        await settle();
        expect(btn(picked(d), /^Move$/).disabled).toBe(true);
        expect(picked(d).textContent).toMatch(/Pick today or a later day/);
        const target = localIso(12);
        setValue(dom.window, date, target);
        await settle();
        btn(picked(d), /^Move$/).click();
        await settle();
        expect(payLabels(d).some((l) => /^Overdue/.test(l))).toBe(false);
        expect(payLabels(d)).toContain(longDay(target));
        expect(stored(dom).projects[0].tasks.find((t) => t.id === "old0").hoursPayday).toBe(target);
      }, 30_000);

      it("will not move lines onto a payday already answered, and keeps them picked", async () => {
        const target = localIso(12);
        const seed = { ...twoComing(), payouts: [{
          id: "done", client: "Northwind", currency: "USD", scheduled: target, outcome: "paid",
          answeredAt: Date.now(), createdAt: Date.now(), deletedAt: null,
        }] };
        const dom = await bootDash(seed, ASKED);
        const d = dom.window.document;
        await open(d, 0);
        await pick(d, /Hours · beta/);
        btn(picked(d), /^Move…$/).click();
        await settle();
        setValue(dom.window, picked(d).querySelector('input[aria-label="Move selected to"]'), target);
        await settle();
        btn(picked(d), /^Move$/).click();
        await settle();
        expect(d.querySelector(".toast").textContent).toMatch(/payment is already answered/);
        expect(stored(dom).projects[0].tasks.find((t) => t.id === "beta")).not.toHaveProperty("hoursPayday");
        expect(amounts(d)).toEqual(["$80.00"]);
        expect(picked(d)).not.toBeNull();
      }, 30_000);

      it("offers no boxes on a payment already partly received", async () => {
        const dom = await bootDash(withOverdue(), ASKED);
        const d = dom.window.document;
        const notice = () => [...d.querySelectorAll(".banner")].find((b) => /A payday has passed/.test(b.textContent));
        btn(notice(), /^Not yet \/ partly$/).click();
        await settle();
        setValue(dom.window, notice().querySelector('input[aria-label="Received so far (USD)"]'), "15");
        setValue(dom.window, notice().querySelector('input[aria-label="New payday"]'), localIso(10));
        await settle();
        btn(notice(), /^Save$/).click();
        await settle();
        const at = payLabels(d).indexOf(longDay(localIso(10)));
        await open(d, at);
        expect(d.querySelectorAll(".paylist input.row-check")).toHaveLength(0);
        expect(d.querySelector(".paylist").textContent).toMatch(/answered as a whole/);
      }, 30_000);
    });
  });

  it("puts one client on one payday row however its name was typed", async () => {
    const now = Date.now();
    const project = (id, name, company) => ({
      id, name, company, currentRate: 40, currency: "USD", createdAt: now - 80 * HOUR,
      sessionGoal: null, overallGoal: null,
      tasks: [{ id: `${id}-t`, label: `${name} task`, createdAt: now - 80 * HOUR,
                state: "accepted", stateAt: now - HOUR, submittedAt: now - 2 * HOUR }],
    });
    const d = (await bootDash(scheduled({
      rules: { Northwind: WEEKLY },
      projects: [project("a", "Gateway", "Northwind"), project("b", "Atlas", "northwind")],
    }))).window.document;
    expect(payRows(d)).toEqual(["Northwind · 2 tasks"]);
  }, 30_000);

  /** The project's Settings, opened. */
  const openSettings = async (seed) => {
    const { dom, d } = await openFirst(seed);
    btn(d, /^Open$/).click();
    await settle();
    return { dom, d };
  };
  /** The box or select under a field's label. */
  const control = (d, label) => [...d.querySelectorAll(".field")]
    .find((f) => new RegExp(`^${label}$`, "i").test(f.querySelector(".eyebrow")?.textContent ?? ""))
    ?.querySelector("input, select");
  const ruleOf = (dom, name) => (stored(dom).companies ?? [])
    .find((c) => c.name.toLowerCase() === name.toLowerCase())?.payPeriod;
  const save = async (d) => {
    btn(d, /Save changes/).click();
    await settle();
  };
  const MONDAY_WEDNESDAY = { kind: "weekly", cutoff: 1, payday: 3, after: 0, closesAt: 0, zone: null };
  const MONDAY_FRIDAY = { ...MONDAY_WEDNESDAY, payday: 5 };
  const acceptedTask = () => {
    const now = Date.now();
    return { id: "t1", label: "1234", createdAt: now - 80 * HOUR,
             state: "accepted", stateAt: now - HOUR, submittedAt: now - 2 * HOUR };
  };

  it("files the schedule under the new company when the company is renamed in the same Save", async () => {
    // Renaming Northwind to Outlier and moving the cutoff wrote the cutoff to
    // Northwind; Outlier had no schedule and the project's paydays vanished.
    const { dom, d } = await openSettings(scheduled({
      company: "Northwind", rules: { Northwind: MONDAY_WEDNESDAY }, tasks: [acceptedTask()],
    }));
    setValue(dom.window, control(d, "Company"), "Outlier");
    setValue(dom.window, control(d, "Closing at"), "19:00");
    await settle();
    await save(d);

    expect(stored(dom).projects[0].company).toBe("Outlier");
    expect(ruleOf(dom, "Outlier")).toMatchObject({ kind: "weekly", payday: 3, closesAt: 19 * 60 });
    // Northwind keeps its own, for whatever other projects it has.
    expect(ruleOf(dom, "Northwind")).toEqual(MONDAY_WEDNESDAY);
    btn(d, /All projects/).click();
    await settle();
    await toProjects(d, "Overview");
    expect(payRows(d)).toEqual(["Outlier · 1 task"]);
  }, 30_000);

  it("says so before replacing another company's schedule, and can take that one instead", async () => {
    const { dom, d } = await openSettings(scheduled({
      company: "Northwind", rules: { Northwind: MONDAY_WEDNESDAY, Outlier: MONDAY_FRIDAY },
      tasks: [acceptedTask()],
    }));
    const warned = () => /Outlier already has a payday of its own/.test(d.querySelector(".wrap").textContent);
    setValue(dom.window, control(d, "Company"), "Outlier");
    await settle();
    // Untouched, the payday follows the company named: joining Outlier means
    // Outlier's Friday, and there is nothing to warn about.
    expect(control(d, "Is paid on").value).toBe("5");
    expect(warned()).toBe(false);

    setValue(dom.window, control(d, "Is paid on"), "4");
    await settle();
    expect(warned()).toBe(true);
    btn(d, /Use Outlier's instead/).click();
    await settle();
    expect(control(d, "Is paid on").value).toBe("5");
    expect(warned()).toBe(false);

    await save(d);
    expect(ruleOf(dom, "Outlier")).toEqual(MONDAY_FRIDAY);
    expect(ruleOf(dom, "Northwind")).toEqual(MONDAY_WEDNESDAY);
  }, 30_000);

  it("lets a project join a company without clearing the company's schedule", async () => {
    const { dom, d } = await openSettings(scheduled({
      company: "", rules: { Outlier: MONDAY_FRIDAY }, tasks: [acceptedTask()],
    }));
    setValue(dom.window, control(d, "Company"), "outlier");
    await settle();
    await save(d);
    expect(stored(dom).projects[0].company).toBe("outlier");
    expect(ruleOf(dom, "Outlier").payday).toBe(5);
  }, 30_000);

  it("keeps a client's clock this browser does not know, and says so", async () => {
    // It was dropped silently: the box read "Mine" and the next Save erased it.
    const mars = { ...MONDAY_WEDNESDAY, closesAt: 19 * 60, zone: "Mars/Olympus_Mons" };
    const { dom, d } = await openSettings(scheduled({
      company: "Northwind", rules: { Northwind: mars }, tasks: [acceptedTask()],
    }));
    expect(d.querySelector(".wrap").textContent)
      .toMatch(/Mars\/Olympus_Mons isn't known to this browser, so paydays are worked out on this device's clock until it is/);
    expect(control(d, "By which clock").value).toBe("Mars/Olympus_Mons");

    setValue(dom.window, control(d, "Project name"), "Gateway 2");
    await settle();
    await save(d);
    expect(ruleOf(dom, "Northwind").zone).toBe("Mars/Olympus_Mons");

    // Picking another clock is what changes it.
    setValue(dom.window, control(d, "By which clock"), "UTC");
    await settle();
    await save(d);
    expect(ruleOf(dom, "Northwind").zone).toBe("UTC");
  }, 30_000);

  it("no longer says handing work in settles it, that money follows the hand-in, or that pausing stops the meter", async () => {
    // Paid as worked: the hours count once handed in, a rejection still takes
    // them back, and the payday follows the hand-in, with no answer to wait for.
    const { d } = await openFirst(scheduled({
      company: "Northwind", rules: { Northwind: MONDAY_WEDNESDAY },
      tasks: [{ id: "t1", label: "1234", createdAt: Date.now() - 80 * HOUR }],
    }));
    const page = () => d.querySelector(".wrap").textContent;
    await tick(d, "1234");
    expect(page()).not.toMatch(/settles the hourly money/);
    expect(page()).toMatch(/unless the answer is a rejection, which cancels them/);
    await press(d, /^Submit 1$/);
    expect(d.querySelector(".toast").textContent).not.toMatch(/settled/);
    expect(d.querySelector(".toast").textContent).toMatch(/count as earned, unless it is rejected/);

    btn(d, /^Open$/).click();
    await settle();
    expect(page()).toMatch(/Work handed in right now would be paid on/);
    expect(page()).toMatch(/paid in the run for the period it was handed in, answered or not/);
    expect(page()).not.toMatch(/accepted right now/);
    expect(page()).toMatch(/a meter already running keeps going until you stop it/);
    expect(page()).not.toMatch(/stop the meter/);
  }, 30_000);

  it("keeps a kept draft's payday when a company is typed after the panel reopens", async () => {
    // Settings keeps an unsaved draft while the panel is closed. Reopened, its
    // changed payday boxes counted as untouched, so naming a company put the
    // saved schedule back over them.
    const { dom, d } = await openSettings(scheduled({
      company: "Northwind", rules: { Northwind: MONDAY_WEDNESDAY }, tasks: [acceptedTask()],
    }));
    setValue(dom.window, control(d, "Is paid on"), "4");
    await settle();
    btn(d, /^Close$/).click();
    await settle();
    btn(d, /^Open$/).click();
    await settle();
    expect(control(d, "Is paid on").value).toBe("4");

    setValue(dom.window, control(d, "Company"), "Outlier");
    await settle();
    expect(control(d, "Is paid on").value).toBe("4");
    await save(d);
    expect(ruleOf(dom, "Outlier")).toMatchObject({ kind: "weekly", payday: 4 });
  }, 30_000);

  it("dates handed-in work on a project paid as worked, with nothing waiting", async () => {
    // Paid as worked, there is no answer to wait for: the week it went in pays it.
    const now = Date.now();
    const d = (await bootDash(scheduled({
      company: "Northwind", rules: { Northwind: WEEKLY },
      tasks: [{ id: "t1", label: "1234", createdAt: now - 80 * HOUR,
                state: "submitted", stateAt: now - HOUR, submittedAt: now - HOUR }],
    }))).window.document;
    expect(payLabels(d)).toHaveLength(1);
    expect(payLabels(d)[0]).not.toMatch(/Not before/);
    expect(payRows(d)).toEqual(["Northwind · 1 task"]);
  }, 30_000);

  it("says a task accepted now would be paid then, on a project paid once accepted", async () => {
    const now = Date.now();
    const { d } = await openFirst(scheduled({
      company: "Northwind", rules: { Northwind: MONDAY_WEDNESDAY },
      projects: [{ id: "a", name: "Gateway", company: "Northwind", currentRate: 40, currency: "USD",
        paysOnAcceptance: true, createdAt: now - 80 * HOUR, sessionGoal: null, overallGoal: null,
        tasks: [] }],
    }));
    btn(d, /^Open$/).click();
    await settle();
    const page = d.querySelector(".wrap").textContent;
    expect(page).toMatch(/A task accepted right now would be paid on/);
    expect(page).toMatch(/paid in the run for the period its answer fell in/);
  }, 30_000);
});

describe("the Overview's tiles", () => {
  it("lets a comparison wrap inside its tile rather than run past the edge", () => {
    // "vs this point last year" is longer than a quarter of the row, and kept
    // on one line it ran up to 63px out of the Billed and Idle tiles. Only a
    // real browser can measure that, and one did; pinned here is the rule.
    const css = readFileSync(DIST, "utf8");
    expect(css).toMatch(/\.tile-sub \.delta\{white-space:normal;\}/);
  });
});

describe("a pair of date-and-time boxes on a phone", () => {
  it("stacks them rather than let the second run off the screen", () => {
    // A datetime-local box will not shrink below its full reading, and two
    // side by side are wider than a phone: at 375px the second ran out to
    // 517px and the whole page scrolled sideways with it. Measured in a real
    // browser on the task, session and add-time forms; pinned here is the rule.
    const css = readFileSync(DIST, "utf8");
    expect(css).toMatch(
      /@media \(max-width:420px\)\{\s*\.pair:has\(input\[type="datetime-local"\]\)\{flex-direction:column;gap:0;\}/);
  });
});

describe("the to-do list on Today", () => {
  const HOUR = 3_600_000;
  const seed = () => {
    const now = Date.now();
    const todo = (id, text, at, extra = {}) => ({
      id, text, projectId: null, done: false, doneAt: null, createdAt: now - at * HOUR, deletedAt: null, ...extra });
    return {
      projects: [
        { id: "a", name: "Gateway", currentRate: 60, currency: "USD", createdAt: now - 80 * HOUR,
          sessionGoal: null, overallGoal: null, tasks: [] },
        { id: "z", name: "Shelved", currentRate: 60, currency: "USD", createdAt: now - 80 * HOUR,
          sessionGoal: null, overallGoal: null, tasks: [], status: "paused", statusAt: now - HOUR },
        { id: "gone", name: "Removed", currentRate: 60, currency: "USD", createdAt: now - 80 * HOUR,
          sessionGoal: null, overallGoal: null, tasks: [], deletedAt: now - HOUR },
      ],
      sessions: [],
      earnings: [],
      todos: [
        todo("d1", "Renew the domain", 5),
        todo("d2", "Finish the review", 4, { projectId: "a" }),
        todo("d3", "Plan the quarter", 3, { projectId: "z" }),
        todo("d4", "Old client call", 2, { projectId: "gone" }),
        todo("d5", "Call the bank", 6, { done: true, doneAt: now - HOUR }),
      ],
    };
  };
  const open = async () => {
    const dom = await boot(seed());
    await settle();
    return { dom, d: dom.window.document, saved: () => JSON.parse(dom.window.localStorage.getItem("meter:v1")) };
  };
  const rowOf = (d, text) => [...d.querySelectorAll(".todo")].find((r) => r.textContent.includes(text));

  it("comes first on Today, with what is left in the order it was written", async () => {
    const { d } = await open();
    const heads = [...d.querySelectorAll(".sec-head")].map((h) => h.textContent);
    expect(heads[0]).toBe("To do4 left");
    expect(heads.findIndex((h) => /^Today/.test(h))).toBeGreaterThan(0);
    expect([...d.querySelectorAll(".todos > .todo .obj-text")].map((e) => e.textContent))
      .toEqual(["Renew the domain", "Finish the review", "Plan the quarter", "Old client call"]);
  }, 20_000);

  it("adds a to-do and keeps the form open for the next one", async () => {
    const { dom, d, saved } = await open();
    btn(d, /^\+ Add a to-do$/).click();
    await settle();
    const box = d.querySelector(".todos .obj-form input");
    setValue(dom.window, box, "  Pay the rent  ");
    setValue(dom.window, d.querySelector(".todos .obj-form select"), "a");
    btn(d, /^Add$/).click();
    await settle();
    const added = saved().todos.find((t) => t.text === "Pay the rent");
    expect(added).toMatchObject({ projectId: "a", done: false, deletedAt: null });
    expect(d.querySelector(".todos .obj-form input").value).toBe("");
    expect(rowOf(d, "Pay the rent")).toBeTruthy();
  }, 20_000);

  it("folds a ticked to-do under Done, where it can be unticked", async () => {
    const { d, saved } = await open();
    rowOf(d, "Renew the domain").querySelector("input[type=checkbox]").click();
    await settle();
    expect(saved().todos.find((t) => t.id === "d1").done).toBe(true);
    expect(d.querySelector(".todos > .todo .obj-text")?.textContent).not.toBe("Renew the domain");
    const fold = btn(d, /Done · 2/);
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fold.click();
    await settle();
    // The latest finished first.
    expect([...d.querySelectorAll(".todo-done .obj-text")].map((e) => e.textContent))
      .toEqual(["Renew the domain", "Call the bank"]);
    d.querySelector(".todo-done input[aria-label='Mark Renew the domain not done']").click();
    await settle();
    expect(saved().todos.find((t) => t.id === "d1")).toMatchObject({ done: false, doneAt: null });
  }, 20_000);

  it("clears what is done, and Undo puts it back", async () => {
    const { d, saved } = await open();
    btn(d, /Done · 1/).click();
    await settle();
    btn(d, /^Clear done$/).click();
    await settle();
    expect(saved().todos.find((t) => t.id === "d5").deletedAt).toBeTruthy();
    expect(d.querySelector(".todo-done")).toBeNull();
    btn(d, /^Undo$/).click();
    await settle();
    expect(saved().todos.find((t) => t.id === "d5").deletedAt).toBeNull();
  }, 20_000);

  it("starts a linked project's meter, and offers no start a project cannot take", async () => {
    const { d, saved } = await open();
    // Not on a paused project, which takes no time; and a removed project
    // leaves its to-do unlinked rather than taking it away.
    expect(rowOf(d, "Plan the quarter").querySelector(".todo-go")).toBeNull();
    expect(rowOf(d, "Plan the quarter").textContent).toMatch(/Shelved/);
    expect(rowOf(d, "Old client call").querySelector(".obj-meta")).toBeNull();
    expect(rowOf(d, "Old client call").querySelector(".todo-go")).toBeNull();
    rowOf(d, "Finish the review").querySelector(".todo-go").click();
    await settle();
    const live = saved().sessions.find((s) => s.segments.some((g) => g.endedAt == null));
    expect(live).toMatchObject({ projectId: "a", taskId: null, kind: "billed" });
  }, 20_000);

  it("puts its starts away while a meter is going", async () => {
    // A start closes whatever is open, so beside a running meter it is a
    // one-click way to end it.
    const { d } = await open();
    rowOf(d, "Finish the review").querySelector(".todo-go").click();
    await settle();
    // Starting opens the project; back out of it to Today.
    btn(d, /All projects/).click();
    await settle();
    await toProjects(d, "Today");
    expect(d.querySelectorAll(".todo").length).toBe(4);
    expect(d.querySelector(".todo-go")).toBeNull();
  }, 20_000);

  it("edits from the to-do as it is, and removes with an Undo", async () => {
    const { dom, d, saved } = await open();
    [...rowOf(d, "Renew the domain").querySelectorAll("button")].find((b) => b.textContent === "edit").click();
    await settle();
    const box = d.querySelector(".todos .obj-form input");
    expect(box.value).toBe("Renew the domain");
    setValue(dom.window, box, "Renew both domains");
    btn(d, /^Save$/).click();
    await settle();
    expect(saved().todos.find((t) => t.id === "d1").text).toBe("Renew both domains");

    rowOf(d, "Renew both domains").querySelector("button[aria-label='Remove Renew both domains']").click();
    await settle();
    expect(saved().todos.find((t) => t.id === "d1").deletedAt).toBeTruthy();
    btn(d, /^Undo$/).click();
    await settle();
    expect(saved().todos.find((t) => t.id === "d1").deletedAt).toBeNull();
  }, 20_000);
});

describe("a time limit per task", () => {
  const H = 3_600_000;
  const M = 60_000;
  // Two days back at nine, so nothing here is today and nothing crosses midnight.
  const base = () => {
    const d = new Date();
    d.setDate(d.getDate() - 2);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  const seed = ({ handedIn = false } = {}) => {
    const t0 = base();
    const sit = (id, taskId, from, ms) => ({
      id, projectId: "g", kind: "billed", taskId, rate: 20, currency: "USD",
      createdAt: from, closedAt: from + ms, deletedAt: null, segments: [{ startedAt: from, endedAt: from + ms }],
    });
    return {
      projects: [{
        id: "g", name: "Gateway", currentRate: 20, currency: "USD", createdAt: t0 - 100 * H,
        sessionGoal: null, overallGoal: null,
        taskLimits: [{ from: null, ms: 2 * H, factor: 0.3 }],
        tasks: [
          { id: "t1", label: "T-1", createdAt: t0,
            ...(handedIn ? { state: "submitted", submittedAt: t0 + 5 * H, stateAt: t0 + 5 * H } : {}) },
          { id: "t2", label: "T-2", createdAt: t0 },
        ],
      }],
      // T-1: 1h 30m, then 1h 10m: 2h 40m, of which 40m is over the 2h limit.
      sessions: [sit("a", "t1", t0, 90 * M), sit("b", "t1", t0 + 2 * H, 70 * M), sit("c", "t2", t0 + 6 * H, 60 * M)],
      earnings: [],
    };
  };
  const open = async (opts) => {
    const dom = await boot(seed(opts));
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    return { dom, d, saved: () => JSON.parse(dom.window.localStorage.getItem("meter:v1")) };
  };
  const row = (d, name) => [...d.querySelectorAll(".trow")].find((r) => r.textContent.startsWith(name));
  const input = (d, label) => [...d.querySelectorAll(".field")]
    .find((f) => new RegExp(label).test(f.querySelector(".eyebrow")?.textContent ?? ""))?.querySelector("input");

  it("pays the time over the limit at its share, and says so on the task", async () => {
    // $40 for two hours, and forty minutes at 30% of $20 an hour: $44, not $53.33.
    const { d } = await open();
    expect(row(d, "T-1").querySelector(".trow-amt").textContent).toBe("$44.00");
    expect(row(d, "T-1").textContent).toMatch(/2h 00m in full \+ 40m over the limit at 30%/);
    expect(row(d, "T-2").querySelector(".trow-amt").textContent).toBe("$20.00");
    // The sitting that crossed the line says what part of it was over.
    expect([...d.querySelectorAll(".row")].some((r) => /40m over the limit at 30%/.test(r.textContent))).toBe(true);
  }, 20_000);

  it("agrees with the Overview about what the time came to", async () => {
    const { d } = await open();
    btn(d, /All projects/).click();
    await settle();
    await toProjects(d, "Overview");
    [...d.querySelectorAll(".dash-head .segmented .seg")].find((b) => b.textContent === "All").click();
    await settle();
    expect(d.querySelector(".grand-amt").textContent).toBe("$64.00");
  }, 20_000);

  it("shows the limit in Settings and asks how far a change reaches", async () => {
    const { dom, d } = await open();
    btn(d, /^Open$/).click();
    await settle();
    expect(input(d, "^Time limit per task").value).toBe("2");
    expect(input(d, "^Time over it pays").value).toBe("30");
    expect(d.querySelector("[aria-label='How far the change reaches']")).toBeNull();
    setValue(dom.window, input(d, "^Time limit per task"), "3");
    await settle();
    const tabs = [...d.querySelectorAll("[aria-label='How far the change reaches'] button")];
    expect(tabs.map((b) => b.textContent)).toEqual(["From now on", "Past included"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  }, 20_000);

  it("from now on, leaves a task already handed in on its old limit", async () => {
    const { dom, d, saved } = await open({ handedIn: true });
    btn(d, /^Open$/).click();
    await settle();
    setValue(dom.window, input(d, "^Time limit per task"), "3");
    await settle();
    btn(d, /^Save changes$/).click();
    await settle();
    expect(saved().projects[0].taskLimits).toHaveLength(2);
    expect(row(d, "T-1").querySelector(".trow-amt").textContent).toBe("$44.00");
  }, 20_000);

  it("with the past included, reprices a task already handed in, and Undo puts it back", async () => {
    const { dom, d, saved } = await open({ handedIn: true });
    btn(d, /^Open$/).click();
    await settle();
    setValue(dom.window, input(d, "^Time limit per task"), "3");
    await settle();
    btn(d, /^Past included$/).click();
    await settle();
    btn(d, /^Save changes$/).click();
    await settle();
    expect(saved().projects[0].taskLimits).toEqual([{ from: null, ms: 3 * H, factor: 0.3 }]);
    expect(row(d, "T-1").querySelector(".trow-amt").textContent).toBe("$53.33");
    btn(d, /^Undo$/).click();
    await settle();
    expect(row(d, "T-1").querySelector(".trow-amt").textContent).toBe("$44.00");
    // The panel follows the ledger back rather than calling the undone limit saved.
    expect(input(d, "^Time limit per task").value).toBe("2");
  }, 20_000);

  it("from now on, moves an open task to a new rate and keeps a handed-in one on its old", async () => {
    const { dom, d, saved } = await open({ handedIn: true });
    btn(d, /^Open$/).click();
    await settle();
    setValue(dom.window, input(d, "^Hourly rate"), "25");
    await settle();
    btn(d, /^Save changes$/).click();
    await settle();
    const rates = Object.fromEntries(saved().sessions.map((s) => [s.id, s.rate]));
    expect(rates).toEqual({ a: 20, b: 20, c: 25 });
    expect(saved().projects[0].currentRate).toBe(25);
  }, 20_000);

  it("lets one task carry its own limit", async () => {
    const { dom, d, saved } = await open();
    [...row(d, "T-2").querySelectorAll("button")].find((b) => b.textContent === "edit").click();
    await settle();
    const own = input(d, "^Time limit [(]hours[)]$");
    expect(own.placeholder).toBe("empty = 2h, the project's");
    setValue(dom.window, own, "0.5");
    await settle();
    btn(d, /^Save$/).click();
    await settle();
    expect(saved().projects[0].tasks.find((t) => t.id === "t2").limitMs).toBe(30 * M);
    // Half an hour in full, half an hour at $6: $13.
    expect(row(d, "T-2").querySelector(".trow-amt").textContent).toBe("$13.00");
  }, 20_000);
});
