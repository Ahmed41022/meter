/**
 * Integration tests against the BUILT artifact, not the source. These catch
 * things unit tests structurally cannot: bundling mistakes, event wiring,
 * and CSS that silently fails (an inline element ignoring margin-top, say).
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { settle, boot, btn, toProjects, setValue, guardBuiltApp } from "./app.integration.helpers.js";

guardBuiltApp();

describe("settling a batch of tasks", () => {
  const HOUR = 3_600_000;
  const now = Date.now();
  /** $80 an hour AND $10 more when the item is accepted — the shape where
   *  hourly figures stay and acceptance is a separate, later fact. */
  const seed = {
    projects: [{
      id: "a", name: "Gateway", currentRate: 80, perTask: 10, currency: "USD",
      createdAt: now - 30 * HOUR, sessionGoal: null, overallGoal: null,
      tasks: [
        { id: "t1", label: "1234", createdAt: now - 30 * HOUR },
        { id: "t2", label: "1235", createdAt: now - 30 * HOUR },
      ],
    }],
    sessions: [1, 2].map((n) => ({
      id: `s${n}`, projectId: "a", kind: "billed", taskId: `t${n}`, rate: 80, currency: "USD",
      createdAt: now - (n + 1) * HOUR, closedAt: now - n * HOUR, deletedAt: null,
      segments: [{ startedAt: now - (n + 1) * HOUR, endedAt: now - n * HOUR }],
    })),
    earnings: [],
  };
  const open = async () => {
    const dom = await boot(seed);
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    return { dom, d };
  };
  const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
  const taskRows = (d) => [...d.querySelectorAll(".trow")];

  it("says a task has not been claimed, which is not the same as worth nothing", async () => {
    const { d } = await open();
    expect(taskRows(d).every((r) => /not claimed/.test(r.textContent))).toBe(true);
  }, 30_000);

  it("submits every selected task at its own price, pending", async () => {
    const { dom, d } = await open();
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^Submit 2$/).click();
    await settle();

    const { earnings } = stored(dom);
    expect(earnings).toHaveLength(2);
    expect(earnings.map((e) => e.cents)).toEqual([1_000, 1_000]);
    expect(earnings.map((e) => e.taskIds)).toEqual([["t1"], ["t2"]]);
    expect(earnings.every((e) => e.status === "pending")).toBe(true);
  }, 30_000);

  it("then answers the whole batch in one go", async () => {
    // Submitted and accepted are two different days: the first says the work
    // is in, the second that it was taken.
    const { dom, d } = await open();
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^Submit 2$/).click();
    await settle();
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^Accepted 2$/).click();
    await settle();

    expect(stored(dom).earnings.every((e) => e.status === undefined)).toBe(true);
    expect(stored(dom).projects[0].tasks.map((t) => t.state))
      .toEqual(["accepted", "accepted"]);
  }, 30_000);

  const stamp = (epoch) => {
    const p = (n) => String(n).padStart(2, "0");
    const x = new Date(epoch);
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
  };
  /** Yesterday at a wall-clock hour, built from calendar fields so a
   *  daylight-saving night cannot move it. */
  const yesterdayAt = (h, m) => {
    const x = new Date(now);
    x.setDate(x.getDate() - 1);
    x.setHours(h, m, 0, 0);
    return x.getTime();
  };

  it("records the minute an answer came back, not only its day", async () => {
    // A cutoff shuts at an hour — Sunday 19:00 in New York is 02:00 Monday in
    // Cairo — so an answer at 01:30 and one at noon the same day can fall in
    // different pay periods. A day alone could never tell them apart.
    const { dom, d } = await open();
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^Submit 2$/).click();
    await settle();
    btn(d, /^Select all 2$/).click();
    await settle();

    const when = d.querySelector(".selbar-when input");
    expect(when.type).toBe("datetime-local");
    const at = yesterdayAt(1, 30);
    setValue(dom.window, when, stamp(at));
    await settle();
    btn(d, /^Accepted 2$/).click();
    await settle();

    expect(stored(dom).projects[0].tasks.map((t) => t.stateAt)).toEqual([at, at]);
  }, 30_000);

  it("lets the time of an answer be corrected afterwards, to the minute", async () => {
    const { dom, d } = await open();
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^Submit 2$/).click();
    await settle();
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^Accepted 2$/).click();
    await settle();

    const row = taskRows(d).find((r) => r.textContent.includes("1234"));
    [...row.querySelectorAll("button")].find((b) => b.textContent === "edit").click();
    await settle();
    const [, back] = d.querySelectorAll('.prompt input[type="datetime-local"]');
    const late = yesterdayAt(23, 45);
    setValue(dom.window, back, stamp(late));
    btn(d, /^Save$/i).click();
    await settle();

    const [t1, t2] = stored(dom).projects[0].tasks;
    expect(t1.stateAt).toBe(late);
    expect(t2.stateAt).not.toBe(late); // only the task that was edited
  }, 30_000);

  it("covers a batch with one reward, without splitting it between them", async () => {
    // Fifty tasks paid by one milestone are each paid for, and none of them is
    // worth a fiftieth of it — that price was never quoted.
    const { dom, d } = await open();
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^One reward$/).click();
    await settle();
    const amount = [...d.querySelectorAll(".panel input[type=number]")].at(-1);
    setValue(dom.window, amount, "100");
    await settle();
    btn(d, /Record for 2 tasks/).click();
    await settle();

    const { earnings } = stored(dom);
    expect(earnings).toHaveLength(1);
    expect(earnings[0]).toMatchObject({ cents: 10_000, units: 2, taskIds: ["t1", "t2"] });
    // Each task reads as covered, and neither is given a figure of its own.
    const rows = taskRows(d).map((r) => r.textContent);
    expect(rows.every((t) => /in 1 shared reward/.test(t))).toBe(true);
    expect(rows.every((t) => !/not claimed/.test(t))).toBe(true);
  }, 30_000);

  it("names the task on the money, once it has one", async () => {
    const { d } = await open();
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^Submit 2$/).click();
    await settle();
    const meta = [...d.querySelectorAll(".ern-meta")].map((e) => e.textContent);
    expect(meta.some((t) => /1234/.test(t))).toBe(true);
    expect(meta.some((t) => /1235/.test(t))).toBe(true);
  }, 30_000);
});

describe("a meter running on the other device", () => {
  const HOUR = 3_600_000;
  /** Started elsewhere two hours ago. Its heartbeat is deliberately local, so
   *  from here it will always look stale however recently the other machine
   *  ticked it. */
  const elsewhere = () => {
    const now = Date.now();
    return {
      projects: [{ id: "p1", name: "Overnight", currentRate: 450, currency: "EGP",
                   createdAt: now - 2 * HOUR, sessionGoal: null, overallGoal: null }],
      sessions: [{ id: "s1", projectId: "p1", kind: "billed", rate: 450, currency: "EGP",
                   createdAt: now - 2 * HOUR, device: "some-other-machine",
                   segments: [{ startedAt: now - 2 * HOUR, endedAt: null, lastTick: now - 2 * HOUR }],
                   closedAt: null, deletedAt: null }],
    };
  };

  const recovery = (d) => [...d.querySelectorAll(".banner")]
    .find((b) => /Meter left running/.test(b.textContent)) ?? null;

  it("is not offered back as a crash", async () => {
    // Offering to close it at its last tick would cut two hours off work that
    // is still being done on the other machine.
    const d = (await boot(elsewhere())).window.document;
    await settle();
    expect(recovery(d)).toBeNull();
  }, 20_000);

  it("shows in the running bar, and says it is not here", async () => {
    const d = (await boot(elsewhere())).window.document;
    await settle();
    const bar = d.querySelector(".runbar");
    expect(bar).not.toBeNull();
    expect(bar.textContent).toMatch(/Overnight/);
    expect(bar.textContent).toMatch(/elsewhere/);
  }, 20_000);

  it("stops from here, and the stop is a real edit that will travel", async () => {
    const dom = await boot(elsewhere());
    const d = dom.window.document;
    await settle();
    const before = Date.now();
    btn(d, /^Stop$/).click();
    await settle();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1")).sessions[0];
    expect(saved.closedAt).not.toBeNull();
    expect(saved.segments[0].endedAt).not.toBeNull();
    // Stamped, unlike a heartbeat — that stamp is what wins the merge on the
    // machine that is still counting.
    expect(saved.updatedAt).toBeGreaterThanOrEqual(before);
  }, 20_000);

  it("still recovers a crash of its own", async () => {
    // The change must not have bought cross-device stopping by disabling
    // recovery: a stale session THIS device opened is still a crash.
    const now = Date.now();
    const seed = elsewhere();
    seed.sessions[0].device = undefined;
    delete seed.sessions[0].device;
    const d = (await boot(seed)).window.document;
    await settle();
    expect(recovery(d)).not.toBeNull();
    expect(recovery(d).textContent).toMatch(/Overnight/);
    expect(now).toBeGreaterThan(0);
  }, 20_000);
});

describe("settings wait for Save", () => {
  const HOUR = 3_600_000;
  const seed = () => ({
    projects: [{
      id: "a", name: "Gateway", currentRate: 80, currency: "USD",
      createdAt: Date.now() - 30 * HOUR, sessionGoal: null, overallGoal: null, tasks: [],
    }],
    sessions: [],
  });
  const openSettings = async () => {
    const dom = await boot(seed());
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    btn(d, /^Open$/).click();
    await settle();
    return { dom, d };
  };
  const field = (d, label) => [...d.querySelectorAll(".field")]
    .find((f) => new RegExp(label, "i").test(f.querySelector(".eyebrow")?.textContent ?? ""))
    ?.querySelector("input");
  const rateOf = (dom) =>
    JSON.parse(dom.window.localStorage.getItem("meter:v1")).projects[0].currentRate;

  it("does not write a half-typed rate the moment focus leaves the box", async () => {
    // A "4" on the way to "45" used to be the project's real rate for as long
    // as it took to tab away and notice.
    const { dom, d } = await openSettings();
    setValue(dom.window, field(d, "Hourly rate"), "4");
    field(d, "Hourly rate").blur();
    await settle();
    expect(rateOf(dom)).toBe(80);
  }, 30_000);

  it("says so, and writes it when asked", async () => {
    const { dom, d } = await openSettings();
    setValue(dom.window, field(d, "Hourly rate"), "45");
    await settle();
    expect(d.querySelector(".savebar").textContent).toMatch(/Unsaved changes/);
    btn(d, /Save changes/).click();
    await settle();
    expect(rateOf(dom)).toBe(45);
    expect(d.querySelector(".savebar").textContent).toMatch(/^Saved$/);
  }, 30_000);

  it("puts everything back when discarded, and writes nothing", async () => {
    const { dom, d } = await openSettings();
    setValue(dom.window, field(d, "Project name"), "Something else");
    await settle();
    btn(d, /^Discard$/).click();
    await settle();
    expect(field(d, "Project name").value).toBe("Gateway");
    expect(JSON.parse(dom.window.localStorage.getItem("meter:v1")).projects[0].name)
      .toBe("Gateway");
  }, 30_000);
});

describe("a note on a task", () => {
  it("is asked for when the task is made, and kept where it is listed", async () => {
    const dom = await boot({
      projects: [{
        id: "a", name: "Gateway", currentRate: 80, currency: "USD",
        createdAt: Date.now() - 3_600_000, sessionGoal: null, overallGoal: null, tasks: [],
      }],
      sessions: [],
    });
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();

    btn(d, /Start the meter/i).click();
    await settle();
    const fields = [...d.querySelectorAll(".prompt .field")];
    const input = (label) => fields
      .find((f) => new RegExp(label, "i").test(f.querySelector(".eyebrow")?.textContent ?? ""))
      ?.querySelector("input, textarea");
    setValue(dom.window, input("Name it"), "1234");
    setValue(dom.window, input("^Note$"), "QA-88, rerun weekly");
    await settle();
    btn(d, /^Start the meter$/).click();
    await settle();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.projects[0].tasks[0]).toMatchObject({ label: "1234", note: "QA-88, rerun weekly" });
    // And it is on screen where the task is, not only in storage.
    expect(d.querySelector(".wrap").textContent).toMatch(/QA-88, rerun weekly/);
  }, 30_000);
});

describe("the Today tab", () => {
  const HOUR = 3_600_000;
  const seed = () => {
    const now = Date.now();
    // Inside today and inside the day before yesterday, whatever the hour. A
    // sitting that crosses midnight is listed under both of its days, so one
    // timed back from now would turn these two days into three or four in
    // the small hours.
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    const today = (share) => midnight + (now - midnight) * share;
    const before = new Date(now);
    before.setDate(before.getDate() - 2);
    before.setHours(9, 0, 0, 0);
    const back = before.getTime();
    return {
      projects: [
        { id: "a", name: "Gateway", currentRate: 60, currency: "USD", createdAt: now - 80 * HOUR,
          sessionGoal: null, overallGoal: null, tasks: [{ id: "t1", label: "1234" }] },
        { id: "b", name: "Atlas", currentRate: 40, currency: "USD", createdAt: now - 80 * HOUR,
          sessionGoal: null, overallGoal: null, tasks: [] },
      ],
      sessions: [
        // Today, and two days back — so the list has more than one day in it.
        { id: "s1", projectId: "a", kind: "billed", taskId: "t1", rate: 60, currency: "USD",
          createdAt: today(0.25), closedAt: today(0.5), deletedAt: null,
          segments: [{ startedAt: today(0.25), endedAt: today(0.5) }] },
        { id: "s2", projectId: "b", kind: "billed", taskId: null, rate: 40, currency: "USD",
          createdAt: back, closedAt: back + HOUR, deletedAt: null,
          segments: [{ startedAt: back, endedAt: back + HOUR }] },
      ],
      earnings: [],
    };
  };
  const open = async () => {
    const dom = await boot(seed());
    await settle();
    return { dom, d: dom.window.document };
  };

  it("offers the last things you ran, newest first", async () => {
    const { d } = await open();
    const picks = [...d.querySelectorAll(".again")].map((b) => b.textContent);
    expect(picks[0]).toMatch(/Gateway/);
    expect(picks[0]).toMatch(/1234/);
    expect(picks[1]).toMatch(/Atlas/);
  }, 20_000);

  it("starts the meter on that exact project and task in one click", async () => {
    const { dom, d } = await open();
    d.querySelectorAll(".again")[0].click();
    await settle();
    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    const live = saved.sessions.find((s) => s.segments.some((g) => g.endedAt == null));
    expect(live).toMatchObject({ projectId: "a", taskId: "t1" });
  }, 20_000);

  it("puts the one-click starts away while a meter is going", async () => {
    // Starting one closes whatever else is open, so a row of one-click starts
    // beside a running session is a row of one-click ways to end it.
    const { d } = await open();
    d.querySelectorAll(".again")[0].click();
    await settle();
    expect(d.querySelector(".again")).toBeNull();
    expect(d.querySelector(".runbar")).not.toBeNull();
  }, 20_000);

  it("lists the days there was work, newest first", async () => {
    const { d } = await open();
    const days = [...d.querySelectorAll(".day-name")].map((e) => e.textContent);
    expect(days).toHaveLength(2);
  }, 20_000);

  it("agrees with the Overview about what today came to", async () => {
    // Two screens quoting one day differently is the bug this whole codebase
    // is arranged to prevent, so the claim is asserted against the other
    // screen rather than against a number written here — which would pass
    // even if both were wrong, and breaks near midnight besides.
    const { d } = await open();
    const here = [...d.querySelectorAll(".sec-head")]
      .find((h) => /^Today/.test(h.textContent)).textContent.replace("Today", "").trim();

    await toProjects(d, "Overview");
    [...d.querySelectorAll(".dash-head .segmented .seg")]
      .find((b) => b.textContent === "Day").click();
    await settle();
    const overview = d.querySelector(".grand-amt").textContent;

    // Past midnight the seeded session falls on yesterday and today really is
    // empty. The two screens then say so in their own words — "nothing yet"
    // against a dash — and what has to agree is that neither quotes a figure,
    // not that the strings match.
    const blank = (text) => text === "—" || /nothing yet/i.test(text);
    if (blank(overview)) expect(blank(here)).toBe(true);
    else expect(here.startsWith(overview)).toBe(true);
  }, 20_000);

  it("opens the session a row names", async () => {
    const { d } = await open();
    d.querySelector(".day .row").click();
    await settle();
    expect(d.querySelector(".face")).not.toBeNull();
    expect(d.querySelector(".row.focus")).not.toBeNull();
  }, 20_000);
});

describe("paid more per hour once accepted", () => {
  const HOUR = 3_600_000;
  const now = Date.now();

  /** A finished sitting: started `back` hours ago, lasting `hours`. */
  const sess = (id, taskId, back, hours) => ({
    id, projectId: "a", kind: "billed", taskId, rate: 80, currency: "USD",
    status: "pending", deletedAt: null,
    createdAt: now - back * HOUR,
    closedAt: now - (back - hours) * HOUR,
    segments: [{ startedAt: now - back * HOUR, endedAt: now - (back - hours) * HOUR }],
  });

  /**
   * The shape the flat per-item model got wrong.
   *
   * $80 an hour as worked, and $10 more for every hour once the task lands —
   * so accepted work is worth $90 an hour, and a task that took six times as
   * long is worth six times as much. A flat $10 paid the same for a task that
   * took twenty minutes and one that took six hours.
   */
  const seed = () => ({
    projects: [{
      id: "a", name: "Orion", currentRate: 80, bonusPerHour: 10, currency: "USD",
      paysOnAcceptance: true, createdAt: now - 30 * HOUR,
      sessionGoal: null, overallGoal: null,
      tasks: [
        { id: "t1", label: "1234", createdAt: now - 30 * HOUR },
        { id: "t2", label: "1235", createdAt: now - 30 * HOUR },
      ],
    }],
    sessions: [sess("s1", "t1", 4, 3), sess("s2", "t2", 1, 0.5)],
    earnings: [],
  });

  const open = async (state = seed()) => {
    const dom = await boot(state);
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    return { dom, d };
  };
  const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
  const submitAll = async (d) => {
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^Submit 2$/).click();
    await settle();
  };

  it("prices the reward by the hours worked, not once per task", async () => {
    const { dom, d } = await open();
    await submitAll(d);

    const { earnings } = stored(dom);
    expect(earnings).toHaveLength(2);
    // Three hours and half an hour, at ten an hour.
    expect(earnings.map((e) => e.cents).sort((x, y) => y - x)).toEqual([3_000, 500]);
    expect(earnings.every((e) => e.status === "pending")).toBe(true);
    // Hours, not items: a count of one would print a per-item price nobody
    // quoted.
    expect(earnings.every((e) => e.units === undefined)).toBe(true);
  }, 30_000);

  it("keeps the hourly money pending when the work is handed in", async () => {
    // This project pays once accepted, so handing the work in delivers it
    // without earning anything. Only the answer coming back can do that.
    const { dom, d } = await open();
    expect(stored(dom).sessions.every((x) => x.status === "pending")).toBe(true);
    await submitAll(d);
    expect(stored(dom).sessions.every((x) => x.status === "pending")).toBe(true);
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^Accepted 2$/).click();
    await settle();
    expect(stored(dom).sessions.every((x) => x.status === undefined)).toBe(true);
  }, 30_000);

  it("shows on the row where the work stands", async () => {
    const { d } = await open();
    await submitAll(d);
    const tags = [...d.querySelectorAll(".trow .tag")].map((t) => t.textContent);
    expect(tags.filter((t) => t === "submitted")).toHaveLength(2);
  }, 30_000);

  it("pays the reward once the answer comes back yes", async () => {
    const { dom, d } = await open();
    await submitAll(d);
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^Accepted 2$/).click();
    await settle();

    expect(stored(dom).earnings.every((e) => e.status === undefined)).toBe(true);
    expect(stored(dom).projects[0].tasks.map((t) => t.state)).toEqual(["accepted", "accepted"]);
  }, 30_000);

  it("cancels the hours along with the reward when it comes back no", async () => {
    // Payment is per accepted task out of one amount, so rejected work earns
    // nothing: the reward and the hours go together. The sessions themselves
    // stay in the ledger, keeping their time and losing their money.
    const { dom, d } = await open();
    await submitAll(d);
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^Rejected 2$/).click();
    await settle();

    expect(stored(dom).earnings.every((e) => e.status === "cancelled")).toBe(true);
    expect(stored(dom).sessions.every((x) => x.status === "cancelled")).toBe(true);
    expect(stored(dom).sessions).toHaveLength(2);
  }, 30_000);

  it("puts the money back if the rejection was the wrong button", async () => {
    // One click destroys a whole batch's pay, so the opposite click has to
    // restore it. No state should be reachable only by editing the ledger.
    const { dom, d } = await open();
    await submitAll(d);
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^Rejected 2$/).click();
    await settle();
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^Accepted 2$/).click();
    await settle();

    expect(stored(dom).earnings.every((e) => e.status === undefined)).toBe(true);
    expect(stored(dom).sessions.every((x) => x.status === undefined)).toBe(true);
    expect(stored(dom).projects[0].tasks.map((t) => t.state)).toEqual(["accepted", "accepted"]);
  }, 30_000);

  it("will not take another hour on work already submitted", async () => {
    // The platform priced what it received. Minutes added afterwards are
    // minutes nobody is paying for, and they would change what the reward on
    // already-submitted work should have been.
    const { dom, d } = await open();
    await submitAll(d);
    btn(d, /Start the meter/i).click();
    await settle();
    const options = [...(d.querySelector(".prompt select")?.options ?? [])]
      .map((o) => o.textContent);
    expect(options).not.toContain("1234");
    expect(options).not.toContain("1235");
    expect(stored(dom).sessions).toHaveLength(2);
  }, 30_000);

  it("lets the work be reopened, without moving the money", async () => {
    const { dom, d } = await open();
    await submitAll(d);
    const before = stored(dom).earnings.map((e) => [e.cents, e.status]);
    btn(d, /^Select all 2$/).click();
    await settle();
    btn(d, /^Reopen 2$/).click();
    await settle();

    expect(stored(dom).projects[0].tasks.every((t) => t.state === undefined)).toBe(true);
    expect(stored(dom).earnings.map((e) => [e.cents, e.status])).toEqual(before);
  }, 30_000);

  it("lets a project choose which reward system it pays", async () => {
    // "Keep the per task reward as it is, but add this too so I can choose."
    const flat = seed();
    delete flat.projects[0].bonusPerHour;
    flat.projects[0].perTask = 10;

    const { dom, d } = await open(flat);
    btn(d, /^Open$/).click();
    await settle();
    btn(d, /^More per hour$/).click();
    await settle();
    const box = [...d.querySelectorAll(".field")]
      .find((f) => /Extra per hour/i.test(f.querySelector(".eyebrow")?.textContent ?? ""))
      .querySelector("input");
    setValue(dom.window, box, "10");
    await settle();
    btn(d, /Save changes/).click();
    await settle();

    const project = stored(dom).projects[0];
    expect(project.bonusPerHour).toBe(10);
    // The model not chosen is cleared, so the project never holds two answers
    // to what acceptance pays.
    expect(project.perTask).toBeNull();
  }, 30_000);
});
