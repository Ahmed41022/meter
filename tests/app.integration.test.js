/**
 * Integration tests against the BUILT artifact, not the source. These catch
 * things unit tests structurally cannot: bundling mistakes, event wiring,
 * and CSS that silently fails (an inline element ignoring margin-top, say).
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { JSDOM } from "jsdom";

const DIST = new URL("../dist/meter.html", import.meta.url);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Instruments localStorage before the bundle runs, so tests can assert that
 * the app touches storage a bounded number of times. Reads are the tell for a
 * render loop: the store is meant to load exactly once at startup.
 */
// Patched on the prototype: jsdom's Storage is a Proxy, so assigning
// getItem directly on the instance is silently ignored.
const COUNTER = `<script>
  window.__reads = 0; window.__writes = 0;
  const g = Storage.prototype.getItem, t = Storage.prototype.setItem;
  Storage.prototype.getItem = function (...a) {
    if (a[0] === 'meter:v1') window.__reads++;
    return g.apply(this, a);
  };
  Storage.prototype.setItem = function (...a) {
    if (a[0] === 'meter:v1') window.__writes++;
    return t.apply(this, a);
  };
</script>`;

const boot = async (seed) => {
  let html = readFileSync(DIST, "utf8");
  const preamble = seed
    ? `<script>localStorage.setItem('meter:v1', ${JSON.stringify(JSON.stringify(seed))});</script>${COUNTER}`
    : COUNTER;
  html = html.replace('<div id="root"></div>', `<div id="root"></div>${preamble}`);
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/" });
  await wait(700);
  return dom;
};

const runningSeed = (lastTickAgoMs) => {
  const now = Date.now(), HOUR = 3_600_000;
  return {
    projects: [{ id: "p1", name: "Acme", currentRate: 450, currency: "EGP",
                 createdAt: now - HOUR, sessionGoal: null, overallGoal: null }],
    sessions: [{ id: "s1", projectId: "p1", kind: "billed", rate: 450, currency: "EGP",
                 createdAt: now - HOUR,
                 segments: [{ startedAt: now - HOUR, endedAt: null, lastTick: now - lastTickAgoMs }],
                 closedAt: null, deletedAt: null }],
  };
};

const btn = (d, re) => [...d.querySelectorAll("button")].find((b) => re.test(b.textContent));
const setValue = (win, el, value) => {
  const proto = el.tagName === "SELECT" ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
};

/** Starting now asks for a task first: click Start, answer the prompt, and the
 *  same button confirms. Pass `task` to create a new one on the way in. */
const startMeter = async (dom, { idle = false, task = null, existing = null } = {}) => {
  const { window } = dom, d = window.document;
  const label = idle ? /Start idle/i : /Start the meter/i;
  btn(d, label).click();
  await wait(160);
  if (task !== null) {
    btn(d, /New task/i).click();
    await wait(120);
    setValue(window, d.querySelector(".prompt input"), task);
  } else if (existing !== null) {
    btn(d, /^Existing/i).click();
    await wait(120);
    const select = d.querySelector(".prompt select");
    const option = [...select.options].find((o) => o.textContent === existing);
    setValue(window, select, option.value);
  }
  btn(d, label).click();
  await wait(300);
};

beforeAll(() => {
  if (!existsSync(DIST)) throw new Error("dist/meter.html missing — run `npm run build` first");
});

describe("the built file", () => {
  it("boots with no network access at all", async () => {
    const { window } = await boot();
    expect(window.document.querySelector(".mtr")).not.toBeNull();
    expect(window.document.title).toBe("Meter");
  });

  it("carries its own icons and manifest inline", async () => {
    const html = readFileSync(DIST, "utf8");
    expect(html).toMatch(/rel="icon" type="image\/svg\+xml"/);
    expect(html).toMatch(/rel="manifest" href="data:application\/manifest\+json/);
    expect(html).not.toMatch(/src="http/); // nothing fetched at runtime
  });

  it("stacks card text instead of running it inline", async () => {
    // Regression: card-name and card-meta were <span>s, so margin-top was
    // dropped and the project name ran into the rate on one line.
    const css = readFileSync(DIST, "utf8");
    for (const cls of ["card-name", "card-meta", "card-amt", "card-dur"]) {
      const rule = css.match(new RegExp(`\\.${cls}\\{([^}]*)`));
      expect(rule?.[1], `${cls} must be block`).toContain("display:block");
    }
  });
});

describe("a full session, end to end", () => {
  it("creates a project, runs the meter, and writes a ledger row", async () => {
    const dom = await boot();
    const { window } = dom, d = window.document;

    btn(d, /New project/i).click();
    await wait(120);
    const [name, rate] = d.querySelectorAll("input");
    setValue(window, name, "Acme");
    setValue(window, rate, "450");
    btn(d, /Add project/i).click();
    await wait(180);
    expect(d.querySelector(".card-name").textContent).toContain("Acme");

    d.querySelector(".card").click();
    await wait(150);
    expect(d.querySelector(".state").textContent.trim()).toBe("Stopped");

    await startMeter(dom);
    await wait(1300);
    expect(d.querySelector(".state").textContent.trim()).toBe("Running");
    expect(d.querySelector(".clock-main").textContent).toMatch(/00:00:0[12]/);

    btn(d, /^Pause$/i).click();
    await wait(150);
    expect(d.querySelector(".state").textContent.trim()).toBe("Paused");
    expect(btn(d, /Resume/i)).toBeTruthy();

    btn(d, /Resume/i).click();
    await wait(150);
    expect(d.querySelector(".state").textContent.trim()).toBe("Running");

    btn(d, /Stop and save/i).click();
    await wait(200);
    expect(d.querySelectorAll(".row")).toHaveLength(1);
    expect(d.querySelector(".row-meta").textContent).toContain("2 blocks");

    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.sessions[0].rate).toBe(450);
    expect(saved.sessions[0].closedAt).toBeTruthy();
  }, 20_000);

  it("keeps a recorded session on its original rate when the project rate changes", async () => {
    const dom = await boot();
    const { window } = dom, d = window.document;
    btn(d, /New project/i).click();
    await wait(120);
    const [name, rate] = d.querySelectorAll("input");
    setValue(window, name, "Acme");
    setValue(window, rate, "500");
    btn(d, /Add project/i).click();
    await wait(180);
    d.querySelector(".card").click();
    await wait(150);
    await startMeter(dom);
    await wait(1200);

    btn(d, /^Open$/i).click();
    await wait(150);
    const rateInput = d.querySelectorAll("input[type=number]")[0];
    setValue(window, rateInput, "900");
    rateInput.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
    await wait(220);

    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.projects[0].currentRate).toBe(900);
    expect(saved.sessions[0].rate).toBe(500);
    expect(d.querySelector(".plate-rate").textContent).toContain("rate locked for this session");
  }, 20_000);

  it("undoes a deleted session", async () => {
    const dom = await boot();
    const { window } = dom, d = window.document;
    btn(d, /New project/i).click();
    await wait(120);
    const [name, rate] = d.querySelectorAll("input");
    setValue(window, name, "Acme");
    setValue(window, rate, "450");
    btn(d, /Add project/i).click();
    await wait(180);
    d.querySelector(".card").click();
    await wait(150);
    await startMeter(dom);
    await wait(1100);
    btn(d, /Stop and save/i).click();
    await wait(200);
    expect(d.querySelectorAll(".row")).toHaveLength(1);

    d.querySelector(".x").click();
    await wait(180);
    expect(d.querySelectorAll(".row")).toHaveLength(0);
    expect(d.querySelector(".toast")).not.toBeNull();

    btn(d, /Undo/i).click();
    await wait(180);
    expect(d.querySelectorAll(".row")).toHaveLength(1);
  }, 20_000);
});

describe("crash recovery in the real UI", () => {
  it("offers to bill the last heartbeat instead of an overnight gap", async () => {
    const now = Date.now();
    const started = now - 11 * 3_600_000;
    const lastTick = now - 9 * 3_600_000;
    const dom = await boot({
      projects: [{ id: "p1", name: "Overnight", currentRate: 450, currency: "EGP",
                   createdAt: started, sessionGoal: null, overallGoal: null }],
      sessions: [{ id: "s1", projectId: "p1", rate: 450, currency: "EGP", createdAt: started,
                   segments: [{ startedAt: started, endedAt: null, lastTick }],
                   closedAt: null, deletedAt: null }],
    });
    const { window } = dom, d = window.document;
    const banner = d.querySelector(".banner");
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("Overnight");
    expect(banner.textContent).toMatch(/11h 00m/);  // what the gap would cost
    expect(banner.textContent).toMatch(/2h 00m/);   // what it should cost

    btn(d, /Stop at/i).click();
    await wait(250);
    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    const billed = saved.sessions[0].segments.reduce((a, s) => a + (s.endedAt - s.startedAt), 0);
    expect(billed / 3_600_000).toBeCloseTo(2, 5);
    expect(saved.sessions[0].closedAt).toBe(lastTick);
  }, 20_000);
});

describe("idle time in the real UI", () => {
  const makeProject = async (dom, rate = "450") => {
    const { window } = dom, d = window.document;
    btn(d, /New project/i).click();
    await wait(120);
    const [name, r] = d.querySelectorAll("input");
    setValue(window, name, "Acme");
    setValue(window, r, rate);
    btn(d, /Add project/i).click();
    await wait(180);
    d.querySelector(".card").click();
    await wait(150);
  };

  it("repaints the face so idle can never be mistaken for earnings", async () => {
    const dom = await boot();
    const d = dom.window.document;
    await makeProject(dom);

    await startMeter(dom, { idle: true });
    await wait(1200);
    expect(d.querySelector(".face").className).toContain("idle");
    expect(d.querySelector(".state").textContent.trim()).toBe("Idling");
    expect(d.querySelector(".money-label").textContent).toMatch(/not billed/i);
  }, 20_000);

  it("keeps idle money out of the grand total", async () => {
    const dom = await boot();
    const { window } = dom, d = window.document;
    await makeProject(dom);

    await startMeter(dom, { idle: true });
    await wait(1300);
    btn(d, /Stop idling/i).click();
    await wait(200);

    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.sessions[0].kind).toBe("idle");

    btn(d, /All projects/i).click();
    await wait(200);
    // One idle second recorded, zero billed: the headline total must be empty.
    expect(d.querySelector(".grand-amt").textContent.trim()).toBe("—");
  }, 20_000);

  it("shows the idle row tagged in the ledger", async () => {
    const dom = await boot();
    const d = dom.window.document;
    await makeProject(dom);
    await startMeter(dom, { idle: true });
    await wait(1200);
    btn(d, /Stop idling/i).click();
    await wait(200);
    expect(d.querySelector(".row.is-idle")).not.toBeNull();
    expect(d.querySelector(".tag").textContent.trim()).toBe("Idle");
  }, 20_000);

  it("stops the billed meter when idle starts, so wall-clock time is never double counted", async () => {
    const dom = await boot();
    const { window } = dom, d = window.document;
    await makeProject(dom);

    await startMeter(dom);
    await wait(1200);
    btn(d, /Switch to idle/i).click();
    await wait(300);

    expect(d.querySelector(".state").textContent.trim()).toBe("Idling");
    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    const open = saved.sessions.filter((s) => !s.closedAt);
    expect(open).toHaveLength(1);
    expect(open[0].kind).toBe("idle");
    expect(saved.sessions.find((s) => s.kind === "billed").closedAt).toBeTruthy();
  }, 20_000);

  it("reports the billable share of desk time", async () => {
    const now = Date.now();
    const HOUR = 3_600_000;
    const base = { projectId: "p1", currency: "EGP", rate: 450, deletedAt: null };
    const dom = await boot({
      projects: [{ id: "p1", name: "Acme", currentRate: 450, currency: "EGP",
                   createdAt: now - 9 * HOUR, sessionGoal: null, overallGoal: null }],
      sessions: [
        { ...base, id: "s1", kind: "billed", createdAt: now - 9 * HOUR,
          segments: [{ startedAt: now - 9 * HOUR, endedAt: now - 3 * HOUR }],
          closedAt: now - 3 * HOUR },
        { ...base, id: "i1", kind: "idle", createdAt: now - 3 * HOUR,
          segments: [{ startedAt: now - 3 * HOUR, endedAt: now - 1 * HOUR }],
          closedAt: now - 1 * HOUR },
      ],
    });
    const d = dom.window.document;
    d.querySelector(".card").click();
    await wait(200);

    expect(d.querySelector(".util-pct").textContent.trim()).toBe("75%");
    const legend = d.querySelector(".split-legend").textContent;
    expect(legend).toContain("6h 00m billed");
    expect(legend).toContain("2h 00m idle");
    // 2 idle hours at 450 = 900 unearned
    expect(legend).toMatch(/900\.00/);
  }, 20_000);

  it("treats a session saved before idle existed as billed", async () => {
    const now = Date.now();
    const HOUR = 3_600_000;
    const dom = await boot({
      projects: [{ id: "p1", name: "Legacy", currentRate: 450, currency: "EGP",
                   createdAt: now - 2 * HOUR, sessionGoal: null, overallGoal: null }],
      sessions: [{ id: "old", projectId: "p1", rate: 450, currency: "EGP", // no `kind`
                   createdAt: now - 2 * HOUR,
                   segments: [{ startedAt: now - 2 * HOUR, endedAt: now - HOUR }],
                   closedAt: now - HOUR, deletedAt: null }],
    });
    const d = dom.window.document;
    expect(d.querySelector(".grand-amt").textContent).toMatch(/450\.00/);
    d.querySelector(".card").click();
    await wait(200);
    expect(d.querySelector(".row.is-idle")).toBeNull();
    expect(d.querySelector(".util-pct")).toBeNull(); // no idle time, no split shown
  }, 20_000);
});

describe("startup is bounded", () => {
  /**
   * Regression: `store` was a default parameter, so a new store object was
   * built on every render. The load effect depended on it, re-ran every
   * render, called setState with a freshly parsed object, and re-rendered —
   * a runaway loop. It burned CPU on any launch with saved data, and because
   * each pass re-ran the startup checks, dismissing a startup banner appeared
   * to do nothing.
   */
  it("reads the store once, not once per render", async () => {
    const dom = await boot(runningSeed(5_000));
    const { window } = dom;
    expect(window.__reads).toBe(1);

    const before = window.__reads;
    await wait(1200); // several render ticks while the meter runs
    expect(window.__reads - before).toBe(0);
  }, 20_000);

  it("does not write to storage while merely rendering", async () => {
    const dom = await boot(runningSeed(5_000));
    const { window } = dom;
    const before = window.__writes;
    await wait(1200);
    expect(window.__writes - before).toBe(0);
  }, 20_000);

  it("keeps rendering the live figures while it sits there", async () => {
    // The counterpart to the two above: bounded storage access must not have
    // been achieved by freezing the render loop.
    const dom = await boot(runningSeed(5_000));
    const d = dom.window.document;
    d.querySelector(".card").click();
    await wait(200);
    const first = d.querySelector(".clock-main").textContent;
    await wait(1300);
    expect(d.querySelector(".clock-main").textContent).not.toBe(first);
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
    const dom = await boot(runningSeed(5_000));
    const d = dom.window.document;
    btn(d, /This tab only/i).click();
    await wait(200);
    expect(d.querySelector(".banner")).toBeNull();

    // The bug re-armed it on the very next render. Give it many.
    await wait(1500);
    expect(d.querySelector(".banner")).toBeNull();
  }, 20_000);

  it("leaves the running session alone when dismissed", async () => {
    const dom = await boot(runningSeed(5_000));
    const { window } = dom, d = window.document;
    btn(d, /This tab only/i).click();
    await wait(200);
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
    btn(d, /New project/i).click();
    await wait(120);
    const [name, r] = d.querySelectorAll("input");
    setValue(window, name, "Acme");
    setValue(window, r, rate);
    btn(d, /Add project/i).click();
    await wait(180);
    d.querySelector(".card").click();
    await wait(150);
  };

  it("asks which task before it starts counting", async () => {
    const dom = await boot();
    const d = dom.window.document;
    await makeProject(dom);

    btn(d, /Start the meter/i).click();
    await wait(180);
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
    await wait(900);

    expect(d.querySelector(".state").textContent.trim()).toBe("Running");
    expect(d.querySelector(".task-chip").textContent).toContain("1234");

    btn(d, /Stop and save/i).click();
    await wait(200);
    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.projects[0].tasks[0].label).toBe("1234");
    expect(saved.sessions[0].taskId).toBe(saved.projects[0].tasks[0].id);
  }, 25_000);

  it("reuses a task when the new name only differs by case or whitespace", async () => {
    const dom = await boot();
    const { window } = dom, d = window.document;
    await makeProject(dom);
    await startMeter(dom, { task: "Task-A" });
    await wait(400);
    btn(d, /Stop and save/i).click();
    await wait(200);
    await startMeter(dom, { task: "  task-a  " });
    await wait(400);
    btn(d, /Stop and save/i).click();
    await wait(200);

    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.projects[0].tasks).toHaveLength(1);
    expect(new Set(saved.sessions.map((x) => x.taskId)).size).toBe(1);
  }, 30_000);

  it("offers tasks already created as existing choices", async () => {
    const dom = await boot();
    const d = dom.window.document;
    await makeProject(dom);
    await startMeter(dom, { task: "1234" });
    await wait(400);
    btn(d, /Stop and save/i).click();
    await wait(200);

    btn(d, /Start the meter/i).click();
    await wait(180);
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
    d.querySelector(".card").click();
    await wait(250);

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
    await wait(700);
    btn(d, /Stop and save/i).click();
    await wait(200);
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
    d.querySelector(".card").click();
    await wait(250);
    expect(d.querySelectorAll(".row")).toHaveLength(3);
  }, 25_000);

  it("starts collapsed once the list gets long, so Settings stays reachable", async () => {
    const dom = await boot(ledgerSeed(12));
    const d = dom.window.document;
    d.querySelector(".card").click();
    await wait(250);
    expect(d.querySelectorAll(".row")).toHaveLength(0);
    expect(btn(d, /Ledger/i).textContent).toContain("12 sessions");
    // The point of collapsing: Settings is still on screen.
    expect(btn(d, /^Open$/i)).toBeTruthy();
  }, 25_000);

  it("expands and collapses on demand, keeping the totals visible either way", async () => {
    const dom = await boot(ledgerSeed(12));
    const d = dom.window.document;
    d.querySelector(".card").click();
    await wait(250);
    const header = () => d.querySelectorAll(".sec-head")[
      [...d.querySelectorAll(".sec-head")].findIndex((h) => /Ledger/.test(h.textContent))
    ].textContent;
    expect(header()).toMatch(/5,400\.00/); // 12h at 450

    btn(d, /Ledger/i).click();
    await wait(180);
    expect(d.querySelectorAll(".row")).toHaveLength(12);

    btn(d, /Ledger/i).click();
    await wait(180);
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
    d.querySelector(".card").click();
    await wait(250);
    if (!d.querySelectorAll(".row").length) { btn(d, /Ledger/i).click(); await wait(180); }
    return d;
  };

  it("moves a batch of finished sessions onto a new task", async () => {
    const dom = await boot(seed());
    const { window } = dom;
    const d = await open(dom);

    const boxes = [...d.querySelectorAll(".row-check")];
    boxes[0].click();
    boxes[2].click();
    await wait(180);
    expect(d.querySelector(".selbar-count").textContent).toBe("2 selected");

    btn(d, /Assign to task/i).click();
    await wait(180);
    setValue(window, d.querySelector(".prompt input"), "REPORT-7");
    btn(d, /Move 2 sessions/i).click();
    await wait(300);

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

    d.querySelectorAll(".row-check")[0].click();
    await wait(150);
    btn(d, /Assign to task/i).click();
    await wait(180);
    setValue(window, d.querySelector(".prompt input"), "X-1");
    btn(d, /Move 1 session/i).click();
    await wait(300);

    const after = JSON.parse(window.localStorage.getItem("meter:v1")).sessions.find((s) => s.id === before.id);
    expect(after.segments).toEqual(before.segments);
    expect(after.rate).toBe(before.rate);
    expect(after.closedAt).toBe(before.closedAt);
    expect(after.taskId).not.toBeNull();
  }, 30_000);

  it("corrects a session filed under the wrong task", async () => {
    const tasks = [{ id: "t1", label: "1234", createdAt: Date.now() },
                   { id: "t2", label: "5678", createdAt: Date.now() }];
    const dom = await boot(seed({ tasks, assign: ["t1", "t1", "t1", "t1"] }));
    const { window } = dom;
    const d = await open(dom);

    d.querySelectorAll(".row-check")[1].click();
    await wait(150);
    btn(d, /Assign to task/i).click();
    await wait(180);
    btn(d, /^Existing/i).click();
    await wait(150);
    const select = d.querySelector(".prompt select");
    setValue(window, select, [...select.options].find((o) => o.textContent === "5678").value);
    btn(d, /Move 1 session/i).click();
    await wait(300);

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

    d.querySelectorAll(".row-check")[0].click();
    await wait(150);
    btn(d, /Assign to task/i).click();
    await wait(180);
    btn(d, /^Existing/i).click();
    await wait(150);
    const select = d.querySelector(".prompt select");
    setValue(window, select, [...select.options].find((o) => o.textContent === "5678").value);
    btn(d, /Move 1 session/i).click();
    await wait(350);

    expect(amounts()["1234"]).toMatch(/450\.00/);   // 1h
    expect(amounts()["5678"]).toMatch(/1,350\.00/); // 3h
  }, 30_000);

  it("filters the ledger to one task so a whole group can be checked", async () => {
    const tasks = [{ id: "t1", label: "1234", createdAt: Date.now() },
                   { id: "t2", label: "5678", createdAt: Date.now() }];
    const dom = await boot(seed({ tasks, assign: ["t1", "t2", "t1", null] }));
    const d = await open(dom);

    [...d.querySelectorAll(".trow")].find((r) => r.textContent.includes("5678")).click();
    await wait(250);
    expect(d.querySelectorAll(".row")).toHaveLength(1);
    expect(d.querySelector(".chip").textContent).toContain("5678");

    d.querySelector(".chip").click();
    await wait(200);
    expect(d.querySelectorAll(".row")).toHaveLength(4);
  }, 30_000);

  it("selects every visible row at once", async () => {
    const dom = await boot(seed());
    const d = await open(dom);
    btn(d, /Select all 4/i).click();
    await wait(180);
    expect(d.querySelector(".selbar-count").textContent).toBe("4 selected");
    btn(d, /Deselect all/i).click();
    await wait(180);
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
    await wait(200);
    d.querySelector(".card").click();
    await wait(250);

    expect(d.querySelector(".task-chip").textContent).toContain("1234");
    d.querySelector(".task-chip").click();
    await wait(200);
    const select = d.querySelector(".prompt select");
    setValue(window, select, [...select.options].find((o) => o.textContent === "5678").value);
    btn(d, /^Save$/i).click();
    await wait(300);

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
    d.querySelector(".card").click();
    await wait(250);
    return d;
  };
  const editTask = async (d, label) => {
    const row = [...d.querySelectorAll(".trow")].find((r) => r.textContent.includes(label));
    [...row.querySelectorAll("button")].find((b) => b.textContent === "edit").click();
    await wait(200);
  };

  it("renames a task everywhere at once", async () => {
    const dom = await boot(seed());
    const { window } = dom;
    const d = await open(dom);
    await editTask(d, "1234");

    const [name] = d.querySelectorAll(".prompt input");
    setValue(window, name, "PR review");
    btn(d, /^Save$/i).click();
    await wait(300);

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
    await wait(300);

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
    await wait(300);

    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    const after = saved.sessions.find((s) => s.id === before.id);
    expect(after.segments).toEqual(before.segments);
    expect(after.rate).toBe(100); // the snapshot is the audit trail
    expect(saved.projects[0].tasks.find((t) => t.id === "t1").rate).toBe(90);
  }, 30_000);

  it("marks a repriced session in the ledger", async () => {
    const dom = await boot(seed({ rate: 90 }));
    const d = await open(dom);
    if (!d.querySelectorAll(".row").length) { btn(d, /Ledger/i).click(); await wait(180); }
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
    await wait(300);
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
    await wait(200);
    expect(d.querySelector(".prompt").textContent).toContain("1 session");

    btn(d, /Yes, delete it/i).click();
    await wait(350);

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
    await wait(200);
    btn(d, /Yes, delete it/i).click();
    await wait(300);
    expect(d.querySelector(".toast")).not.toBeNull();

    btn(d, /Undo/i).click();
    await wait(300);
    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.projects[0].tasks).toHaveLength(2);
    expect(saved.sessions.find((s) => s.id === "s1").taskId).toBe("t1");
  }, 30_000);
});
