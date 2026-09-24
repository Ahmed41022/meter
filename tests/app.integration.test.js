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
    // Asks about THIS banner rather than "no banners at all": an unrelated
    // notice, such as the backup nudge, may legitimately be on screen, and the
    // bug this guards against was the conflict notice re-arming itself.
    const conflict = (d) => [...d.querySelectorAll(".banner")]
      .find((b) => /Already running/.test(b.textContent));
    const dom = await boot(runningSeed(5_000));
    const d = dom.window.document;
    expect(conflict(d)).toBeTruthy();
    btn(d, /This tab only/i).click();
    await wait(200);
    expect(conflict(d)).toBeUndefined();

    // The bug re-armed it on the very next render. Give it many.
    await wait(1500);
    expect(conflict(d)).toBeUndefined();
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
    expect([...d.querySelectorAll(".dash-head .segmented .seg")].map((s) => s.textContent))
      .toEqual(["Day", "Week", "Month", "Year", "All"]);
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
    const dom = await boot(seed);
    await wait(150);
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
    await wait(200);
    d.querySelector(".step").click(); // step back a month
    await wait(250);

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
    await wait(250);
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
    await wait(250);

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
    await wait(250);
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
    const dom = await boot(seed);
    await wait(150);
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
      sessions: [block("a", "p1", dayStart(3) + 23.5 * HOUR, dayStart(2) + 2.5 * HOUR)],
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
    await wait(150);
    expect(read()).toMatch(/4h 00m/);
    expect(read()).toMatch(new RegExp(String(new Date(dayStart(3)).getDate())));

    // an empty day says so, rather than reading as nothing at all
    cell(d, dayStart(4)).dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
    await wait(150);
    expect(read()).toMatch(/no billed/);

    // and the summary comes back when the pointer leaves
    d.querySelector(".hm-grid").dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true }));
    await wait(150);
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
    await wait(250);
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
    await wait(200);
    d.querySelector(".step").click();
    await wait(250);
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
    const dom = await boot(seed);
    await wait(150);
    return { dom, d: dom.window.document };
  };
  const crows = (d) => [...d.querySelectorAll(".crow")].map((r) => r.textContent);

  it("totals every project belonging to one company", async () => {
    const { d } = await open({
      projects: [
        project("a", { name: "Pref", company: "Outlier" }),
        project("b", { name: "Reviews", company: "Outlier" }),
        project("c", { name: "Aether", company: "Aether Labs", currentRate: 10 }),
      ],
      sessions: [block("s1", "a", 2), block("s2", "b", 3), block("s3", "c", 4, 0, 10)],
    });
    const rows = crows(d);
    expect(rows[0]).toMatch(/Outlier/);
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
        project("a", { company: "Outlier" }),
        project("b", { company: "Aether Labs" }),
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
      projects: [project("a", { company: "Outlier" })],
      sessions: [block("s1", "a", 2)],
    });
    expect(d.querySelector(".crow")).toBeNull();
  }, 25_000);

  it("never counts sleep as unassigned revenue", async () => {
    const { d } = await open({
      projects: [
        project("a", { company: "Outlier" }),
        project("b", { company: "Aether Labs" }),
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
    await wait(200);
    expect([...d.querySelectorAll(".card")].some((c) => /Finished/.test(c.textContent))).toBe(true);
  }, 30_000);

  it("refuses new time until it is reopened, and says so", async () => {
    const { d } = await open({
      projects: [project("b", { name: "Finished", status: "done", statusAt: dayStart(2) })],
      sessions: [block("s2", "b", 3, 1)],
    });
    await toProjects(d, "Work");
    d.querySelector(".done-head").click();
    await wait(200);
    d.querySelector(".card").click();
    await wait(250);

    expect(btn(d, /Start the meter/i)).toBeUndefined();
    expect(btn(d, /add time/i)).toBeUndefined();
    expect(d.querySelector(".face").textContent).toMatch(/take new time/);

    btn(d, /Reopen this project/i).click();
    await wait(300);
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
    await wait(200);
    d.querySelector(".card").click();
    await wait(250);

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
    const dom = await boot(seed);
    await wait(150);
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
    await wait(250);

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
    await wait(250);

    btn(d, /Add earnings/i).click();
    await wait(200);
    setValue(dom.window, d.querySelector('.ern-form input[type="number"]'), "250");
    await wait(150);
    btn(d, /^Add$/).click();
    await wait(300);

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
    await wait(250);
    await startMeter(dom, { task: "Batch 1" });

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.sessions[0].status).toBe("pending");
  }, 30_000);

  it("settles a batch of sessions from the ledger", async () => {
    const { dom, d } = await open({
      projects: [project("a")],
      sessions: [
        block("s1", "a", 2, 1, { status: "pending" }),
        block("s2", "a", 3, 2, { status: "pending" }),
      ],
    });
    // an em dash, not $0.00: nothing has been earned yet, which is a different
    // statement from having earned zero
    expect(d.querySelector(".grand-amt").textContent).toBe("—");
    expect(d.querySelector(".grand-pending").textContent).toMatch(/\$102\.50 pending/);

    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await wait(250);
    btn(d, /Select all/i).click();
    await wait(200);
    btn(d, /^Mark paid$/).click();
    await wait(300);

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
    const dom = await boot(seed);
    await wait(150);
    return { dom, d: dom.window.document };
  };
  const toYear = async (d) => {
    [...d.querySelectorAll(".dash-head .seg")].find((b) => b.textContent === "Year").click();
    await wait(250);
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
    await wait(250);
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
    const dom = await boot(seed);
    await wait(150);
    return dom.window.document;
  };

  it("appears for one company once it carries several projects", async () => {
    // The case a whole imported history lands in: forty projects, one client.
    const d = await open({
      projects: [
        project("a", { company: "Outlier" }),
        project("b", { company: "Outlier" }),
      ],
      sessions: [block("s1", "a", 2), block("s2", "b", 3)],
    });
    expect(d.querySelector(".crow")).not.toBeNull();
    expect(d.querySelector(".crow-name").textContent).toBe("Outlier");
    expect([...d.querySelectorAll(".sec-head")].some((h) => /1 company\b/.test(h.textContent)))
      .toBe(true);
  }, 25_000);

  it("still skips one company on one project, which is just its name again", async () => {
    const d = await open({
      projects: [project("a", { company: "Outlier" })],
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
    const dom = await boot(seedWith([1, 2, 3]));
    await wait(150);
    expect(dom.window.document.querySelector(".hm-head .step")).toBeNull();
  }, 25_000);

  it("steps back a whole calendar at a time and stops at the oldest record", async () => {
    const dom = await boot(seedWith([1, 400]));
    const d = dom.window.document;
    await wait(150);
    const steps = () => [...d.querySelectorAll(".hm-head .step")];
    expect(steps()).toHaveLength(2);
    expect(steps()[1].disabled).toBe(true);           // nothing later than now

    const firstSpan = d.querySelector(".hm-span").textContent;
    expect(d.querySelector(".hm-read").textContent).toMatch(/1 active day/);

    steps()[0].click();
    await wait(300);
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
  const block = (id, pid, hours, y, m, d) => ({
    id, projectId: pid, kind: "billed", taskId: null, rate: 100, currency: "USD",
    createdAt: dayAt(y, m, d), closedAt: dayAt(y, m, d) + hours * HOUR, deletedAt: null,
    segments: [{ startedAt: dayAt(y, m, d), endedAt: dayAt(y, m, d) + hours * HOUR }],
  });
  /** Three years of history, so all time really has to reach across years. */
  const history = {
    projects: [project("a")],
    sessions: [
      block("s1", "a", 2, thisYear - 2, 0, 15), // Jan, two years ago
      block("s2", "a", 3, thisYear - 1, 5, 10), // Jun, last year
      block("s3", "a", 4, thisYear, 0, 20), // Jan, this year
    ],
  };
  const open = async (seed) => {
    const dom = await boot(seed);
    await wait(150);
    return { dom, d: dom.window.document };
  };
  const toAll = async (d) => {
    [...d.querySelectorAll(".dash-head .seg")].find((b) => b.textContent === "All").click();
    await wait(300);
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

describe("nudging the user to keep a copy they hold", () => {
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const daysAgo = (n) => Date.now() - n * DAY;
  const project = (id, extra = {}) => ({
    id, name: id, currentRate: 100, currency: "USD", createdAt: daysAgo(400),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  const block = (id, back, extra = {}) => ({
    id, projectId: "a", kind: "billed", taskId: null, rate: 100, currency: "USD",
    createdAt: daysAgo(back), closedAt: daysAgo(back) + HOUR, deletedAt: null,
    segments: [{ startedAt: daysAgo(back), endedAt: daysAgo(back) + HOUR }],
    ...extra,
  });
  const open = async (seed) => {
    const dom = await boot(seed);
    await wait(200);
    return { dom, d: dom.window.document };
  };
  const banner = (d) => [...d.querySelectorAll(".banner")]
    .find((b) => /backed up/i.test(b.textContent));

  it("asks for a backup once work exists and no file was ever made", async () => {
    const { d } = await open({ projects: [project("a")], sessions: [block("s1", 3)] });
    expect(banner(d)).toBeTruthy();
    expect(banner(d).textContent).toMatch(/Never backed up/i);
    expect(banner(d).textContent).toMatch(/1 record/);
  }, 25_000);

  it("says nothing at all on an empty ledger", async () => {
    // A banner that cries wolf is one people learn to look past.
    const { d } = await open({ projects: [project("a")], sessions: [] });
    expect(banner(d)).toBeUndefined();
  }, 25_000);

  it("stays quiet while the existing file still holds everything", async () => {
    const { d } = await open({
      projects: [project("a")],
      sessions: [block("s1", 40)],
      lastBackupAt: daysAgo(30), // long ago, but nothing recorded since
    });
    expect(banner(d)).toBeUndefined();
  }, 25_000);

  it("asks again once new work has piled up on an old backup", async () => {
    const { d } = await open({
      projects: [project("a")],
      sessions: [block("s1", 40), block("s2", 1)],
      lastBackupAt: daysAgo(30),
    });
    expect(banner(d).textContent).toMatch(/Last backed up 30 days ago/i);
  }, 25_000);

  it("records the backup and drops the nudge once a file is produced", async () => {
    const { dom, d } = await open({ projects: [project("a")], sessions: [block("s1", 3)] });
    expect(banner(d)).toBeTruthy();
    await toProjects(d, "Work");
    // jsdom implements no blob URLs, so the download throws and the stamp never
    // lands — which is the RIGHT behaviour (no file handed over, no backup
    // recorded) but leaves the happy path untestable without this.
    let handed = null;
    dom.window.URL.createObjectURL = (blob) => { handed = blob; return "blob:x"; };
    dom.window.URL.revokeObjectURL = () => {};
    btn(d, /Export backup/i).click();
    await wait(300);
    expect(handed).not.toBeNull();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(typeof saved.lastBackupAt).toBe("number");
    // and the file itself does NOT claim to have been backed up already
    expect(banner(d)).toBeUndefined();
    expect(d.querySelector(".backup-note").textContent).toMatch(/Last backup today/i);
  }, 30_000);

  it("states the position even when nothing is overdue", async () => {
    const { d } = await open({
      projects: [project("a")], sessions: [block("s1", 40)], lastBackupAt: daysAgo(2),
    });
    await toProjects(d, "Work");
    expect(d.querySelector(".backup-note").textContent).toMatch(/Last backup 2 days ago/i);
  }, 25_000);
});

describe("finding one project among forty", () => {
  const HOUR = 3_600_000;
  const p = (name, extra = {}) => ({
    id: name, name, currentRate: 100, currency: "USD", createdAt: Date.now() - 400 * 86_400_000,
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  /** Enough projects that the box appears at all, shaped like the real ledger:
   *  a handful live, the rest filed away under one client. */
  const many = {
    projects: [
      p("Aether"), p("Taiga Human pref"), p("P2P"),
      p("hyperion_env_building", { company: "Outlier", status: "done" }),
      p("code v code", { company: "Outlier", status: "done" }),
      p("extensions-code-v-code", { company: "Outlier", status: "done" }),
      p("gamebird", { company: "Outlier", status: "done" }),
      p("Glider Broiler", { company: "Outlier", status: "done" }),
    ],
    sessions: [],
  };
  const names = (d) => [...d.querySelectorAll(".card-name")].map((e) => e.textContent);
  const find = (d) => d.querySelector(".find");
  const open = async (seed) => {
    const dom = await boot(seed);
    await wait(200);
    await toProjects(dom.window.document, "Work");
    return { dom, d: dom.window.document };
  };
  const type = async (dom, d, text) => {
    setValue(dom.window, find(d), text);
    await wait(250);
  };

  it("offers no box on a short list, where nothing can get lost", async () => {
    const { d } = await open({ projects: [p("Aether"), p("P2P")], sessions: [] });
    expect(find(d)).toBeNull();
  }, 25_000);

  it("narrows the list as you type", async () => {
    const { dom, d } = await open(many);
    await type(dom, d, "gamebird");
    expect(names(d)).toEqual(["gamebird"]);
  }, 30_000);

  it("reaches into the filed-away work, which is where most of it is", async () => {
    // A match inside a collapsed group is a match the reader cannot see, so
    // searching opens it.
    const { dom, d } = await open(many);
    expect(names(d)).not.toContain("hyperion_env_building");
    await type(dom, d, "hyperion");
    expect(names(d)).toContain("hyperion_env_building");
  }, 30_000);

  it("ignores whether you typed spaces, underscores or hyphens", async () => {
    const { dom, d } = await open(many);
    await type(dom, d, "env building");
    expect(names(d)).toEqual(["hyperion_env_building"]);
    await type(dom, d, "code-v-code");
    expect(names(d).sort()).toEqual(["code v code", "extensions-code-v-code"]);
  }, 30_000);

  it("finds every project belonging to a client", async () => {
    const { dom, d } = await open(many);
    await type(dom, d, "outlier");
    expect(names(d)).toHaveLength(5);
  }, 30_000);

  it("says so plainly when nothing matches", async () => {
    const { dom, d } = await open(many);
    await type(dom, d, "zzzz");
    expect(d.querySelector(".empty").textContent).toMatch(/Nothing matches/i);
    expect(names(d)).toHaveLength(0);
  }, 30_000);

  it("leaves the headline alone, because searching earns you nothing", async () => {
    const { dom, d } = await open({
      ...many,
      sessions: [{
        id: "s1", projectId: "Aether", kind: "billed", taskId: null, rate: 100,
        currency: "USD", createdAt: Date.now() - HOUR, closedAt: Date.now(), deletedAt: null,
        segments: [{ startedAt: Date.now() - HOUR, endedAt: Date.now() }],
      }],
    });
    const before = d.querySelector(".grand-amt").textContent;
    await type(dom, d, "gamebird");
    expect(d.querySelector(".grand-amt").textContent).toBe(before);
  }, 30_000);

  it("brings the whole list back when cleared", async () => {
    const { dom, d } = await open(many);
    await type(dom, d, "gamebird");
    expect(names(d)).toHaveLength(1);
    btn(d, /^Clear$/).click();
    await wait(250);
    expect(names(d).length).toBeGreaterThan(1);
  }, 30_000);
});

describe("handing the numbers to a spreadsheet", () => {
  const HOUR = 3_600_000;
  const back = (n) => Date.now() - n * 86_400_000;
  const seed = {
    projects: [{
      id: "a", name: "hyperion", currentRate: 20, currency: "USD", company: "Outlier",
      createdAt: back(40), sessionGoal: null, overallGoal: null, tasks: [],
    }],
    sessions: [{
      id: "s1", projectId: "a", kind: "billed", taskId: null, rate: 20, currency: "USD",
      createdAt: back(2), closedAt: back(2) + 2 * HOUR, deletedAt: null,
      segments: [{ startedAt: back(2), endedAt: back(2) + 2 * HOUR }],
    }],
    earnings: [{
      id: "e1", projectId: "a", taskId: null, kind: "piece", cents: 300_000,
      currency: "USD", at: back(1), note: "", units: 6, createdAt: back(1), deletedAt: null,
    }],
    lastBackupAt: back(30),
  };
  /** jsdom implements no blob URLs and will not read a Blob back, so the file
   *  is caught on its way in — the text handed to the Blob constructor IS the
   *  file the browser would have written. */
  const grab = async (dom, d, label) => {
    const written = [];
    const RealBlob = dom.window.Blob;
    dom.window.Blob = function Caught(parts, opts) {
      written.push(String(parts[0]));
      return new RealBlob(parts, opts);
    };
    dom.window.URL.createObjectURL = () => "blob:x";
    dom.window.URL.revokeObjectURL = () => {};
    btn(d, label).click();
    await wait(300);
    dom.window.Blob = RealBlob;
    return written[0];
  };

  it("writes a CSV a spreadsheet can open, with both kinds of income", async () => {
    const dom = await boot(seed);
    const d = dom.window.document;
    await wait(200);
    await toProjects(d, "Work");
    const csv = await grab(dom, d, /Export CSV/i);

    const rows = csv.trim().split("\n");
    expect(rows[0]).toMatch(/^"Date","Project","Company"/);
    expect(rows).toHaveLength(3); // header, the session, the piece-rate money
    expect(csv).toContain('"hyperion"');
    expect(csv).toContain('"Outlier"');
    expect(csv).toContain('"40.00"'); // 2h at $20
    expect(csv).toContain('"3000.00"'); // the money no clock measured
    expect(csv).toMatch(/"6 items"/);
  }, 30_000);

  it("does not count a CSV as a backup", async () => {
    // It drops ids, segments, goals and objectives, so the app cannot read it
    // back. Clearing the nudge would leave the user believing otherwise.
    const dom = await boot({ ...seed, lastBackupAt: undefined });
    const d = dom.window.document;
    await wait(200);
    await toProjects(d, "Work");
    await grab(dom, d, /Export CSV/i);

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.lastBackupAt).toBeUndefined();
    expect([...d.querySelectorAll(".banner")].some((b) => /backed up/i.test(b.textContent)))
      .toBe(true);
  }, 30_000);

  it("offers no CSV on the Life tab, where there is no money", async () => {
    const dom = await boot(seed);
    const d = dom.window.document;
    await wait(200);
    await toProjects(d, "Life");
    expect(btn(d, /Export CSV/i)).toBeUndefined();
  }, 25_000);
});

describe("telling the user when they work", () => {
  const HOUR = 3_600_000;
  /** A run of days at a fixed hour, `n` weeks back, so the pattern has volume. */
  const runs = (spec) => {
    const out = [];
    let i = 0;
    for (const { day, hour, count, hours = 2, manual } of spec) {
      for (let k = 0; k < count; k += 1) {
        const d = new Date();
        d.setDate(d.getDate() - (d.getDay() + 6) % 7 - 7 * (k + 1)); // a Monday, k weeks back
        d.setDate(d.getDate() + day);
        d.setHours(hour, 0, 0, 0);
        const startedAt = d.getTime();
        out.push({
          id: `s${i += 1}`, projectId: "a", kind: "billed", taskId: null, rate: 10,
          currency: "USD", createdAt: startedAt, closedAt: startedAt + hours * HOUR,
          deletedAt: null, segments: [{ startedAt, endedAt: startedAt + hours * HOUR }],
          ...(manual ? { manual: true } : {}),
        });
      }
    }
    return out;
  };
  const seed = (sessions) => ({
    projects: [{
      id: "a", name: "p", currentRate: 10, currency: "USD",
      createdAt: Date.now() - 400 * 86_400_000,
      sessionGoal: null, overallGoal: null, tasks: [],
    }],
    sessions,
  });
  const panel = (d) => [...d.querySelectorAll(".sec")].find((x) => /When you work/.test(x.textContent));
  const read = (d) => panel(d)?.querySelector(".rhy-read")?.textContent.replace(/\s+/g, " ") ?? "";
  const open = async (s) => {
    const dom = await boot(s);
    await wait(250);
    return dom.window.document;
  };

  it("names the day only when it genuinely stands above the rest", async () => {
    const d = await open(seed(runs([
      { day: 2, hour: 20, count: 10, hours: 6 }, // Wednesdays, heavily
      { day: 0, hour: 20, count: 10, hours: 1 },
      { day: 4, hour: 20, count: 10, hours: 1 },
    ])));
    expect(read(d)).toMatch(/Busiest on Wednesday/);
  }, 30_000);

  it("calls a flat week flat, rather than crowning the tallest bar", async () => {
    // Seven bars within a fifth of each other is not a habit.
    const d = await open(seed(runs(
      [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, hour: 20, count: 8, hours: 2 })))));
    expect(read(d)).toMatch(/spread evenly across the week/i);
    expect(read(d)).not.toMatch(/Busiest on/);
  }, 30_000);

  it("finds a working stretch that runs across midnight", async () => {
    // 23:00 + 3h occupies hours 23, 00 and 01. The best four-hour window over
    // three worked hours has two equal answers, and ties go to the earlier.
    const d = await open(seed(runs([{ day: 1, hour: 23, count: 14, hours: 3 }])));
    expect(read(d)).toMatch(/between 22:00 and 02:00/);
  }, 30_000);

  it("ignores typed-in sessions when reading the clock", async () => {
    // An imported row's hour was chosen by the importer, not observed. Reading
    // it back would report that arithmetic as the user's habit.
    const d = await open(seed([
      ...runs([{ day: 1, hour: 9, count: 30, hours: 4, manual: true }]),
      ...runs([{ day: 1, hour: 22, count: 14, hours: 3 }]),
    ]));
    expect(read(d)).toMatch(/between 21:00 and 01:00/);
    expect(read(d)).not.toMatch(/09:00/);
  }, 30_000);

  it("draws no clock at all on too few measured sessions", async () => {
    const d = await open(seed(runs([{ day: 1, hour: 9, count: 30, hours: 4, manual: true }])));
    expect(panel(d)).toBeTruthy(); // the week still reads
    expect(read(d)).not.toMatch(/between/);
    expect(panel(d).querySelectorAll(".cyc")).toHaveLength(1);
  }, 30_000);

  it("shows nothing at all before there is anything to show", async () => {
    const d = await open(seed([]));
    expect(panel(d)).toBeUndefined();
  }, 25_000);
});

describe("which work was worth the time, and how much rides on one project", () => {
  const HOUR = 3_600_000;
  const back = (n) => Date.now() - n * 86_400_000;
  const project = (id, extra = {}) => ({
    id, name: id, currentRate: 10, currency: "USD", createdAt: back(300),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  /** `hours` at whatever rate makes it come to `dollars`. */
  const work = (id, pid, hours, dollars) => ({
    id, projectId: pid, kind: "billed", taskId: null, rate: dollars / hours,
    currency: "USD", createdAt: back(5), closedAt: back(5) + hours * HOUR, deletedAt: null,
    segments: [{ startedAt: back(5), endedAt: back(5) + hours * HOUR }],
  });
  const seed = {
    projects: [project("big"), project("good"), project("blip")],
    sessions: [
      work("s1", "big", 100, 2_000), // $20/hr, most of the money
      work("s2", "good", 10, 900), // $90/hr, the best hour
      work("s3", "blip", 1, 300), // $300/hr on one hour — too little to rank
    ],
  };
  const sorters = (d) => [...d.querySelectorAll('[aria-label="Order projects by"] .seg')];
  const named = (d) => [...d.querySelectorAll(".prow-name")].map((e) => e.textContent);
  const open = async () => {
    const dom = await boot(seed);
    await wait(250);
    const d = dom.window.document;
    [...d.querySelectorAll(".dash-head .segmented .seg")].find((b) => b.textContent === "All").click();
    await wait(300);
    return d;
  };

  it("orders by time until asked otherwise", async () => {
    const d = await open();
    expect(named(d)[0]).toBe("big");
    expect(sorters(d).map((b) => b.textContent)).toEqual(["Time", "An hour"]);
  }, 30_000);

  it("reorders by what an hour actually paid, and says the figure", async () => {
    const d = await open();
    sorters(d).find((b) => b.textContent === "An hour").click();
    await wait(300);
    expect(named(d)[0]).toBe("good");
    const row = [...d.querySelectorAll(".prow")].find((r) => /good/.test(r.textContent));
    expect(row.textContent).toMatch(/\$90\.00\/hr/);
  }, 30_000);

  it("keeps a one-hour fluke out of the ranking entirely", async () => {
    // $300/hr across a single hour would sit at the top, where the eye goes.
    const d = await open();
    sorters(d).find((b) => b.textContent === "An hour").click();
    await wait(300);
    expect(named(d)).not.toContain("blip");
    // it is still there when ordered by time — only the RANKING excludes it
    sorters(d).find((b) => b.textContent === "Time").click();
    await wait(300);
    expect(named(d)).toContain("blip");
  }, 30_000);

  it("names the project most of the money rides on", async () => {
    const d = await open();
    expect(d.querySelector(".concentration").textContent).toMatch(/big/);
    expect(d.querySelector(".concentration").textContent).toMatch(/63%/); // 2000 of 3200
  }, 30_000);

  it("says nothing about concentration when the work is spread", async () => {
    const dom = await boot({
      projects: [project("a"), project("b"), project("c"), project("d")],
      sessions: [
        work("s1", "a", 10, 250), work("s2", "b", 10, 250),
        work("s3", "c", 10, 250), work("s4", "d", 10, 250),
      ],
    });
    await wait(250);
    expect(dom.window.document.querySelector(".concentration")).toBeNull();
  }, 30_000);

  it("offers no ordering choice when there is nothing to reorder", async () => {
    const dom = await boot({ projects: [project("a")], sessions: [work("s1", "a", 10, 100)] });
    await wait(250);
    expect(sorters(dom.window.document)).toHaveLength(0);
  }, 25_000);
});
