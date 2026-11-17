/**
 * Integration tests against the BUILT artifact, not the source. These catch
 * things unit tests structurally cannot: bundling mistakes, event wiring,
 * and CSS that silently fails (an inline element ignoring margin-top, say).
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { settle, boot, btn, toProjects, setValue, guardBuiltApp } from "./app.integration.helpers.js";

guardBuiltApp();

describe("fixes: editors and entry forms", () => {
  const HOUR = 3_600_000;
  /** Whole minutes, because every time box here is to the minute: a seed
   *  carrying seconds would come back from an untouched box slightly moved. */
  const minute = (t) => Math.floor(t / 60_000) * 60_000;
  const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
  const stamp = (epoch) => {
    const p = (n) => String(n).padStart(2, "0");
    const x = new Date(epoch);
    return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
  };
  const sitting = (id, projectId, taskId, from, to, extra = {}) => ({
    id, projectId, kind: "billed", taskId, rate: 20, currency: "USD",
    createdAt: from, closedAt: to, deletedAt: null,
    segments: [{ startedAt: from, endedAt: to }], ...extra,
  });
  const project = (id, name, extra = {}) => ({
    id, name, currentRate: 20, currency: "USD", createdAt: minute(Date.now()) - 40 * HOUR,
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  /** Opens one project, by name, from the Work tab. */
  const openProject = async (seed, name) => {
    const dom = await boot(seed);
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Work");
    [...d.querySelectorAll(".card")].find((c) => c.textContent.includes(name)).click();
    await settle();
    return { dom, d };
  };
  /** The input under a labelled field, looked for inside `root`. */
  const field = (root, label) => [...root.querySelectorAll(".field")]
    .find((f) => new RegExp(label, "i").test(f.querySelector(".eyebrow")?.textContent ?? ""))
    ?.querySelector("input, textarea, select");
  const taskRow = (d, label) => [...d.querySelectorAll(".trow")]
    .find((r) => r.querySelector(".trow-label").textContent.startsWith(label));
  const ledgerRow = (d, label) => [...d.querySelectorAll(".row")]
    .find((r) => r.querySelector(".row-meta")?.textContent.startsWith(label));
  const press = async (root, text) => {
    [...root.querySelectorAll("button")].find((b) => b.textContent === text).click();
    await settle();
  };

  /** Two tasks that differ in everything a form holds, so a value carried
   *  over from one cannot pass for the other's own. */
  const twoTasks = () => {
    const at = minute(Date.now()) - 8 * HOUR;
    return {
      projects: [project("p1", "Acme", {
        tasks: [
          { id: "t1", label: "T-1", note: "the first one's note", createdAt: at },
          { id: "t2", label: "T-2", note: "the second one's note", rate: 35, createdAt: at },
        ],
      })],
      sessions: [
        sitting("s1", "p1", "t1", at, at + 2 * HOUR),
        sitting("s2", "p1", "t2", at + 3 * HOUR, at + 4 * HOUR),
      ],
    };
  };

  it("edits the task it was last opened on, not the one before", async () => {
    // Reported: the editor opened on T-1 and then on T-2 still held T-1's
    // name, note and rate, and Save wrote all three onto T-2.
    const { dom, d } = await openProject(twoTasks(), "Acme");
    await press(taskRow(d, "T-1"), "edit");
    expect(field(d.querySelector(".prompt"), "^Name$").value).toBe("T-1");

    await press(taskRow(d, "T-2"), "edit");
    const form = d.querySelector(".prompt");
    expect(field(form, "^Name$").value).toBe("T-2");
    expect(field(form, "Rate for this task").value).toBe("35");
    expect(field(form, "^Note$").value).toBe("the second one's note");

    btn(d, /^Save$/).click();
    await settle();
    const [t1, t2] = stored(dom).projects[0].tasks;
    expect(t2).toMatchObject({ label: "T-2", rate: 35, note: "the second one's note" });
    expect(t1).toMatchObject({ label: "T-1", note: "the first one's note" });
    expect(t1.rate ?? null).toBeNull();
  }, 30_000);

  it("corrects the session it was last opened on, not the one before", async () => {
    const seed = twoTasks();
    const [a, b] = seed.sessions;
    const { dom, d } = await openProject(seed, "Acme");
    const boxes = () => [...d.querySelectorAll('.prompt input[type="datetime-local"]')]
      .map((x) => x.value);

    await press(ledgerRow(d, "T-1"), "edit");
    expect(boxes()).toEqual([stamp(a.segments[0].startedAt), stamp(a.segments[0].endedAt)]);
    await press(ledgerRow(d, "T-2"), "edit");
    expect(boxes()).toEqual([stamp(b.segments[0].startedAt), stamp(b.segments[0].endedAt)]);

    btn(d, /Save correction/).click();
    await settle();
    const saved = stored(dom).sessions;
    expect(saved.find((x) => x.id === "s2").segments).toEqual(b.segments);
    expect(saved.find((x) => x.id === "s1")).toEqual(a);
  }, 30_000);

  it("shows the project it is on in Settings after the running bar switches projects", async () => {
    // Opened on Alpha, then Beta reached through the running bar: the panel
    // still held Alpha, so Save renamed Beta "Alpha" and copied its rate.
    const now = minute(Date.now());
    const seed = {
      projects: [project("a", "Alpha", { currentRate: 50 }), project("b", "Beta", { currentRate: 70 })],
      // Running on the other machine, so it is in the running bar without
      // raising the two-tabs notice.
      sessions: [{
        id: "live", projectId: "b", kind: "billed", taskId: null, rate: 70, currency: "USD",
        createdAt: now - HOUR, closedAt: null, deletedAt: null, device: "some-other-machine",
        segments: [{ startedAt: now - HOUR, endedAt: null, lastTick: now }],
      }],
    };
    const { dom, d } = await openProject(seed, "Alpha");
    btn(d, /^Open$/).click();
    await settle();
    expect(field(d, "Project name").value).toBe("Alpha");

    d.querySelector(".runbar-what").click();
    await settle();
    expect(d.querySelector(".plate-name").textContent).toContain("Beta");
    if (btn(d, /^Open$/)) {
      btn(d, /^Open$/).click();
      await settle();
    }
    expect(field(d, "Project name").value).toBe("Beta");
    expect(field(d, "Hourly rate").value).toBe("70");

    setValue(dom.window, field(d, "Hourly rate"), "75");
    await settle();
    btn(d, /Save changes/).click();
    await settle();
    const [alpha, beta] = stored(dom).projects;
    expect(beta).toMatchObject({ name: "Beta", currentRate: 75 });
    expect(alpha).toMatchObject({ name: "Alpha", currentRate: 50 });
  }, 30_000);

  it("asks what the session it was last opened on earned, not the one before", async () => {
    const seed = twoTasks();
    seed.projects[0].perTask = 10;
    const { d } = await openProject(seed, "Acme");
    const forBox = () => field(d.querySelector(".prompt"), "^For$");

    await press(ledgerRow(d, "T-1"), "what it earned");
    expect(forBox().value).toBe("t1");
    await press(ledgerRow(d, "T-2"), "what it earned");
    expect(forBox().value).toBe("t2");
  }, 30_000);

  it("starts every objective edit from the objective as it is", async () => {
    // A cancelled edit used to linger in the row's boxes, ready to be saved
    // over the real text the next time the row was opened.
    const seed = {
      projects: [project("p1", "Acme")],
      sessions: [],
      objectives: [{
        id: "o1", projectId: "p1", text: "Write the report", done: false, doneAt: null,
        createdAt: minute(Date.now()) - HOUR, focusedOn: null, estimateMs: null, taskId: null,
        deletedAt: null,
      }],
    };
    const { dom, d } = await openProject(seed, "Acme");
    await press(d.querySelector(".obj-actions"), "edit");
    setValue(dom.window, field(d, "What needs doing"), "Something else entirely");
    await press(d.querySelector(".obj-form"), "Cancel");

    await press(d.querySelector(".obj-actions"), "edit");
    expect(field(d, "What needs doing").value).toBe("Write the report");
  }, 30_000);

  it("closes the session editor when its session is removed, rather than the page", async () => {
    const { d } = await openProject(twoTasks(), "Acme");
    await press(ledgerRow(d, "T-1"), "edit");
    expect(d.querySelector(".prompt")).not.toBeNull();

    ledgerRow(d, "T-1").querySelector(".x").click();
    await settle();
    expect(d.querySelector(".face")).not.toBeNull();
    expect(d.querySelector(".prompt")).toBeNull();
    expect(d.querySelectorAll(".row")).toHaveLength(1);
  }, 30_000);

  /** One task already answered, and one sitting filed under nothing. Nothing
   *  is open, so every prompt opens on a new name. */
  const answered = (state) => {
    const at = minute(Date.now()) - 8 * HOUR;
    return {
      projects: [project("p1", "Acme", {
        tasks: [{ id: "t1", label: "T-1", createdAt: at, state, stateAt: at + 3 * HOUR,
                  submittedAt: at + 3 * HOUR }],
      })],
      sessions: [
        sitting("s1", "p1", "t1", at, at + 2 * HOUR, state === "cancelled" ? { status: "cancelled" } : {}),
        sitting("s2", "p1", null, at + 4 * HOUR, at + 5 * HOUR),
      ],
    };
  };

  it("says why a submitted task's name starts nothing, and stays open", async () => {
    // Typing it under New task and pressing Start did nothing at all: no
    // meter, no message, and the prompt closed as if it had worked.
    const { dom, d } = await openProject(answered("submitted"), "Acme");
    btn(d, /Start the meter/).click();
    await settle();
    const name = field(d.querySelector(".prompt"), "Name it");
    setValue(dom.window, name, " t-1 ");
    await settle();

    const warning = d.querySelector(".prompt .hint.warn");
    expect(warning.textContent).toMatch(/“T-1” was submitted, so it takes no more time/);
    expect(btn(d, /^Start the meter$/).disabled).toBe(true);
    name.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();

    expect(d.querySelector(".prompt")).not.toBeNull();
    expect(d.querySelector(".state").textContent.trim()).toBe("Stopped");
    expect(stored(dom).sessions).toHaveLength(2);
  }, 30_000);

  it("says why sessions cannot be moved onto a rejected task, and moves nothing", async () => {
    // The name resolved to the rejected task and the move went through: a
    // paid hour filed under rejected work stayed paid, and the task showed it
    // as earned.
    const { dom, d } = await openProject(answered("cancelled"), "Acme");
    ledgerRow(d, "No task").querySelector(".row-check").click();
    await settle();
    btn(d, /Assign to task/).click();
    await settle();
    setValue(dom.window, field(d.querySelector(".prompt"), "Name it"), "T-1");
    await settle();

    expect(d.querySelector(".prompt .hint.warn").textContent)
      .toMatch(/“T-1” was rejected, so it takes no more time/);
    expect(btn(d, /^Move 1 session$/).disabled).toBe(true);
    expect(stored(dom).sessions.find((x) => x.id === "s2").taskId).toBeNull();
  }, 30_000);

  it("says so when the task picked for a move is handed in while the prompt is open", async () => {
    const seed = twoTasks();
    seed.sessions.push(sitting("s3", "p1", null, seed.sessions[1].closedAt + HOUR,
      seed.sessions[1].closedAt + 2 * HOUR));
    const { dom, d } = await openProject(seed, "Acme");
    ledgerRow(d, "No task").querySelector(".row-check").click();
    await settle();
    btn(d, /Assign to task/).click();
    await settle();
    setValue(dom.window, d.querySelector(".prompt select"), "t2");
    await settle();

    taskRow(d, "T-2").querySelector(".row-check").click();
    await settle();
    btn(d, /^Submit 1$/).click();
    await settle();

    expect(d.querySelector(".prompt .hint.warn").textContent)
      .toMatch(/“T-2” was submitted, so it takes no more time/);
    expect(btn(d, /^Move 1 session$/).disabled).toBe(true);
    expect(stored(dom).sessions.find((x) => x.id === "s3").taskId).toBeNull();
  }, 30_000);

  it("offers only tasks that still take time when adding time", async () => {
    // A submitted task was on the list, and choosing it said "Time added."
    // while recording nothing: the hour typed in was simply gone.
    const seed = twoTasks();
    const t1 = seed.projects[0].tasks[0];
    Object.assign(t1, { state: "submitted", stateAt: t1.createdAt + 3 * HOUR,
                        submittedAt: t1.createdAt + 3 * HOUR });
    const { d } = await openProject(seed, "Acme");
    btn(d, /add time/i).click();
    await settle();
    expect([...field(d.querySelector(".prompt"), "^Task$").options].map((o) => o.textContent))
      .toEqual(["No task", "T-2"]);
  }, 30_000);

  it("says why typed-in time was refused, and keeps what was typed", async () => {
    const { dom, d } = await openProject(twoTasks(), "Acme");
    btn(d, /add time/i).click();
    await settle();
    const [from, to] = d.querySelectorAll('.prompt input[type="datetime-local"]');
    const at = minute(Date.now()) - 30 * HOUR;
    setValue(dom.window, from, stamp(at));
    setValue(dom.window, to, stamp(at + HOUR));
    await settle();
    // The project stops taking time while the form is still open.
    btn(d, /^Open$/).click();
    await settle();
    btn(d, /^Paused$/).click();
    await settle();

    btn(d, /^Add time$/).click();
    await settle();
    expect(d.querySelector(".toast").textContent)
      .toMatch(/Nothing was added\. This project is on hold, so it won't take new time\./);
    expect(d.querySelector(".prompt input[type=\"datetime-local\"]").value).toBe(stamp(at));
    expect(stored(dom).sessions).toHaveLength(2);
  }, 30_000);

  it("says so in the form when the task picked there is handed in meanwhile", async () => {
    const { dom, d } = await openProject(twoTasks(), "Acme");
    btn(d, /add time/i).click();
    await settle();
    setValue(dom.window, field(d.querySelector(".prompt"), "^Task$"), "t2");
    await settle();
    taskRow(d, "T-2").querySelector(".row-check").click();
    await settle();
    btn(d, /^Submit 1$/).click();
    await settle();

    expect(d.querySelector(".prompt .hint.warn").textContent)
      .toMatch(/“T-2” was submitted, so it takes no more time/);
    expect(btn(d, /^Add time$/).disabled).toBe(true);
  }, 30_000);

  it("reads a decimal comma in a task's rate, and refuses what it cannot read", async () => {
    // "12,5" and "-5" both saved as "no rate", without a word, and took the
    // task's own $35 with them.
    const { dom, d } = await openProject(twoTasks(), "Acme");
    await press(taskRow(d, "T-2"), "edit");
    const form = d.querySelector(".prompt");
    const rate = field(form, "Rate for this task");

    setValue(dom.window, rate, "-5");
    await settle();
    expect(form.querySelector(".hint.warn").textContent).toMatch(/can't be below zero/);
    expect(btn(d, /^Save$/).disabled).toBe(true);
    setValue(dom.window, rate, "abc");
    await settle();
    expect(form.querySelector(".hint.warn").textContent).toMatch(/“abc” isn't a rate/);
    rate.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(stored(dom).projects[0].tasks[1].rate).toBe(35);

    setValue(dom.window, rate, "12,5");
    await settle();
    expect(form.querySelector(".hint.warn")).toBeNull();
    btn(d, /^Save$/).click();
    await settle();
    expect(stored(dom).projects[0].tasks[1].rate).toBe(12.5);
  }, 30_000);

  it("refuses to give a task another task's name", async () => {
    // Two tasks could both be "T-b", and the prompt then resolved the name to
    // the first one, leaving the second out of reach by name.
    const { dom, d } = await openProject(twoTasks(), "Acme");
    await press(taskRow(d, "T-2"), "edit");
    const form = d.querySelector(".prompt");
    setValue(dom.window, field(form, "^Name$"), " t-1 ");
    await settle();

    expect(form.querySelector(".hint.warn").textContent)
      .toMatch(/Another task is already called “T-1”/);
    expect(btn(d, /^Save$/).disabled).toBe(true);
    expect(stored(dom).projects[0].tasks.map((t) => t.label)).toEqual(["T-1", "T-2"]);
  }, 30_000);

  it("will not save a session whose end is not after its start", async () => {
    // A session's end moved to before its start previewed and saved the two
    // times swapped round: an hour nobody worked, recorded without a word.
    const seed = twoTasks();
    const [a] = seed.sessions;
    const { dom, d } = await openProject(seed, "Acme");
    await press(ledgerRow(d, "T-1"), "edit");
    const [, end] = d.querySelectorAll('.prompt input[type="datetime-local"]');

    setValue(dom.window, end, stamp(a.segments[0].startedAt - HOUR));
    await settle();
    expect(d.querySelector(".prompt .hint.warn").textContent).toMatch(/It ends before it starts/);
    expect(d.querySelector(".preview-now").textContent).toBe("—");
    expect(btn(d, /Save correction/).disabled).toBe(true);

    setValue(dom.window, end, stamp(a.segments[0].startedAt));
    await settle();
    expect(d.querySelector(".prompt .hint.warn").textContent).toMatch(/would record nothing/);
    expect(btn(d, /Save correction/).disabled).toBe(true);
    expect(stored(dom).sessions.find((x) => x.id === "s1")).toEqual(a);
  }, 30_000);

  it("names a session a correction would run into, and saves only when told to", async () => {
    // A session stretched across the next one saved without a word, and the
    // half hour the two then shared was counted twice.
    const seed = twoTasks();
    const [, b] = seed.sessions;
    const { dom, d } = await openProject(seed, "Acme");
    await press(ledgerRow(d, "T-1"), "edit");
    expect(d.querySelector(".clash")).toBeNull(); // its own time is no clash

    const [, end] = d.querySelectorAll('.prompt input[type="datetime-local"]');
    const stretched = b.segments[0].startedAt + 30 * 60_000;
    setValue(dom.window, end, stamp(stretched));
    await settle();
    expect(d.querySelector(".clash").textContent).toMatch(/overlaps 1 record/);
    expect(d.querySelector(".clash li").textContent).toMatch(/T-2/);
    expect(d.querySelector(".clash-ok").textContent).toMatch(/Save it anyway/);
    expect(btn(d, /Save correction/).disabled).toBe(true);

    d.querySelector(".clash-ok input").click();
    await settle();
    btn(d, /Save correction/).click();
    await settle();
    expect(stored(dom).sessions.find((x) => x.id === "s1").closedAt).toBe(stretched);
  }, 30_000);

  it("will not add earnings without a day to put them on", async () => {
    // Added with the date box cleared, $40 was stored with no date: the week
    // it was earned in read $40 short, and the CSV would have dated it 1970.
    const { dom, d } = await openProject(twoTasks(), "Acme");
    btn(d, /Add earnings/).click();
    await settle();
    const form = d.querySelector(".ern-form");
    setValue(dom.window, field(form, "^Amount"), "40");
    setValue(dom.window, field(form, "^Date$"), "");
    await settle();

    expect(form.querySelector(".hint.warn").textContent).toMatch(/Pick the day it was earned/);
    expect(btn(d, /^Add$/).disabled).toBe(true);
    btn(d, /^Add$/).click();
    await settle();
    expect(stored(dom).earnings ?? []).toHaveLength(0);
  }, 30_000);

  const settingsTag = (d) => [...d.querySelectorAll(".sec-head")]
    .find((h) => /^Settings/.test(h.textContent))?.querySelector(".tag") ?? null;
  const alone = () => ({ projects: [project("a", "Alpha", { currentRate: 50 })], sessions: [] });

  it("keeps unsaved settings through closing the panel and leaving the project", async () => {
    // A rename typed and then "← All projects" went back to the old name
    // without a word, and these boxes used to save on their own, so it is an
    // easy thing to do.
    const { dom, d } = await openProject(alone(), "Alpha");
    btn(d, /^Open$/).click();
    await settle();
    setValue(dom.window, field(d, "Project name"), "Alpha renamed");
    await settle();

    btn(d, /^Close$/).click();
    await settle();
    expect(settingsTag(d).textContent).toBe("Unsaved");

    btn(d, /All projects/).click();
    await settle();
    await toProjects(d, "Work");
    [...d.querySelectorAll(".card")].find((c) => c.textContent.includes("Alpha")).click();
    await settle();
    expect(settingsTag(d).textContent).toBe("Unsaved");
    expect(stored(dom).projects[0].name).toBe("Alpha");

    btn(d, /^Open$/).click();
    await settle();
    expect(field(d, "Project name").value).toBe("Alpha renamed");
    expect(d.querySelector(".savebar").textContent).toMatch(/Unsaved changes/);
    btn(d, /Save changes/).click();
    await settle();
    expect(stored(dom).projects[0].name).toBe("Alpha renamed");
    btn(d, /^Close$/).click();
    await settle();
    expect(settingsTag(d)).toBeNull();
  }, 30_000);

  it("asks before the window closes on settings that are not saved", async () => {
    const { dom, d } = await openProject(alone(), "Alpha");
    const closing = () => {
      const event = new dom.window.Event("beforeunload", { cancelable: true });
      dom.window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(closing()).toBe(false);

    btn(d, /^Open$/).click();
    await settle();
    setValue(dom.window, field(d, "Hourly rate"), "45");
    await settle();
    expect(closing()).toBe(true);

    btn(d, /^Discard$/).click();
    await settle();
    expect(closing()).toBe(false);
  }, 30_000);

  /** One sitting under each kind of task: rejected, with its money
   *  cancelled; accepted, and paid; and one still being worked. */
  const oneOfEach = () => {
    const at = minute(Date.now()) - 9 * HOUR;
    const answered = (state) => ({ state, stateAt: at + 6 * HOUR, submittedAt: at + 5 * HOUR });
    return {
      projects: [project("p1", "Acme", {
        tasks: [
          { id: "tr", label: "T-r", createdAt: at, ...answered("cancelled") },
          { id: "ta", label: "T-a", createdAt: at, ...answered("accepted") },
          { id: "to", label: "T-o", createdAt: at },
        ],
      })],
      sessions: [
        sitting("sr", "p1", "tr", at, at + HOUR, { status: "cancelled" }),
        sitting("sa", "p1", "ta", at + 2 * HOUR, at + 3 * HOUR),
        sitting("so", "p1", "to", at + 4 * HOUR, at + 5 * HOUR),
      ],
    };
  };
  const pick = async (d, label) => {
    ledgerRow(d, label).querySelector(".row-check").click();
    await settle();
  };
  const statusOf = (dom, id) => stored(dom).sessions.find((x) => x.id === id).status;

  it("asks before marking a rejected task's session paid, and marks it once told to", async () => {
    const { dom, d } = await openProject(oneOfEach(), "Acme");
    await pick(d, "T-r");
    btn(d, /^Mark paid$/).click();
    await settle();

    expect(d.querySelector(".selbar").textContent).toMatch(
      /1 of the selected sessions is under a rejected task\. Marking it paid says money came in for work that was turned down\./);
    expect(statusOf(dom, "sr")).toBe("cancelled");

    btn(d, /^Mark paid anyway$/).click();
    await settle();
    expect(statusOf(dom, "sr")).toBeUndefined();
    expect(d.querySelector(".selbar")).toBeNull();
  }, 30_000);

  it("asks before marking an accepted task's session pending, and Cancel leaves it be", async () => {
    const { dom, d } = await openProject(oneOfEach(), "Acme");
    await pick(d, "T-a");
    btn(d, /^Mark pending$/).click();
    await settle();

    expect(d.querySelector(".selbar").textContent).toMatch(
      /1 of the selected sessions is under an accepted task\. Marking it pending says work already accepted is still waiting to be paid\./);
    btn(d, /^Cancel$/).click();
    await settle();
    expect(d.querySelector(".selbar-count").textContent).toBe("1 selected");
    expect(statusOf(dom, "sa")).toBeUndefined();
  }, 30_000);

  it("marks without asking when nothing it touches contradicts a task", async () => {
    const { dom, d } = await openProject(oneOfEach(), "Acme");
    await pick(d, "T-o");
    btn(d, /^Mark pending$/).click();
    await settle();
    expect(statusOf(dom, "so")).toBe("pending");
    expect(d.querySelector(".selbar")).toBeNull();

    // Paid is what an accepted task's sessions already are, so it says nothing.
    await pick(d, "T-a");
    btn(d, /^Mark paid$/).click();
    await settle();
    expect(d.querySelector(".selbar")).toBeNull();
    expect(statusOf(dom, "sa")).toBeUndefined();
  }, 30_000);
});

describe("fixes: found in review", () => {
  const HOUR = 3_600_000;
  const at = Math.floor(Date.now() / 60_000) * 60_000 - 8 * HOUR;
  const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
  const sitting = (id, taskId, from) => ({
    id, projectId: "p1", kind: "billed", taskId, rate: 20, currency: "USD",
    createdAt: from, closedAt: from + HOUR, deletedAt: null,
    segments: [{ startedAt: from, endedAt: from + HOUR }],
  });
  /** One project with two open tasks and a sitting filed under nothing. */
  const seed = (extra = {}) => ({
    projects: [{
      id: "p1", name: "Acme", currentRate: 20, currency: "USD", createdAt: at - 40 * HOUR,
      sessionGoal: null, overallGoal: null,
      tasks: [
        { id: "t1", label: "T-1", createdAt: at },
        { id: "t2", label: "T-2", createdAt: at },
      ],
      ...extra,
    }],
    sessions: [sitting("s1", "t1", at), sitting("s2", "t2", at + 2 * HOUR), sitting("s3", null, at + 4 * HOUR)],
  });
  const open = async (ledger) => {
    const dom = await boot(ledger);
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    return { dom, d };
  };
  const field = (root, label) => [...root.querySelectorAll(".field")]
    .find((f) => new RegExp(label, "i").test(f.querySelector(".eyebrow")?.textContent ?? ""))
    ?.querySelector("input, textarea, select");
  const taskRow = (d, label) => [...d.querySelectorAll(".trow")]
    .find((r) => r.querySelector(".trow-label").textContent.startsWith(label));
  const inPrompt = (d, text) => [...d.querySelectorAll(".prompt button")]
    .find((b) => text.test(b.textContent));
  /** Hands T-2 in from the task list, under whatever form is open. */
  const submitT2 = async (d) => {
    taskRow(d, "T-2").querySelector(".row-check").click();
    await settle();
    btn(d, /^Submit 1$/).click();
    await settle();
  };

  it("keeps a task handed in under the open move prompt in its box", async () => {
    // It left the list when it was submitted, so the box showed "No task"
    // while the warning named T-2, and choosing "No task" changed nothing.
    const { dom, d } = await open(seed());
    [...d.querySelectorAll(".row")]
      .find((r) => r.querySelector(".row-meta")?.textContent.startsWith("No task"))
      .querySelector(".row-check").click();
    await settle();
    btn(d, /Assign to task/).click();
    await settle();
    setValue(dom.window, d.querySelector(".prompt select"), "t2");
    await settle();
    await submitT2(d);

    const select = d.querySelector(".prompt select");
    expect(select.selectedOptions[0].textContent).toBe("T-2");
    expect(select.selectedOptions[0].disabled).toBe(true);
    setValue(dom.window, select, "t1");
    await settle();
    expect(d.querySelector(".prompt .hint.warn")).toBeNull();
    expect(inPrompt(d, /^Move 1 session$/).disabled).toBe(false);
  }, 30_000);

  it("keeps a task handed in under the open Add time form in its box", async () => {
    const { dom, d } = await open(seed());
    btn(d, /add time/i).click();
    await settle();
    setValue(dom.window, field(d.querySelector(".prompt"), "^Task$"), "t2");
    await settle();
    await submitT2(d);

    const select = field(d.querySelector(".prompt"), "^Task$");
    expect(select.selectedOptions[0].textContent).toBe("T-2");
    expect(select.selectedOptions[0].disabled).toBe(true);
    setValue(dom.window, select, "");
    await settle();
    expect(d.querySelector(".prompt .hint.warn")).toBeNull();
  }, 30_000);

  it("reads a task's price as its rate is read, and refuses what is not a price", async () => {
    // The price box was a number box, which hands back nothing for "12,5",
    // and nothing saved as no price at all.
    const ledger = seed({ currentRate: 0, perTask: 50 });
    ledger.projects[0].tasks[1].price = 35;
    const { dom, d } = await open(ledger);
    [...taskRow(d, "T-2").querySelectorAll("button")].find((b) => b.textContent === "edit").click();
    await settle();
    const form = d.querySelector(".prompt");
    const price = field(form, "Per accepted item");
    expect(price.placeholder).toMatch(/the project's price$/);

    setValue(dom.window, price, "30%");
    await settle();
    expect(form.querySelector(".hint.warn").textContent).toMatch(/“30%” isn't a price/);
    expect(inPrompt(d, /^Save$/).disabled).toBe(true);
    setValue(dom.window, price, "-5");
    await settle();
    expect(form.querySelector(".hint.warn").textContent).toMatch(/price can't be below zero/);
    expect(stored(dom).projects[0].tasks[1].price).toBe(35);

    setValue(dom.window, price, "12,5");
    await settle();
    expect(form.querySelector(".hint.warn")).toBeNull();
    inPrompt(d, /^Save$/).click();
    await settle();
    expect(stored(dom).projects[0].tasks[1].price).toBe(12.5);
  }, 30_000);

  it("reads a new task's pay box as it is labelled, and says what it cannot read", async () => {
    // On hourly work with a per-item bonus the box says Rate, but what was
    // typed was saved as the task's item price: 45 meant as $45 an hour gave
    // the task a $45 item price and no rate.
    const { dom, d } = await open(seed({ perTask: 70 }));
    btn(d, /Start the meter/i).click();
    await settle();
    btn(d, /New task/i).click();
    await settle();
    const form = d.querySelector(".prompt");
    setValue(dom.window, field(form, "Name it"), "T-9");
    const pay = field(form, "^Rate$");
    setValue(dom.window, pay, "abc");
    await settle();
    expect(form.querySelector(".hint.warn").textContent).toMatch(/“abc” isn't a rate/);
    expect(inPrompt(d, /Start the meter/i).disabled).toBe(true);

    setValue(dom.window, pay, "45");
    await settle();
    expect(form.querySelector(".hint.warn")).toBeNull();
    inPrompt(d, /Start the meter/i).click();
    await settle();
    const task = stored(dom).projects[0].tasks.find((t) => t.label === "T-9");
    expect(task.rate).toBe(45);
    expect(task).not.toHaveProperty("price");
  }, 30_000);

  it("reads a decimal comma in a new task's price on work paid per item", async () => {
    const { dom, d } = await open(seed({ currentRate: 0, perTask: 50 }));
    btn(d, /Start the meter/i).click();
    await settle();
    btn(d, /New task/i).click();
    await settle();
    const form = d.querySelector(".prompt");
    setValue(dom.window, field(form, "Name it"), "T-9");
    setValue(dom.window, field(form, "Per accepted item"), "12,5");
    await settle();
    expect(form.querySelector(".hint.warn")).toBeNull();
    inPrompt(d, /Start the meter/i).click();
    await settle();
    expect(stored(dom).projects[0].tasks.find((t) => t.label === "T-9").price).toBe(12.5);
  }, 30_000);
});
