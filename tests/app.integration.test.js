/**
 * Integration tests against the BUILT artifact, not the source. These catch
 * things unit tests structurally cannot: bundling mistakes, event wiring,
 * and CSS that silently fails (an inline element ignoring margin-top, say).
 * @vitest-environment node
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
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

/**
 * The overall view is what the app opens on, so anything that manages projects
 * switches to the Projects tab first. Idempotent: a no-op when that tab is
 * already showing, or when a project is open and the tabs are replaced by the
 * back link.
 */
const toProjects = async (d, name = "Work") => {
  const tab = [...d.querySelectorAll("[role=tab]")].find((t) => t.textContent === name);
  if (tab && tab.getAttribute("aria-selected") !== "true") {
    tab.click();
    await wait(150);
  }
};
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

/** Walks a directory for the newest mtime. */
const newestMtime = (dir) => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
};

beforeAll(() => {
  if (!existsSync(DIST)) throw new Error("dist/meter.html missing — run `npm run build` first");

  // These tests drive the built file. A build that failed leaves the previous
  // bundle in place, so without this check they would quietly keep passing
  // against stale output and report green on code that doesn't even compile.
  const built = statSync(DIST).mtimeMs;
  const sources = Math.max(
    newestMtime(new URL("../src/", import.meta.url)),
    newestMtime(new URL("../scripts/", import.meta.url))
  );
  if (sources > built) {
    throw new Error(
      "dist/meter.html is older than src/ — the last build failed or was skipped. Run `npm run build`."
    );
  }
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

    await toProjects(d);
    btn(d, /New project/i).click();
    await wait(120);
    const [name, rate] = d.querySelectorAll("input");
    setValue(window, name, "Acme");
    setValue(window, rate, "450");
    btn(d, /Add project/i).click();
    await wait(180);
    expect(d.querySelector(".card-name").textContent).toContain("Acme");

    await toProjects(d);
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
    await toProjects(d);
    btn(d, /New project/i).click();
    await wait(120);
    const [name, rate] = d.querySelectorAll("input");
    setValue(window, name, "Acme");
    setValue(window, rate, "500");
    btn(d, /Add project/i).click();
    await wait(180);
    await toProjects(d);
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
    await toProjects(d);
    btn(d, /New project/i).click();
    await wait(120);
    const [name, rate] = d.querySelectorAll("input");
    setValue(window, name, "Acme");
    setValue(window, rate, "450");
    btn(d, /Add project/i).click();
    await wait(180);
    await toProjects(d);
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
    await toProjects(d);
    btn(d, /New project/i).click();
    await wait(120);
    const [name, r] = d.querySelectorAll("input");
    setValue(window, name, "Acme");
    setValue(window, r, rate);
    btn(d, /Add project/i).click();
    await wait(180);
    await toProjects(d);
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
    await toProjects(d);
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
    await toProjects(d);
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
    await toProjects(d);
    expect(d.querySelector(".grand-amt").textContent).toMatch(/450\.00/);
    await toProjects(d);
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
    await toProjects(d);
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
    await toProjects(d);
    btn(d, /New project/i).click();
    await wait(120);
    const [name, r] = d.querySelectorAll("input");
    setValue(window, name, "Acme");
    setValue(window, r, rate);
    btn(d, /Add project/i).click();
    await wait(180);
    await toProjects(d);
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
    await toProjects(d);
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
    await toProjects(d);
    d.querySelector(".card").click();
    await wait(250);
    expect(d.querySelectorAll(".row")).toHaveLength(3);
  }, 25_000);

  it("starts collapsed once the list gets long, so Settings stays reachable", async () => {
    const dom = await boot(ledgerSeed(12));
    const d = dom.window.document;
    await toProjects(d);
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
    await toProjects(d);
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
    await toProjects(d);
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
    await toProjects(d);
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
    await toProjects(d);
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
    await wait(250);
    if (!d.querySelectorAll(".row").length) { btn(d, /Ledger/i).click(); await wait(180); }
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
    await wait(200);
    setValue(window, d.querySelectorAll(".prompt input")[1], stamp(data.__start + 2 * HOUR));
    await wait(150);
    // The preview shows the new figure before anything is committed.
    expect(d.querySelector(".preview-now").textContent).toContain("2h 00m");
    expect(d.querySelector(".preview-was").textContent).toContain("9h 00m");

    btn(d, /Save correction/i).click();
    await wait(300);

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
    await wait(200);
    setValue(window, d.querySelectorAll(".prompt input")[1], stamp(data.__start + 2 * HOUR));
    btn(d, /Save correction/i).click();
    await wait(300);
    expect(d.querySelector(".row-amt").textContent).toMatch(/900\.00/);

    btn(d, /^edit$/i).click();
    await wait(200);
    btn(d, /Undo correction/i).click();
    await wait(300);

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
    await wait(200);
    setValue(window, d.querySelectorAll(".prompt input")[1], stamp(data.__start + 2 * HOUR));
    btn(d, /Save correction/i).click();
    await wait(300);

    expect(d.querySelector(".toast")).not.toBeNull();
    btn(d, /Undo/i).click();
    await wait(300);
    expect(d.querySelector(".row-amt").textContent).toMatch(/4,050\.00/);
  }, 30_000);

  it("feeds the corrected hours into the project total", async () => {
    const data = seed();
    const dom = await boot(data);
    const { window } = dom;
    const d = await open(dom);
    btn(d, /^edit$/i).click();
    await wait(200);
    setValue(window, d.querySelectorAll(".prompt input")[1], stamp(data.__start + 2 * HOUR));
    btn(d, /Save correction/i).click();
    await wait(300);

    btn(d, /All projects/i).click();
    await wait(250);
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
    await wait(200);
    await toProjects(d);
    d.querySelector(".card").click();
    await wait(250);
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

  it("opens on the overall view, not the project list", async () => {
    const { document: d } = (await boot()).window;
    const overview = [...d.querySelectorAll("[role=tab]")]
      .find((t) => t.textContent === "Overview");
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect([...d.querySelectorAll(".segmented .seg")].map((s) => s.textContent))
      .toEqual(["Day", "Week", "Month"]);
    // Work and Life are places of their own, not sections of one list.
    expect([...d.querySelectorAll(".tabs [role=tab]")].map((t) => t.textContent))
      .toEqual(["Overview", "Work", "Life"]);
  });

  it("switches to the project list and back without losing either view", async () => {
    const { document: d } = (await boot()).window;
    await toProjects(d);
    expect(btn(d, /New project/i)).toBeTruthy();
    expect(d.querySelector(".segmented")).toBeNull();

    [...d.querySelectorAll("[role=tab]")].find((t) => t.textContent === "Overview").click();
    await wait(170);
    expect(d.querySelector(".segmented")).not.toBeNull();
  });

  it("reports what today earned, in time and in money", async () => {
    // Two hours at 450 is 900, and it must read the same in both places.
    const dom = await boot({
      projects: [project("p1", "Acme")],
      sessions: [block("s1", "p1", dayStart() + HOUR, dayStart() + 3 * HOUR)],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await wait(220);

    expect(d.querySelector(".grand-amt").textContent).toMatch(/900\.00/);
    expect(tileValue(d, "Billed")).toBe("2h 00m");
  }, 20_000);

  it("counts a session that ran past midnight in both days, not once in either", async () => {
    // The figure the whole reporting layer exists to get right. 23:30 to 00:30
    // is half an hour of yesterday and half an hour of today, and filing it
    // whole under either day would move money onto the wrong date.
    const dom = await boot({
      projects: [project("p1", "Acme")],
      sessions: [block("s1", "p1", dayStart(1) + 23 * HOUR + 30 * MIN, dayStart() + 30 * MIN)],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await wait(220);

    expect(tileValue(d, "Billed")).toBe("30m");   // today's half
    d.querySelectorAll(".step")[0].click();        // step back to yesterday
    await wait(240);
    expect(tileValue(d, "Billed")).toBe("30m");   // yesterday's half
  }, 20_000);

  it("steps back through periods and refuses to step into the future", async () => {
    const dom = await boot({
      projects: [project("p1", "Acme")],
      sessions: [block("s1", "p1", dayStart(1) + 9 * HOUR, dayStart(1) + 10 * HOUR)],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await wait(220);

    const [back, forward] = d.querySelectorAll(".step");
    expect(forward.disabled).toBe(true);   // nothing is recorded ahead of now
    expect(d.querySelector(".grand-amt").textContent).toContain("—");

    back.click();
    await wait(240);
    expect(d.querySelector(".grand").textContent).toMatch(/Yesterday/);
    expect(d.querySelector(".grand-amt").textContent).toMatch(/450\.00/);
    expect(d.querySelectorAll(".step")[1].disabled).toBe(false);
  }, 20_000);

  it("keeps idle time out of the money while still reporting it", async () => {
    const dom = await boot({
      projects: [project("p1", "Acme")],
      sessions: [
        block("s1", "p1", dayStart() + HOUR, dayStart() + 2 * HOUR),
        block("s2", "p1", dayStart() + 2 * HOUR, dayStart() + 3 * HOUR, { kind: "idle" }),
      ],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await wait(220);

    // One billed hour only, though two hours were spent at the desk.
    expect(d.querySelector(".grand-amt").textContent).toMatch(/450\.00/);
    expect(tileValue(d, "Billed")).toBe("1h 00m");
    expect(tileValue(d, "Idle")).toBe("1h 00m");
    expect(tileValue(d, "Billed share")).toBe("50%");
  }, 20_000);

  it("compares against the period before and names it", async () => {
    const dom = await boot({
      projects: [project("p1", "Acme")],
      sessions: [
        block("s1", "p1", dayStart() + HOUR, dayStart() + 3 * HOUR),     // 2h today
        block("s2", "p1", dayStart(1) + HOUR, dayStart(1) + 2 * HOUR),   // 1h yesterday
      ],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await wait(220);

    const deltas = [...d.querySelectorAll(".delta")].map((x) => x.textContent);
    expect(deltas.some((t) => /\+100%/.test(t))).toBe(true);
    expect(deltas.some((t) => /yesterday/.test(t))).toBe(true);
  }, 20_000);

  it("draws one trend bar per hour of the day and marks the worked one", async () => {
    const dom = await boot({
      projects: [project("p1", "Acme")],
      sessions: [block("s1", "p1", dayStart() + 9 * HOUR, dayStart() + 10 * HOUR)],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await wait(220);

    expect(d.querySelectorAll(".tcol")).toHaveLength(24);
    expect(d.querySelectorAll(".tseg.billed")).toHaveLength(1);
    // Every bar states its own figure, so identity never rests on colour alone.
    const filled = [...d.querySelectorAll(".tcol")].find((c) => c.querySelector(".tseg.billed"));
    expect(filled.getAttribute("aria-label")).toMatch(/1h 00m billed/);
  }, 20_000);

  it("says so plainly when a period recorded nothing", async () => {
    const dom = await boot({ projects: [project("p1", "Acme")], sessions: [] });
    const { document: d } = dom.window;
    btn(d, /^Week$/).click();
    await wait(220);
    expect(d.querySelector(".panel .empty")).not.toBeNull();
    expect(d.querySelectorAll(".tcol")).toHaveLength(0);
  }, 20_000);

  it("gives a week seven bars and a month one per day", async () => {
    const dom = await boot({
      projects: [project("p1", "Acme")],
      sessions: [block("s1", "p1", dayStart() + HOUR, dayStart() + 2 * HOUR)],
    });
    const { document: d } = dom.window;
    btn(d, /^Week$/).click();
    await wait(220);
    expect(d.querySelectorAll(".tcol")).toHaveLength(7);

    btn(d, /^Month$/).click();
    await wait(220);
    const today = new Date();
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    expect(d.querySelectorAll(".tcol")).toHaveLength(daysInMonth);
  }, 25_000);

  it("breaks the period down by project, busiest first, and opens one on click", async () => {
    const dom = await boot({
      projects: [project("p1", "Acme"), project("p2", "Beta")],
      sessions: [
        block("s1", "p1", dayStart() + HOUR, dayStart() + 2 * HOUR),                 // 1h
        block("s2", "p2", dayStart() + 2 * HOUR, dayStart() + 5 * HOUR),             // 3h
      ],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await wait(220);

    const rows = [...d.querySelectorAll(".prow")];
    expect(rows.map((r) => r.querySelector(".prow-name").textContent)).toEqual(["Beta", "Acme"]);
    expect(rows[0].querySelector(".prow-amt").textContent).toMatch(/1,350\.00/); // 3h at 450

    rows[0].click();
    await wait(260);
    // Opening a project from the overall view lands on that project's meter.
    expect(d.querySelector(".plate-name").textContent).toBe("Beta");
  }, 20_000);

  it("keeps every project bar inside its track, whatever the idle mix", async () => {
    // Regression: the rows are ordered by BILLED time, so the first row is not
    // necessarily the longest overall. Scaling every bar to it let a row below
    // with more idle time compute a width above 100% and overrun its track.
    const dom = await boot({
      projects: [project("p1", "Mostly billed"), project("p2", "Mostly idle")],
      sessions: [
        block("s1", "p1", dayStart() + HOUR, dayStart() + 4 * HOUR),                        // 3h billed
        block("s2", "p2", dayStart() + 4 * HOUR, dayStart() + 6 * HOUR),                    // 2h billed
        block("s3", "p2", dayStart() + 6 * HOUR, dayStart() + 11 * HOUR, { kind: "idle" }), // 5h idle
      ],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await wait(220);

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
    const dom = await boot({
      projects: [project("p1", "Acme"), project("p2", "Dormant")],
      sessions: [block("s1", "p1", dayStart() + HOUR, dayStart() + 2 * HOUR)],
    });
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await wait(220);
    expect([...d.querySelectorAll(".prow-name")].map((n) => n.textContent)).toEqual(["Acme"]);
  }, 20_000);

  it("counts a session still running up to the current second", async () => {
    const now = Date.now();
    const dom = await boot({
      projects: [project("p1", "Acme")],
      sessions: [{
        id: "s1", projectId: "p1", kind: "billed", taskId: null, rate: 450, currency: "EGP",
        createdAt: now - HOUR, segments: [{ startedAt: now - HOUR, endedAt: null, lastTick: now }],
        closedAt: null, deletedAt: null,
      }],
    });
    const { document: d } = dom.window;
    btn(d, /This tab only/i).click();
    await wait(220);
    btn(d, /^Day$/).click();
    await wait(220);
    // An hour so far, and it is already in the earned figure.
    expect(d.querySelector(".grand-amt").textContent).toMatch(/450\.[0-9]/);
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
    const dom = await boot(seed(true));
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await wait(220);

    expect(d.querySelector(".grand-amt").textContent).toMatch(/100\.00/); // the one paid hour
    expect(tileValue(d, "Billed")).toBe("1h 00m");
    expect(tileValue(d, "Billed share")).toBe("100%");
    expect(tileValue(d, "Active hours")).toBe("1");
  }, 20_000);

  it("is what the rate hack could not do — the same data unflagged inflates everything", async () => {
    // Left as an ordinary project, those eight hours land in billed time and
    // in the breakdown no matter how small the rate is. This is the before.
    const dom = await boot(seed(false));
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await wait(220);

    expect(tileValue(d, "Billed")).toBe("9h 00m");
    expect([...d.querySelectorAll(".prow-name")].map((n) => n.textContent))
      .toEqual(["Life", "Acme"]);
  }, 20_000);

  it("reports off-clock time in its own panel instead of dropping it", async () => {
    const dom = await boot(seed(true));
    const { document: d } = dom.window;
    btn(d, /^Day$/).click();
    await wait(220);

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
    const dom = await boot(seed(true));
    const { document: d } = dom.window;
    await toProjects(d);
    expect(d.querySelector(".grand-amt").textContent).toMatch(/100\.00/);
    // Work lists only work; Life is a tab of its own.
    expect([...d.querySelectorAll(".card-name")].map((n) => n.textContent)).toEqual(["Acme"]);
    await toProjects(d, "Life");
    expect(d.querySelector(".card.off .card-name").textContent).toContain("Life");
  }, 20_000);

  it("shows elapsed time rather than a meaningless zero on the meter face", async () => {
    const dom = await boot(seed(true));
    const { document: d } = dom.window;
    await toProjects(d, "Life");
    d.querySelector(".card.off").click();
    await wait(250);

    expect(d.querySelector(".plate-name").textContent).toBe("Life");
    expect(d.querySelector(".plate-rate").textContent).toMatch(/off the clock/i);
    // the headline figure is a duration, not 0.00
    expect(d.querySelector(".money-head").textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  }, 20_000);

  it("moves a project off the clock from its settings, and back again", async () => {
    const dom = await boot(seed(false));
    const { document: d } = dom.window;
    await toProjects(d);
    [...d.querySelectorAll(".card-name")].find((n) => n.textContent.includes("Life"))
      .closest(".card").click();
    await wait(250);

    btn(d, /^Open$/i).click();
    await wait(200);
    btn(d, /Off the clock/i).click();
    await wait(250);

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.projects.find((p) => p.id === "p2").offClock).toBe(true);
    // the recorded hours are untouched — only how they are counted changed
    expect(saved.sessions.find((s) => s.id === "s2").segments)
      .toEqual(seed(false).sessions[1].segments);

    btn(d, /Paid work/i).click();
    await wait(250);
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
    await wait(250);
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
    await wait(200);
    const seg = [...d.querySelectorAll(".seg-btn")]
      .filter((b) => /Paid work|Off the clock/.test(b.textContent));
    expect(seg).toHaveLength(2);
    expect(seg.find((b) => /Off the clock/.test(b.textContent)).getAttribute("aria-selected"))
      .toBe("true");
  }, 20_000);

  it("offers only a time goal, since nothing here can earn", async () => {
    const { d } = await open(true);
    btn(d, /^Open$/i).click();
    await wait(200);
    const selects = [...d.querySelectorAll("select")];
    expect(selects.some((s) => [...s.options].some((o) => /Money earned/.test(o.textContent))))
      .toBe(false);
  }, 20_000);
});

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
    await wait(250);
    btn(d, /All projects/i).click();
    await wait(250);
    // back on Life, not thrown to Work
    expect([...d.querySelectorAll(".card-name")].map((n) => n.textContent)).toEqual(["Sleep"]);
  }, 20_000);

  it("adds a life area with no rate to invent", async () => {
    // Demanding a rate for something that cannot earn is what produced 0.00001.
    const dom = await boot(seed);
    const d = dom.window.document;
    await toProjects(d, "Life");
    btn(d, /New area/i).click();
    await wait(150);
    expect(d.querySelectorAll("input[type=number]")).toHaveLength(0);

    setValue(dom.window, d.querySelector(".panel input"), "Reading");
    btn(d, /Add area/i).click();
    await wait(250);

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
    const dom = await boot(seed(objectives));
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await wait(250);
    return { dom, d };
  };

  it("adds one and keeps it after a reload", async () => {
    const { dom, d } = await openAcme([]);
    btn(d, /New objective/i).click();
    await wait(150);
    setValue(dom.window, d.querySelector(".obj-form input"), "Finish the report");
    btn(d, /^Add$/).click();
    await wait(250);

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
    await wait(250);
    expect(d.querySelector(".obj").className).toMatch(/done/);
    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.objectives[0].done).toBe(true);
    expect(saved.objectives[0].doneAt).toBeGreaterThan(0);
  }, 20_000);

  it("picks one for today and shows it on the Overview", async () => {
    const { dom, d } = await openAcme([objective("o1", "p1", "Ship it")]);
    btn(d, /^today$/).click();
    await wait(250);
    expect(JSON.parse(dom.window.localStorage.getItem("meter:v1")).objectives[0].focusedOn)
      .toBe(todayKey());

    btn(d, /All projects/i).click();
    await wait(200);
    [...d.querySelectorAll(".tabs [role=tab]")].find((t) => t.textContent === "Overview").click();
    await wait(250);

    const heads = [...d.querySelectorAll(".sec-head")].map((h) => h.textContent);
    expect(heads.some((t) => /Today/.test(t))).toBe(true);
    expect(d.querySelector(".obj-text").textContent).toBe("Ship it");
  }, 25_000);

  it("gathers today's picks from work and life alike", async () => {
    const key = todayKey();
    const dom = await boot(seed([
      objective("o1", "p1", "Ship it", { focusedOn: key }),
      objective("o2", "p2", "Bed by midnight", { focusedOn: key }),
      objective("o3", "p1", "Not today"),
    ]));
    const d = dom.window.document;
    await wait(150);
    expect([...d.querySelectorAll(".obj-text")].map((n) => n.textContent))
      .toEqual(["Ship it", "Bed by midnight"]);
  }, 20_000);

  it("drops an item off today once it is ticked, leaving what is left", async () => {
    const dom = await boot(seed([
      objective("o1", "p1", "Ship it", { focusedOn: todayKey() }),
      objective("o2", "p1", "And this", { focusedOn: todayKey() }),
    ]));
    const d = dom.window.document;
    await wait(150);
    expect(d.querySelectorAll(".obj")).toHaveLength(2);
    d.querySelector(".obj-check input").click();
    await wait(250);
    expect([...d.querySelectorAll(".obj-text")].map((n) => n.textContent)).toEqual(["And this"]);
  }, 20_000);

  it("calls it a to-do on something off the clock", async () => {
    const dom = await boot(seed([objective("o1", "p2", "Bed by midnight")]));
    const d = dom.window.document;
    await toProjects(d, "Life");
    d.querySelector(".card").click();
    await wait(250);
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
    await wait(200);
    btn(d, /^Delete$/).click();
    await wait(200);
    btn(d, /Yes, delete it/i).click();
    await wait(300);

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.objectives[0].text).toBe("Ship it");
    expect(saved.objectives[0].taskId).toBeNull();
  }, 25_000);

  it("counts what is left on the project card", async () => {
    const dom = await boot(seed([
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
    await wait(250);
    btn(d, /add time/i).click();
    await wait(200);
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
    await wait(200);
    expect(d.querySelector(".preview-now").textContent).toMatch(/3h 00m/);
    expect(d.querySelector(".preview-now").textContent).toMatch(/300\.00/);

    btn(d, /^Add time$/).click();
    await wait(300);

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.sessions).toHaveLength(1);
    expect(saved.sessions[0]).toMatchObject({ manual: true, rate: 100, kind: "billed" });
    expect(saved.sessions[0].closedAt).toBe(dayStart(1) + 12 * HOUR);
  }, 25_000);

  it("marks it in the ledger as added rather than measured", async () => {
    // A block you typed is different evidence from one the clock watched.
    const { dom, d } = await openForm();
    setWindow(dom, d, dayStart(1) + 9 * HOUR, dayStart(1) + 10 * HOUR);
    await wait(200);
    btn(d, /^Add time$/).click();
    await wait(300);
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
    await wait(200);
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await wait(250);
    btn(d, /add time/i).click();
    await wait(200);
    // a window well clear of the running session
    setWindow(dom, d, dayStart(3) + 9 * HOUR, dayStart(3) + 10 * HOUR);
    await wait(200);
    btn(d, /^Add time$/).click();
    await wait(300);

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.sessions.find((s) => s.id === "live").closedAt).toBeNull();
    expect(d.querySelector(".state").textContent.trim()).toBe("Running");
  }, 30_000);

  it("refuses to double-count an hour until you say so explicitly", async () => {
    // The meter cannot produce two overlapping records; this is the only way,
    // so it is named rather than silently accepted.
    const { dom, d } = await openForm([block("old", dayStart(1) + 9 * HOUR, dayStart(1) + 12 * HOUR)]);
    setWindow(dom, d, dayStart(1) + 11 * HOUR, dayStart(1) + 13 * HOUR);
    await wait(200);

    expect(d.querySelector(".clash")).not.toBeNull();
    expect(d.querySelector(".clash").textContent).toMatch(/overlaps 1 record/);
    expect(btn(d, /^Add time$/).disabled).toBe(true);

    d.querySelector(".clash-ok input").click();
    await wait(200);
    expect(btn(d, /^Add time$/).disabled).toBe(false);
    btn(d, /^Add time$/).click();
    await wait(300);
    expect(JSON.parse(dom.window.localStorage.getItem("meter:v1")).sessions).toHaveLength(2);
  }, 25_000);

  it("does not complain about blocks that merely meet end to end", async () => {
    const { dom, d } = await openForm([block("old", dayStart(1) + 9 * HOUR, dayStart(1) + 12 * HOUR)]);
    setWindow(dom, d, dayStart(1) + 12 * HOUR, dayStart(1) + 13 * HOUR);
    await wait(200);
    expect(d.querySelector(".clash")).toBeNull();
    expect(btn(d, /^Add time$/).disabled).toBe(false);
  }, 25_000);

  it("re-arms the warning when the window changes again", async () => {
    const { dom, d } = await openForm([block("old", dayStart(1) + 9 * HOUR, dayStart(1) + 12 * HOUR)]);
    setWindow(dom, d, dayStart(1) + 10 * HOUR, dayStart(1) + 11 * HOUR);
    await wait(200);
    d.querySelector(".clash-ok input").click();
    await wait(150);
    expect(btn(d, /^Add time$/).disabled).toBe(false);

    // moving it somewhere else should not inherit the previous confirmation
    setWindow(dom, d, dayStart(1) + 10 * HOUR, dayStart(1) + 11.5 * HOUR);
    await wait(200);
    expect(btn(d, /^Add time$/).disabled).toBe(true);
  }, 25_000);

  it("files it under a task and counts it toward that task's total", async () => {
    const { dom, d } = await openForm();
    setWindow(dom, d, dayStart(1) + 9 * HOUR, dayStart(1) + 11 * HOUR);
    await wait(200);
    const taskSelect = d.querySelector(".prompt select");
    setValue(dom.window, taskSelect, "t1");
    await wait(150);
    btn(d, /^Add time$/).click();
    await wait(300);

    expect(JSON.parse(dom.window.localStorage.getItem("meter:v1")).sessions[0].taskId).toBe("t1");
    expect(d.querySelector(".trow-time").textContent).toMatch(/2h 00m/);
  }, 25_000);

  it("can log idle time after the fact too", async () => {
    const { dom, d } = await openForm();
    setWindow(dom, d, dayStart(1) + 9 * HOUR, dayStart(1) + 10 * HOUR);
    await wait(200);
    const selects = [...d.querySelectorAll(".prompt select")];
    setValue(dom.window, selects[selects.length - 1], "idle");
    await wait(200);
    // idle earns nothing, so the preview drops the money
    expect(d.querySelector(".preview-now").textContent).not.toMatch(/\$/);
    btn(d, /^Add time$/).click();
    await wait(300);
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
    await wait(250);
    return { dom, d };
  };

  it("links an existing objective to a task after the fact", async () => {
    // The usual order is backwards: you write the objective first and only
    // create the task when you actually start timing it.
    const { dom, d } = await open([task], [objective()]);
    expect(d.querySelector(".obj-meta").textContent).toMatch(/not timed/);

    btn(d, /^edit$/).click();
    await wait(200);
    const select = [...d.querySelectorAll(".obj-form select")][0];
    setValue(dom.window, select, "t1");
    await wait(150);
    btn(d, /^Save$/).click();
    await wait(250);

    expect(JSON.parse(dom.window.localStorage.getItem("meter:v1")).objectives[0].taskId)
      .toBe("t1");
    // and it immediately reports the hours already on that task
    expect(d.querySelector(".obj-meta").textContent).toMatch(/spent 2h 00m/);
  }, 25_000);

  it("adds an estimate later, turning a plain item into a measured one", async () => {
    const { dom, d } = await open([task], [objective({ taskId: "t1" })]);
    btn(d, /^edit$/).click();
    await wait(200);
    setValue(dom.window, d.querySelector('.obj-form input[type="number"]'), "1");
    btn(d, /^Save$/).click();
    await wait(250);

    expect(d.querySelector(".obj-meta").textContent).toMatch(/est 1h 00m/);
    expect(d.querySelector(".obj-verdict").textContent).toMatch(/200% of estimate/);
  }, 25_000);

  it("unlinks again without touching the recorded hours", async () => {
    const { dom, d } = await open([task], [objective({ taskId: "t1" })]);
    btn(d, /^edit$/).click();
    await wait(200);
    setValue(dom.window, [...d.querySelectorAll(".obj-form select")][0], "");
    btn(d, /^Save$/).click();
    await wait(250);

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.objectives[0].taskId).toBeNull();
    expect(saved.sessions[0].segments[0].endedAt).toBe(dayStart() + 2 * HOUR);
  }, 25_000);

  it("renames it without losing the link or the estimate", async () => {
    const { dom, d } = await open([task], [objective({ taskId: "t1", estimateMs: HOUR })]);
    btn(d, /^edit$/).click();
    await wait(200);
    setValue(dom.window, d.querySelector('.obj-form input[type="text"], .obj-form .inp'), "Ship it properly");
    btn(d, /^Save$/).click();
    await wait(250);

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1")).objectives[0];
    expect(saved.text).toBe("Ship it properly");
    expect(saved.taskId).toBe("t1");
    expect(saved.estimateMs).toBe(HOUR);
  }, 25_000);

  it("explains the empty picker when the project has no tasks yet", async () => {
    // Rather than hiding the field, so it is somewhere you have already looked.
    const { d } = await open([], [objective()]);
    btn(d, /^edit$/).click();
    await wait(200);
    expect(d.querySelector(".obj-form").textContent).toMatch(/No tasks on this project yet/);
  }, 25_000);
});
