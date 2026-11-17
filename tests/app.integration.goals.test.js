/**
 * Integration tests against the BUILT artifact, not the source. These catch
 * things unit tests structurally cannot: bundling mistakes, event wiring,
 * and CSS that silently fails (an inline element ignoring margin-top, say).
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { settle, boot, btn, bootDash, toProjects, setValue, guardBuiltApp } from "./app.integration.helpers.js";

guardBuiltApp();

describe("Work and Life as separate tabs", () => {
  const HOUR = 3_600_000;
  const dayStart = (n = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
  };
  const project = (id, name, extra = {}) => ({
    id, name, currentRate: 100, currency: "USD", createdAt: dayStart(30),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  const seed = {
    projects: [project("p1", "Acme"), project("p2", "Sleep", { offClock: true })],
    sessions: [
      { id: "s1", projectId: "p1", kind: "billed", taskId: null, rate: 100, currency: "USD",
        createdAt: dayStart(), closedAt: dayStart() + HOUR, deletedAt: null,
        segments: [{ startedAt: dayStart(), endedAt: dayStart() + HOUR }] },
      { id: "s2", projectId: "p2", kind: "billed", taskId: null, rate: 0, currency: "USD",
        createdAt: dayStart(), closedAt: dayStart() + 8 * HOUR, deletedAt: null,
        segments: [{ startedAt: dayStart(), endedAt: dayStart() + 8 * HOUR }] },
    ],
  };

  it("keeps each list to its own tab", async () => {
    const { document: d } = (await boot(seed)).window;
    await toProjects(d, "Work");
    expect([...d.querySelectorAll(".card-name")].map((n) => n.textContent)).toEqual(["Acme"]);
    await toProjects(d, "Life");
    expect([...d.querySelectorAll(".card-name")].map((n) => n.textContent)).toEqual(["Sleep"]);
  }, 20_000);

  it("asks a different question on each: what it earned, and how long it took", async () => {
    const { document: d } = (await boot(seed)).window;
    await toProjects(d, "Work");
    expect(d.querySelector(".grand").textContent).toMatch(/Earned across everything/);
    expect(d.querySelector(".grand-amt").textContent).toMatch(/100\.00/);

    await toProjects(d, "Life");
    expect(d.querySelector(".grand").textContent).toMatch(/Tracked across everything/);
    expect(d.querySelector(".grand-amt").textContent).toBe("8h 00m");
  }, 20_000);

  it("returns from a project to the tab it belongs to", async () => {
    const { document: d } = (await boot(seed)).window;
    await toProjects(d, "Life");
    d.querySelector(".card").click();
    await settle();
    btn(d, /All projects/i).click();
    await settle();
    // back on Life, not thrown to Work
    expect([...d.querySelectorAll(".card-name")].map((n) => n.textContent)).toEqual(["Sleep"]);
  }, 20_000);

  it("adds a life area with no rate to invent", async () => {
    // Demanding a rate for something that cannot earn is what produced 0.00001.
    const dom = await boot(seed);
    const d = dom.window.document;
    await toProjects(d, "Life");
    btn(d, /New area/i).click();
    await settle();
    expect(d.querySelectorAll("input[type=number]")).toHaveLength(0);

    setValue(dom.window, d.querySelector(".panel input"), "Reading");
    btn(d, /Add area/i).click();
    await settle();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    const added = saved.projects.find((p) => p.name === "Reading");
    expect(added.offClock).toBe(true);
    // and it lands on Life, not among the work projects
    expect([...d.querySelectorAll(".card-name")].map((n) => n.textContent))
      .toEqual(["Sleep", "Reading"]);
  }, 20_000);
});

describe("objectives", () => {
  const HOUR = 3_600_000;
  const dayStart = (n = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
  };
  const todayKey = () => {
    const d = new Date(); const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const objective = (id, projectId, text, extra = {}) => ({
    id, projectId, text, done: false, doneAt: null, createdAt: dayStart(3),
    focusedOn: null, estimateMs: null, taskId: null, deletedAt: null, ...extra,
  });
  const seed = (objectives = []) => ({
    projects: [
      { id: "p1", name: "Acme", currentRate: 100, currency: "USD", createdAt: dayStart(30),
        sessionGoal: null, overallGoal: null,
        tasks: [{ id: "t1", label: "Task 1", createdAt: dayStart(10), rate: null }] },
      { id: "p2", name: "Sleep", currentRate: 0, currency: "USD", createdAt: dayStart(30),
        offClock: true, sessionGoal: null, overallGoal: null, tasks: [] },
    ],
    sessions: [{
      id: "s1", projectId: "p1", kind: "billed", taskId: "t1", rate: 100, currency: "USD",
      createdAt: dayStart(), closedAt: dayStart() + 3 * HOUR, deletedAt: null,
      segments: [{ startedAt: dayStart(), endedAt: dayStart() + 3 * HOUR }],
    }],
    objectives,
  });
  const openAcme = async (objectives) => {
    const dom = await bootDash(seed(objectives));
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    return { dom, d };
  };

  it("adds one and keeps it after a reload", async () => {
    const { dom, d } = await openAcme([]);
    btn(d, /New objective/i).click();
    await settle();
    setValue(dom.window, d.querySelector(".obj-form input"), "Finish the report");
    btn(d, /^Add$/).click();
    await settle();

    expect(d.querySelector(".obj-text").textContent).toBe("Finish the report");
    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.objectives).toHaveLength(1);
    expect(saved.objectives[0]).toMatchObject({ text: "Finish the report", done: false });
  }, 20_000);

  it("reports what it actually took against what you estimated", async () => {
    // The whole reason this lives in a timer: 3h against a 2h estimate.
    const { d } = await openAcme([
      objective("o1", "p1", "Ship it", { estimateMs: 2 * HOUR, taskId: "t1" }),
    ]);
    const meta = d.querySelector(".obj-meta").textContent;
    expect(meta).toMatch(/est 2h 00m/);
    expect(meta).toMatch(/spent 3h 00m/);
    expect(d.querySelector(".obj-verdict").textContent).toMatch(/150% of estimate/);
    expect(d.querySelector(".obj-verdict").className).toMatch(/over/);
  }, 20_000);

  it("says nothing about an objective it was never measuring", async () => {
    const { d } = await openAcme([objective("o1", "p1", "Email the client")]);
    expect(d.querySelector(".obj-meta").textContent).toMatch(/not timed/);
    expect(d.querySelector(".obj-verdict")).toBeNull();
  }, 20_000);

  it("ticks one off and records when", async () => {
    const { dom, d } = await openAcme([objective("o1", "p1", "Ship it")]);
    d.querySelector(".obj-check input").click();
    await settle();
    expect(d.querySelector(".obj").className).toMatch(/done/);
    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.objectives[0].done).toBe(true);
    expect(saved.objectives[0].doneAt).toBeGreaterThan(0);
  }, 20_000);

  it("picks one for today and shows it on the Overview", async () => {
    const { dom, d } = await openAcme([objective("o1", "p1", "Ship it")]);
    btn(d, /^today$/).click();
    await settle();
    expect(JSON.parse(dom.window.localStorage.getItem("meter:v1")).objectives[0].focusedOn)
      .toBe(todayKey());

    btn(d, /All projects/i).click();
    await settle();
    [...d.querySelectorAll(".tabs [role=tab]")].find((t) => t.textContent === "Overview").click();
    await settle();

    const heads = [...d.querySelectorAll(".sec-head")].map((h) => h.textContent);
    expect(heads.some((t) => /Today/.test(t))).toBe(true);
    expect(d.querySelector(".obj-text").textContent).toBe("Ship it");
  }, 25_000);

  it("gathers today's picks from work and life alike", async () => {
    const key = todayKey();
    const dom = await bootDash(seed([
      objective("o1", "p1", "Ship it", { focusedOn: key }),
      objective("o2", "p2", "Bed by midnight", { focusedOn: key }),
      objective("o3", "p1", "Not today"),
    ]));
    const d = dom.window.document;
    await settle();
    expect([...d.querySelectorAll(".obj-text")].map((n) => n.textContent))
      .toEqual(["Ship it", "Bed by midnight"]);
  }, 20_000);

  it("drops an item off today once it is ticked, leaving what is left", async () => {
    const dom = await bootDash(seed([
      objective("o1", "p1", "Ship it", { focusedOn: todayKey() }),
      objective("o2", "p1", "And this", { focusedOn: todayKey() }),
    ]));
    const d = dom.window.document;
    await settle();
    expect(d.querySelectorAll(".obj")).toHaveLength(2);
    d.querySelector(".obj-check input").click();
    await settle();
    expect([...d.querySelectorAll(".obj-text")].map((n) => n.textContent)).toEqual(["And this"]);
  }, 20_000);

  it("calls it a to-do on something off the clock", async () => {
    const dom = await bootDash(seed([objective("o1", "p2", "Bed by midnight")]));
    const d = dom.window.document;
    await toProjects(d, "Life");
    d.querySelector(".card").click();
    await settle();
    const text = d.querySelector(".mtr").textContent;
    expect(text).toMatch(/To-do/);
    expect(text).not.toMatch(/Objectives/);
  }, 20_000);

  it("keeps an objective when its task is deleted, unfiled rather than lost", async () => {
    const { dom, d } = await openAcme([
      objective("o1", "p1", "Ship it", { taskId: "t1" }),
    ]);
    const editTask = [...d.querySelectorAll(".trow .linkish")].find((b) => /edit/.test(b.textContent));
    editTask.click();
    await settle();
    btn(d, /^Delete$/).click();
    await settle();
    btn(d, /Yes, delete it/i).click();
    await settle();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.objectives[0].text).toBe("Ship it");
    expect(saved.objectives[0].taskId).toBeNull();
  }, 25_000);

  it("counts what is left on the project card", async () => {
    const dom = await bootDash(seed([
      objective("o1", "p1", "One"),
      objective("o2", "p1", "Two", { done: true, doneAt: Date.now() }),
    ]));
    const d = dom.window.document;
    await toProjects(d, "Work");
    expect(d.querySelector(".card-meta").textContent).toMatch(/1 to do/);
  }, 20_000);
});

describe("adding time you didn't track", () => {
  const HOUR = 3_600_000;
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const dayStart = (n = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
  };
  const seed = (sessions = []) => ({
    projects: [{
      id: "p1", name: "Acme", currentRate: 100, currency: "USD", createdAt: dayStart(30),
      sessionGoal: null, overallGoal: null,
      tasks: [{ id: "t1", label: "Task 1", createdAt: dayStart(10), rate: null }],
    }],
    sessions,
  });
  const block = (id, from, to) => ({
    id, projectId: "p1", kind: "billed", taskId: null, rate: 100, currency: "USD",
    createdAt: from, closedAt: to, deletedAt: null,
    segments: [{ startedAt: from, endedAt: to }],
  });

  const openForm = async (sessions = []) => {
    const dom = await boot(seed(sessions));
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    btn(d, /add time/i).click();
    await settle();
    return { dom, d };
  };

  const setWindow = (dom, d, from, to) => {
    const [start, end] = d.querySelectorAll('input[type="datetime-local"]');
    setValue(dom.window, start, stamp(from));
    setValue(dom.window, end, stamp(to));
  };

  it("records a block that the meter never watched", async () => {
    const { dom, d } = await openForm();
    setWindow(dom, d, dayStart(1) + 9 * HOUR, dayStart(1) + 12 * HOUR);
    await settle();
    expect(d.querySelector(".preview-now").textContent).toMatch(/3h 00m/);
    expect(d.querySelector(".preview-now").textContent).toMatch(/300\.00/);

    btn(d, /^Add time$/).click();
    await settle();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.sessions).toHaveLength(1);
    expect(saved.sessions[0]).toMatchObject({ manual: true, rate: 100, kind: "billed" });
    expect(saved.sessions[0].closedAt).toBe(dayStart(1) + 12 * HOUR);
  }, 25_000);

  it("marks it in the ledger as added rather than measured", async () => {
    // A block you typed is different evidence from one the clock watched.
    const { dom, d } = await openForm();
    setWindow(dom, d, dayStart(1) + 9 * HOUR, dayStart(1) + 10 * HOUR);
    await settle();
    btn(d, /^Add time$/).click();
    await settle();
    expect([...d.querySelectorAll(".edited")].map((e) => e.textContent)).toContain("Added");
  }, 25_000);

  it("does not stop a meter that is running now", async () => {
    const now = Date.now();
    const dom = await boot(seed([{
      id: "live", projectId: "p1", kind: "billed", taskId: null, rate: 100, currency: "USD",
      createdAt: now - HOUR, closedAt: null, deletedAt: null,
      segments: [{ startedAt: now - HOUR, endedAt: null, lastTick: now }],
    }]));
    const d = dom.window.document;
    btn(d, /This tab only/i).click();
    await settle();
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    btn(d, /add time/i).click();
    await settle();
    // a window well clear of the running session
    setWindow(dom, d, dayStart(3) + 9 * HOUR, dayStart(3) + 10 * HOUR);
    await settle();
    btn(d, /^Add time$/).click();
    await settle();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.sessions.find((s) => s.id === "live").closedAt).toBeNull();
    expect(d.querySelector(".state").textContent.trim()).toBe("Running");
  }, 30_000);

  it("refuses to double-count an hour until you say so explicitly", async () => {
    // The meter cannot produce two overlapping records; this is the only way,
    // so it is named rather than silently accepted.
    const { dom, d } = await openForm([block("old", dayStart(1) + 9 * HOUR, dayStart(1) + 12 * HOUR)]);
    setWindow(dom, d, dayStart(1) + 11 * HOUR, dayStart(1) + 13 * HOUR);
    await settle();

    expect(d.querySelector(".clash")).not.toBeNull();
    expect(d.querySelector(".clash").textContent).toMatch(/overlaps 1 record/);
    expect(btn(d, /^Add time$/).disabled).toBe(true);

    d.querySelector(".clash-ok input").click();
    await settle();
    expect(btn(d, /^Add time$/).disabled).toBe(false);
    btn(d, /^Add time$/).click();
    await settle();
    expect(JSON.parse(dom.window.localStorage.getItem("meter:v1")).sessions).toHaveLength(2);
  }, 25_000);

  it("does not complain about blocks that merely meet end to end", async () => {
    const { dom, d } = await openForm([block("old", dayStart(1) + 9 * HOUR, dayStart(1) + 12 * HOUR)]);
    setWindow(dom, d, dayStart(1) + 12 * HOUR, dayStart(1) + 13 * HOUR);
    await settle();
    expect(d.querySelector(".clash")).toBeNull();
    expect(btn(d, /^Add time$/).disabled).toBe(false);
  }, 25_000);

  it("re-arms the warning when the window changes again", async () => {
    const { dom, d } = await openForm([block("old", dayStart(1) + 9 * HOUR, dayStart(1) + 12 * HOUR)]);
    setWindow(dom, d, dayStart(1) + 10 * HOUR, dayStart(1) + 11 * HOUR);
    await settle();
    d.querySelector(".clash-ok input").click();
    await settle();
    expect(btn(d, /^Add time$/).disabled).toBe(false);

    // moving it somewhere else should not inherit the previous confirmation
    setWindow(dom, d, dayStart(1) + 10 * HOUR, dayStart(1) + 11.5 * HOUR);
    await settle();
    expect(btn(d, /^Add time$/).disabled).toBe(true);
  }, 25_000);

  it("files it under a task and counts it toward that task's total", async () => {
    const { dom, d } = await openForm();
    setWindow(dom, d, dayStart(1) + 9 * HOUR, dayStart(1) + 11 * HOUR);
    await settle();
    const taskSelect = d.querySelector(".prompt select");
    setValue(dom.window, taskSelect, "t1");
    await settle();
    btn(d, /^Add time$/).click();
    await settle();

    expect(JSON.parse(dom.window.localStorage.getItem("meter:v1")).sessions[0].taskId).toBe("t1");
    expect(d.querySelector(".trow-time").textContent).toMatch(/2h 00m/);
  }, 25_000);

  it("can log idle time after the fact too", async () => {
    const { dom, d } = await openForm();
    setWindow(dom, d, dayStart(1) + 9 * HOUR, dayStart(1) + 10 * HOUR);
    await settle();
    const selects = [...d.querySelectorAll(".prompt select")];
    setValue(dom.window, selects[selects.length - 1], "idle");
    await settle();
    // idle earns nothing, so the preview drops the money
    expect(d.querySelector(".preview-now").textContent).not.toMatch(/\$/);
    btn(d, /^Add time$/).click();
    await settle();
    expect(JSON.parse(dom.window.localStorage.getItem("meter:v1")).sessions[0].kind).toBe("idle");
  }, 25_000);
});

describe("linking an objective to a task", () => {
  const HOUR = 3_600_000;
  const dayStart = (n = 0) => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
  };
  const seed = (tasks, objectives) => ({
    projects: [{
      id: "p1", name: "Acme", currentRate: 100, currency: "USD", createdAt: dayStart(30),
      sessionGoal: null, overallGoal: null, tasks,
    }],
    sessions: [{
      id: "s1", projectId: "p1", kind: "billed", taskId: "t1", rate: 100, currency: "USD",
      createdAt: dayStart(), closedAt: dayStart() + 2 * HOUR, deletedAt: null,
      segments: [{ startedAt: dayStart(), endedAt: dayStart() + 2 * HOUR }],
    }],
    objectives,
  });
  const objective = (extra = {}) => ({
    id: "o1", projectId: "p1", text: "Ship it", done: false, doneAt: null,
    createdAt: dayStart(3), focusedOn: null, estimateMs: null, taskId: null,
    deletedAt: null, ...extra,
  });
  const task = { id: "t1", label: "Task 1", createdAt: dayStart(10), rate: null };

  const open = async (tasks, objectives) => {
    const dom = await boot(seed(tasks, objectives));
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    return { dom, d };
  };

  it("links an existing objective to a task after the fact", async () => {
    // The usual order is backwards: you write the objective first and only
    // create the task when you actually start timing it.
    const { dom, d } = await open([task], [objective()]);
    expect(d.querySelector(".obj-meta").textContent).toMatch(/not timed/);

    btn(d, /^edit$/).click();
    await settle();
    const select = [...d.querySelectorAll(".obj-form select")][0];
    setValue(dom.window, select, "t1");
    await settle();
    btn(d, /^Save$/).click();
    await settle();

    expect(JSON.parse(dom.window.localStorage.getItem("meter:v1")).objectives[0].taskId)
      .toBe("t1");
    // and it immediately reports the hours already on that task
    expect(d.querySelector(".obj-meta").textContent).toMatch(/spent 2h 00m/);
  }, 25_000);

  it("adds an estimate later, turning a plain item into a measured one", async () => {
    const { dom, d } = await open([task], [objective({ taskId: "t1" })]);
    btn(d, /^edit$/).click();
    await settle();
    setValue(dom.window, d.querySelector('.obj-form input[type="number"]'), "1");
    btn(d, /^Save$/).click();
    await settle();

    expect(d.querySelector(".obj-meta").textContent).toMatch(/est 1h 00m/);
    expect(d.querySelector(".obj-verdict").textContent).toMatch(/200% of estimate/);
  }, 25_000);

  it("unlinks again without touching the recorded hours", async () => {
    const { dom, d } = await open([task], [objective({ taskId: "t1" })]);
    btn(d, /^edit$/).click();
    await settle();
    setValue(dom.window, [...d.querySelectorAll(".obj-form select")][0], "");
    btn(d, /^Save$/).click();
    await settle();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.objectives[0].taskId).toBeNull();
    expect(saved.sessions[0].segments[0].endedAt).toBe(dayStart() + 2 * HOUR);
  }, 25_000);

  it("renames it without losing the link or the estimate", async () => {
    const { dom, d } = await open([task], [objective({ taskId: "t1", estimateMs: HOUR })]);
    btn(d, /^edit$/).click();
    await settle();
    setValue(dom.window, d.querySelector('.obj-form input[type="text"], .obj-form .inp'), "Ship it properly");
    btn(d, /^Save$/).click();
    await settle();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1")).objectives[0];
    expect(saved.text).toBe("Ship it properly");
    expect(saved.taskId).toBe("t1");
    expect(saved.estimateMs).toBe(HOUR);
  }, 25_000);

  it("explains the empty picker when the project has no tasks yet", async () => {
    // Rather than hiding the field, so it is somewhere you have already looked.
    const { d } = await open([], [objective()]);
    btn(d, /^edit$/).click();
    await settle();
    expect(d.querySelector(".obj-form").textContent).toMatch(/No tasks on this project yet/);
  }, 25_000);
});
