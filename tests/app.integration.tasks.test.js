/**
 * Integration tests against the BUILT artifact, not the source. These catch
 * things unit tests structurally cannot: bundling mistakes, event wiring,
 * and CSS that silently fails (an inline element ignoring margin-top, say).
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { wait, settle, boot, runningSeed, btn, toProjects, setValue, startMeter, guardBuiltApp } from "./app.integration.helpers.js";

guardBuiltApp();

/** A BroadcastChannel standing in for the browser's: another tab that holds
 *  the meter answers "here" when `answers`, and none does otherwise. */
const tabs = (answers) => `window.BroadcastChannel = class {
  constructor() { this.l = []; }
  addEventListener(t, f) { this.l.push(f); }
  removeEventListener(t, f) { this.l = this.l.filter((x) => x !== f); }
  postMessage(m) {
    if (${answers} && m && m.t === "who") setTimeout(() => this.l.forEach((f) => f({ data: { t: "here", id: m.id } })), 10);
  }
  close() {}
};`;
const conflictShown = (dom) => [...dom.window.document.querySelectorAll(".banner")]
  .some((b) => /Already running/.test(b.textContent));

describe("the tab-conflict notice, where tabs can ask each other", () => {
  it("does not appear when the only tab is reloaded with its meter running", async () => {
    const dom = await boot(runningSeed(5_000), null, tabs(false));
    await wait(900);
    expect(conflictShown(dom)).toBe(false);
  }, 20_000);

  it("appears when another tab answers that it holds the meter", async () => {
    const dom = await boot(runningSeed(5_000), null, tabs(true));
    await wait(900);
    expect(conflictShown(dom)).toBe(true);
  }, 20_000);
});

describe("the tab-conflict notice", () => {
  it("appears when a session was ticking moments ago", async () => {
    const dom = await boot(runningSeed(5_000));
    const banner = dom.window.document.querySelector(".banner");
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("Already running");
  }, 20_000);

  it("stays dismissed after 'This tab only' — and does not come back", async () => {
    // Asks about THIS banner rather than "no banners at all": an unrelated
    // notice, such as the backup nudge, may legitimately be on screen, and the
    // bug this guards against was the conflict notice re-arming itself.
    const conflict = (d) => [...d.querySelectorAll(".banner")]
      .find((b) => /Already running/.test(b.textContent));
    const dom = await boot(runningSeed(5_000));
    const d = dom.window.document;
    expect(conflict(d)).toBeTruthy();
    btn(d, /This tab only/i).click();
    await settle();
    expect(conflict(d)).toBeUndefined();

    // The bug re-armed it on the very next render. Give it many: a real window,
    // longer than the 1 s render tick.
    await wait(1500);
    expect(conflict(d)).toBeUndefined();
  }, 20_000);

  it("leaves the running session alone when dismissed", async () => {
    const dom = await boot(runningSeed(5_000));
    const { window } = dom, d = window.document;
    btn(d, /This tab only/i).click();
    await settle();
    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.sessions[0].closedAt).toBeNull();
    expect(saved.sessions[0].segments[0].endedAt).toBeNull();
  }, 20_000);

  it("shows crash recovery instead when the heartbeat is stale", async () => {
    const dom = await boot(runningSeed(9 * 3_600_000));
    const banner = dom.window.document.querySelector(".banner");
    expect(banner.textContent).toContain("Meter left running");
  }, 20_000);
});

describe("tasks", () => {
  const makeProject = async (dom, rate = "450") => {
    const { window } = dom, d = window.document;
    await toProjects(d);
    btn(d, /New project/i).click();
    await settle();
    const [name, r] = d.querySelectorAll("input");
    setValue(window, name, "Acme");
    setValue(window, r, rate);
    btn(d, /Add project/i).click();
    await settle();
    await toProjects(d);
    d.querySelector(".card").click();
    await settle();
  };

  it("asks which task before it starts counting", async () => {
    const dom = await boot();
    const d = dom.window.document;
    await makeProject(dom);

    btn(d, /Start the meter/i).click();
    await settle();
    // The prompt is up and nothing is running yet.
    expect(d.querySelector(".prompt")).not.toBeNull();
    expect(d.querySelector(".state").textContent.trim()).toBe("Stopped");
    expect(d.querySelector(".prompt").textContent).toContain("New task");
  }, 25_000);

  it("records the chosen task and shows it on the face", async () => {
    const dom = await boot();
    const { window } = dom, d = window.document;
    await makeProject(dom);
    await startMeter(dom, { task: "1234" });
    await settle();

    expect(d.querySelector(".state").textContent.trim()).toBe("Running");
    expect(d.querySelector(".task-chip").textContent).toContain("1234");

    btn(d, /Stop and save/i).click();
    await settle();
    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.projects[0].tasks[0].label).toBe("1234");
    expect(saved.sessions[0].taskId).toBe(saved.projects[0].tasks[0].id);
  }, 25_000);

  it("reuses a task when the new name only differs by case or whitespace", async () => {
    const dom = await boot();
    const { window } = dom, d = window.document;
    await makeProject(dom);
    await startMeter(dom, { task: "Task-A" });
    await settle();
    btn(d, /Stop and save/i).click();
    await settle();
    await startMeter(dom, { task: "  task-a  " });
    await settle();
    btn(d, /Stop and save/i).click();
    await settle();

    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.projects[0].tasks).toHaveLength(1);
    expect(new Set(saved.sessions.map((x) => x.taskId)).size).toBe(1);
  }, 30_000);

  it("offers tasks already created as existing choices", async () => {
    const dom = await boot();
    const d = dom.window.document;
    await makeProject(dom);
    await startMeter(dom, { task: "1234" });
    await settle();
    btn(d, /Stop and save/i).click();
    await settle();

    btn(d, /Start the meter/i).click();
    await settle();
    expect(btn(d, /^Existing/i).textContent).toContain("(1)");
    expect([...d.querySelector(".prompt select").options].map((o) => o.textContent))
      .toEqual(["No task", "1234"]);
  }, 30_000);

  it("shows time and earnings per task in their own panel", async () => {
    const now = Date.now(), HOUR = 3_600_000;
    const base = { projectId: "p1", currency: "EGP", rate: 450, deletedAt: null };
    const dom = await boot({
      projects: [{ id: "p1", name: "Acme", currentRate: 450, currency: "EGP",
                   createdAt: now - 9 * HOUR, sessionGoal: null, overallGoal: null,
                   tasks: [{ id: "t1", label: "1234", createdAt: now - 9 * HOUR },
                           { id: "t2", label: "5678", createdAt: now - 9 * HOUR }] }],
      sessions: [
        { ...base, id: "s1", kind: "billed", taskId: "t1", createdAt: now - 9 * HOUR,
          segments: [{ startedAt: now - 9 * HOUR, endedAt: now - 7 * HOUR }], closedAt: now - 7 * HOUR },
        { ...base, id: "s2", kind: "billed", taskId: "t2", createdAt: now - 7 * HOUR,
          segments: [{ startedAt: now - 7 * HOUR, endedAt: now - 6 * HOUR }], closedAt: now - 6 * HOUR },
        { ...base, id: "i1", kind: "idle", taskId: "t1", createdAt: now - 6 * HOUR,
          segments: [{ startedAt: now - 6 * HOUR, endedAt: now - 5 * HOUR }], closedAt: now - 5 * HOUR },
      ],
    });
    const d = dom.window.document;
    await toProjects(d);
    d.querySelector(".card").click();
    await settle();

    const rows = [...d.querySelectorAll(".trow")];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".trow-label").textContent).toBe("1234");
    expect(rows[0].querySelector(".trow-amt").textContent).toMatch(/900\.00/);
    expect(rows[1].querySelector(".trow-amt").textContent).toMatch(/450\.00/);
    expect(rows[0].textContent).toContain("1h 00m idle");
    expect(rows[0].querySelector(".trow-amt").textContent).not.toMatch(/1,350/);
  }, 25_000);

  it("labels each ledger row with its task", async () => {
    const dom = await boot();
    const d = dom.window.document;
    await makeProject(dom);
    await startMeter(dom, { task: "9001" });
    await settle();
    btn(d, /Stop and save/i).click();
    await settle();
    expect(d.querySelector(".row-meta").textContent).toContain("9001");
  }, 25_000);
});

describe("the ledger collapses", () => {
  const ledgerSeed = (count) => {
    const now = Date.now(), HOUR = 3_600_000;
    return {
      projects: [{ id: "p1", name: "Acme", currentRate: 450, currency: "EGP",
                   createdAt: now - 40 * HOUR, sessionGoal: null, overallGoal: null, tasks: [] }],
      sessions: Array.from({ length: count }, (_, i) => ({
        id: `s${i}`, projectId: "p1", kind: "billed", taskId: null, rate: 450, currency: "EGP",
        createdAt: now - (i + 2) * HOUR,
        segments: [{ startedAt: now - (i + 2) * HOUR, endedAt: now - (i + 1) * HOUR }],
        closedAt: now - (i + 1) * HOUR, deletedAt: null,
      })),
    };
  };

  it("stays open for a short ledger", async () => {
    const dom = await boot(ledgerSeed(3));
    const d = dom.window.document;
    await toProjects(d);
    d.querySelector(".card").click();
    await settle();
    expect(d.querySelectorAll(".row")).toHaveLength(3);
  }, 25_000);

  it("starts collapsed once the list gets long, so Settings stays reachable", async () => {
    const dom = await boot(ledgerSeed(12));
    const d = dom.window.document;
    await toProjects(d);
    d.querySelector(".card").click();
    await settle();
    expect(d.querySelectorAll(".row")).toHaveLength(0);
    expect(btn(d, /Ledger/i).textContent).toContain("12 sessions");
    // The point of collapsing: Settings is still on screen.
    expect(btn(d, /^Open$/i)).toBeTruthy();
  }, 25_000);

  it("expands and collapses on demand, keeping the totals visible either way", async () => {
    const dom = await boot(ledgerSeed(12));
    const d = dom.window.document;
    await toProjects(d);
    d.querySelector(".card").click();
    await settle();
    const header = () => d.querySelectorAll(".sec-head")[
      [...d.querySelectorAll(".sec-head")].findIndex((h) => /Ledger/.test(h.textContent))
    ].textContent;
    expect(header()).toMatch(/5,400\.00/); // 12h at 450

    btn(d, /Ledger/i).click();
    await settle();
    expect(d.querySelectorAll(".row")).toHaveLength(12);

    btn(d, /Ledger/i).click();
    await settle();
    expect(d.querySelectorAll(".row")).toHaveLength(0);
    expect(header()).toMatch(/5,400\.00/);
  }, 25_000);
});

describe("re-filing old sessions", () => {
  const HOUR = 3_600_000;
  const seed = ({ tasks = [], assign = [] } = {}) => {
    const now = Date.now();
    return {
      projects: [{ id: "p1", name: "Acme", currentRate: 450, currency: "EGP",
                   createdAt: now - 40 * HOUR, sessionGoal: null, overallGoal: null, tasks }],
      sessions: Array.from({ length: 4 }, (_, i) => ({
        id: `s${i}`, projectId: "p1", kind: "billed", taskId: assign[i] ?? null,
        rate: 450, currency: "EGP", createdAt: now - (i + 2) * HOUR,
        segments: [{ startedAt: now - (i + 2) * HOUR, endedAt: now - (i + 1) * HOUR }],
        closedAt: now - (i + 1) * HOUR, deletedAt: null,
      })),
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

  it("moves a batch of finished sessions onto a new task", async () => {
    const dom = await boot(seed());
    const { window } = dom;
    const d = await open(dom);

    const boxes = [...d.querySelectorAll(".row .row-check")];
    boxes[0].click();
    boxes[2].click();
    await settle();
    expect(d.querySelector(".selbar-count").textContent).toBe("2 selected");

    btn(d, /Assign to task/i).click();
    await settle();
    setValue(window, d.querySelector(".prompt input"), "REPORT-7");
    btn(d, /Move 2 sessions/i).click();
    await settle();

    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    const task = saved.projects[0].tasks.find((t) => t.label === "REPORT-7");
    expect(task).toBeTruthy();
    const assigned = saved.sessions.filter((s) => s.taskId === task.id).map((s) => s.id);
    expect(assigned.sort()).toEqual(["s0", "s2"]);
    expect(saved.sessions.find((s) => s.id === "s1").taskId).toBeNull();
  }, 30_000);

  it("re-files without altering the recorded hours or rate", async () => {
    // The reason closed sessions accept this edit at all: it changes the
    // filing, never the measurement.
    const dom = await boot(seed());
    const { window } = dom;
    const d = await open(dom);
    const before = JSON.parse(window.localStorage.getItem("meter:v1")).sessions[0];

    d.querySelectorAll(".row .row-check")[0].click();
    await settle();
    btn(d, /Assign to task/i).click();
    await settle();
    setValue(window, d.querySelector(".prompt input"), "X-1");
    btn(d, /Move 1 session/i).click();
    await settle();

    const after = JSON.parse(window.localStorage.getItem("meter:v1")).sessions.find((s) => s.id === before.id);
    expect(after.segments).toEqual(before.segments);
    expect(after.rate).toBe(before.rate);
    expect(after.closedAt).toBe(before.closedAt);
    expect(after.taskId).not.toBeNull();
  }, 30_000);

  it("lets a plain hourly project turn work down", async () => {
    /*
     * Acme pays by the hour, as worked, with no acceptance reward and no
     * per-item price. Offering the lifecycle only where money is claimed per
     * task left this project unable to mark anything rejected at all - and a
     * project paid once accepted but with no uplift, which is the ordinary
     * shape of an hourly rate plus a review, could not even submit.
     *
     * Rejecting here cancels the money and keeps the hours, exactly as it
     * does anywhere else.
     */
    const tasks = [{ id: "t1", label: "1234", createdAt: Date.now() }];
    const dom = await boot(seed({ tasks, assign: ["t1", "t1", "t1", "t1"] }));
    const { window } = dom;
    const d = await open(dom);

    d.querySelector(".trow .row-check").click();
    await settle();
    btn(d, /^Submit 1$/).click();
    await settle();
    expect(JSON.parse(window.localStorage.getItem("meter:v1"))
      .projects[0].tasks[0].state).toBe("submitted");

    d.querySelector(".trow .row-check").click();
    await settle();
    btn(d, /^Rejected 1$/).click();
    await settle();

    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.projects[0].tasks[0].state).toBe("cancelled");
    expect(saved.sessions.filter((x) => x.taskId === "t1")
      .every((x) => x.status === "cancelled")).toBe(true);
    // The time is still there. Only the money went.
    expect(saved.sessions.filter((x) => x.taskId === "t1")).toHaveLength(4);
  }, 30_000);

  it("corrects a session filed under the wrong task", async () => {
    const tasks = [{ id: "t1", label: "1234", createdAt: Date.now() },
                   { id: "t2", label: "5678", createdAt: Date.now() }];
    const dom = await boot(seed({ tasks, assign: ["t1", "t1", "t1", "t1"] }));
    const { window } = dom;
    const d = await open(dom);

    d.querySelectorAll(".row .row-check")[1].click();
    await settle();
    btn(d, /Assign to task/i).click();
    await settle();
    btn(d, /^Existing/i).click();
    await settle();
    const select = d.querySelector(".prompt select");
    setValue(window, select, [...select.options].find((o) => o.textContent === "5678").value);
    btn(d, /Move 1 session/i).click();
    await settle();

    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.sessions.filter((s) => s.taskId === "t2").map((s) => s.id)).toEqual(["s1"]);
    expect(saved.sessions.filter((s) => s.taskId === "t1")).toHaveLength(3);
  }, 30_000);

  it("moves the totals across when a session is re-filed", async () => {
    const tasks = [{ id: "t1", label: "1234", createdAt: Date.now() },
                   { id: "t2", label: "5678", createdAt: Date.now() }];
    const dom = await boot(seed({ tasks, assign: ["t1", "t1", "t2", "t2"] }));
    const { window } = dom;
    const d = await open(dom);

    const amounts = () => Object.fromEntries([...d.querySelectorAll(".trow")]
      .map((r) => [r.querySelector(".trow-label").textContent,
                   r.querySelector(".trow-amt").textContent]));
    expect(amounts()["1234"]).toMatch(/900\.00/); // 2h
    expect(amounts()["5678"]).toMatch(/900\.00/);

    d.querySelectorAll(".row .row-check")[0].click();
    await settle();
    btn(d, /Assign to task/i).click();
    await settle();
    btn(d, /^Existing/i).click();
    await settle();
    const select = d.querySelector(".prompt select");
    setValue(window, select, [...select.options].find((o) => o.textContent === "5678").value);
    btn(d, /Move 1 session/i).click();
    await settle();

    expect(amounts()["1234"]).toMatch(/450\.00/);   // 1h
    expect(amounts()["5678"]).toMatch(/1,350\.00/); // 3h
  }, 30_000);

  it("filters the ledger to one task so a whole group can be checked", async () => {
    const tasks = [{ id: "t1", label: "1234", createdAt: Date.now() },
                   { id: "t2", label: "5678", createdAt: Date.now() }];
    const dom = await boot(seed({ tasks, assign: ["t1", "t2", "t1", null] }));
    const d = await open(dom);

    [...d.querySelectorAll(".trow")].find((r) => r.textContent.includes("5678")).click();
    await settle();
    expect(d.querySelectorAll(".row")).toHaveLength(1);
    expect(d.querySelector(".chip").textContent).toContain("5678");

    d.querySelector(".chip").click();
    await settle();
    expect(d.querySelectorAll(".row")).toHaveLength(4);
  }, 30_000);

  it("selects every visible row at once", async () => {
    const dom = await boot(seed());
    const d = await open(dom);
    btn(d, /Select all 4/i).click();
    await settle();
    expect(d.querySelector(".selbar-count").textContent).toBe("4 selected");
    btn(d, /Deselect all/i).click();
    await settle();
    expect(d.querySelector(".selbar")).toBeNull();
  }, 30_000);

  it("changes the task of the session that is still running", async () => {
    const now = Date.now();
    const dom = await boot({
      projects: [{ id: "p1", name: "Acme", currentRate: 450, currency: "EGP", createdAt: now - HOUR,
                   sessionGoal: null, overallGoal: null,
                   tasks: [{ id: "t1", label: "1234", createdAt: now - HOUR },
                           { id: "t2", label: "5678", createdAt: now - HOUR }] }],
      sessions: [{ id: "s1", projectId: "p1", kind: "billed", taskId: "t1", rate: 450,
                   currency: "EGP", createdAt: now - HOUR,
                   segments: [{ startedAt: now - HOUR, endedAt: null, lastTick: now - 5000 }],
                   closedAt: null, deletedAt: null }],
    });
    const { window } = dom, d = window.document;
    btn(d, /This tab only/i).click();
    await settle();
    await toProjects(d);
    d.querySelector(".card").click();
    await settle();

    expect(d.querySelector(".task-chip").textContent).toContain("1234");
    d.querySelector(".task-chip").click();
    await settle();
    const select = d.querySelector(".prompt select");
    setValue(window, select, [...select.options].find((o) => o.textContent === "5678").value);
    btn(d, /^Save$/i).click();
    await settle();

    expect(d.querySelector(".task-chip").textContent).toContain("5678");
    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.sessions[0].taskId).toBe("t2");
    expect(saved.sessions[0].closedAt).toBeNull(); // still running
  }, 30_000);
});

describe("managing tasks", () => {
  const HOUR = 3_600_000;
  const seed = ({ rate = null } = {}) => {
    const now = Date.now();
    return {
      projects: [{ id: "p1", name: "Acme", currentRate: 100, currency: "USD",
                   createdAt: now - 9 * HOUR, sessionGoal: null, overallGoal: null,
                   tasks: [{ id: "t1", label: "1234", createdAt: now - 9 * HOUR, rate },
                           { id: "t2", label: "5678", createdAt: now - 9 * HOUR, rate: null }] }],
      sessions: [
        { id: "s1", projectId: "p1", kind: "billed", taskId: "t1", rate: 100, currency: "USD",
          createdAt: now - 9 * HOUR,
          segments: [{ startedAt: now - 9 * HOUR, endedAt: now - 7 * HOUR }],
          closedAt: now - 7 * HOUR, deletedAt: null },
        { id: "s2", projectId: "p1", kind: "billed", taskId: "t2", rate: 100, currency: "USD",
          createdAt: now - 7 * HOUR,
          segments: [{ startedAt: now - 7 * HOUR, endedAt: now - 6 * HOUR }],
          closedAt: now - 6 * HOUR, deletedAt: null },
      ],
    };
  };
  const open = async (dom) => {
    const d = dom.window.document;
    await toProjects(d);
    d.querySelector(".card").click();
    await settle();
    return d;
  };
  const editTask = async (d, label) => {
    const row = [...d.querySelectorAll(".trow")].find((r) => r.textContent.includes(label));
    [...row.querySelectorAll("button")].find((b) => b.textContent === "edit").click();
    await settle();
  };

  it("renames a task everywhere at once", async () => {
    const dom = await boot(seed());
    const { window } = dom;
    const d = await open(dom);
    await editTask(d, "1234");

    const [name] = d.querySelectorAll(".prompt input");
    setValue(window, name, "PR review");
    btn(d, /^Save$/i).click();
    await settle();

    expect(d.querySelector(".trow-label").textContent).toBe("PR review");
    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.projects[0].tasks.find((t) => t.id === "t1").label).toBe("PR review");
    // Sessions hold the id, so nothing about them had to change.
    expect(saved.sessions[0].taskId).toBe("t1");
  }, 30_000);

  it("reprices finished work when the paid rate turns out lower", async () => {
    // 2h recorded at $100. The task actually pays $90.
    const dom = await boot(seed());
    const { window } = dom;
    const d = await open(dom);
    const amount = (label) => [...d.querySelectorAll(".trow")]
      .find((r) => r.textContent.includes(label)).querySelector(".trow-amt").textContent;
    expect(amount("1234")).toMatch(/200\.00/);

    await editTask(d, "1234");
    const [, rate] = d.querySelectorAll(".prompt input");
    setValue(window, rate, "90");
    btn(d, /^Save$/i).click();
    await settle();

    expect(amount("1234")).toMatch(/180\.00/); // 2h at 90
    expect(amount("5678")).toMatch(/100\.00/); // untouched
  }, 30_000);

  it("keeps the recorded hours and the original snapshot intact when repricing", async () => {
    const dom = await boot(seed());
    const { window } = dom;
    const d = await open(dom);
    const before = JSON.parse(window.localStorage.getItem("meter:v1")).sessions[0];

    await editTask(d, "1234");
    setValue(window, d.querySelectorAll(".prompt input")[1], "90");
    btn(d, /^Save$/i).click();
    await settle();

    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    const after = saved.sessions.find((s) => s.id === before.id);
    expect(after.segments).toEqual(before.segments);
    expect(after.rate).toBe(100); // the snapshot is the audit trail
    expect(saved.projects[0].tasks.find((t) => t.id === "t1").rate).toBe(90);
  }, 30_000);

  it("marks a repriced session in the ledger", async () => {
    const dom = await boot(seed({ rate: 90 }));
    const d = await open(dom);
    if (!d.querySelectorAll(".row").length) { btn(d, /Ledger/i).click(); await settle(); }
    const rows = [...d.querySelectorAll(".row-meta")].map((r) => r.textContent);
    expect(rows.find((r) => r.includes("1234"))).toContain("task rate");
    expect(rows.find((r) => r.includes("5678"))).not.toContain("task rate");
  }, 30_000);

  it("clears the override and returns to the recorded rate", async () => {
    const dom = await boot(seed({ rate: 90 }));
    const { window } = dom;
    const d = await open(dom);
    await editTask(d, "1234");
    setValue(window, d.querySelectorAll(".prompt input")[1], "");
    btn(d, /^Save$/i).click();
    await settle();
    expect([...d.querySelectorAll(".trow")]
      .find((r) => r.textContent.includes("1234")).querySelector(".trow-amt").textContent)
      .toMatch(/200\.00/);
  }, 30_000);

  it("warns how many sessions a delete would unfile, then unfiles them", async () => {
    const dom = await boot(seed());
    const { window } = dom;
    const d = await open(dom);
    await editTask(d, "1234");

    btn(d, /^Delete$/i).click();
    await settle();
    expect(d.querySelector(".prompt").textContent).toContain("1 session");

    btn(d, /Yes, delete it/i).click();
    await settle();

    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.projects[0].tasks.map((t) => t.id)).toEqual(["t2"]);
    // The hours survive; only the filing changed.
    const orphan = saved.sessions.find((s) => s.id === "s1");
    expect(orphan.taskId).toBeNull();
    expect(orphan.segments).toEqual(seed().sessions[0].segments.map(() => orphan.segments[0]));
    expect([...d.querySelectorAll(".trow")].some((r) => r.textContent.includes("No task"))).toBe(true);
  }, 30_000);

  it("undoes a task delete", async () => {
    const dom = await boot(seed());
    const { window } = dom;
    const d = await open(dom);
    await editTask(d, "1234");
    btn(d, /^Delete$/i).click();
    await settle();
    btn(d, /Yes, delete it/i).click();
    await settle();
    expect(d.querySelector(".toast")).not.toBeNull();

    btn(d, /Undo/i).click();
    await settle();
    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.projects[0].tasks).toHaveLength(2);
    expect(saved.sessions.find((s) => s.id === "s1").taskId).toBe("t1");
  }, 30_000);
});
