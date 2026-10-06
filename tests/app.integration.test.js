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

/** `settings` seeds device-local keys — the ones that are NOT part of the
 *  ledger, such as the Google client id. They have to be in place before the
 *  page runs, because the app reads them once at mount, exactly as a real
 *  browser would. */
const boot = async (seed, settings = null) => {
  let html = readFileSync(DIST, "utf8");
  const sets = [
    seed && `localStorage.setItem('meter:v1', ${JSON.stringify(JSON.stringify(seed))});`,
    ...Object.entries(settings ?? {}).map(
      ([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`),
  ].filter(Boolean);
  const preamble = sets.length ? `<script>${sets.join("")}</script>${COUNTER}` : COUNTER;
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
 * Boot, then go to the Overview.
 *
 * Most of the dashboard tests below were written when the app opened on the
 * Overview. It opens on Today now — what you are doing, not how the month
 * went — so a test about the dashboard has to say which screen it means.
 */
/**
 * The Overview opened on all time rather than the week it defaults to.
 *
 * For tests that seed work a day or two back to say "not today" and then ask
 * whether it shows up at all. The week starts on Monday, so on a Monday
 * yesterday is last week and those tests failed one day in seven — on the
 * real clock, wherever they happened to run. Nothing they assert is about
 * where a week begins; the tests that are say so with their own period.
 */
const ALL_TIME = { "meter:period": "all" };

const bootDash = async (seed, settings = null) => {
  const dom = await boot(seed, settings);
  await wait(150);
  await toProjects(dom.window.document, "Overview");
  return dom;
};

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
  const proto = el.tagName === "SELECT" ? win.HTMLSelectElement.prototype
    : el.tagName === "TEXTAREA" ? win.HTMLTextAreaElement.prototype
      : win.HTMLInputElement.prototype;
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

  it("has a dark palette that follows the operating system", async () => {
    const html = readFileSync(DIST, "utf8");
    expect(html).toMatch(/@media \(prefers-color-scheme: dark\)/);
    // The page chrome behind the app has to move too, or a dark UI sits in a
    // white frame with a white status bar above it.
    expect(html).toMatch(/theme-color" content="#0E1210" media="\(prefers-color-scheme: dark\)"/);
    expect(html).toMatch(/html,body\{background:#0E1210;color-scheme:dark;\}/);
  });

  it("takes every colour from a token, so one palette can repaint the app", async () => {
    // The invariant dark mode rests on. A literal colour written into a rule
    // looks right in the theme it was written for and wrong in the other, and
    // nothing else would notice until someone opened it at night.
    const html = readFileSync(DIST, "utf8");
    // The bootstrap <style> is exempt and has to be: it paints the page behind
    // the app before a single token exists, and it carries its own dark rule.
    const app = html.replace(/<style>[\s\S]*?<\/style>/g, "");
    const offenders = [];
    for (const decl of app.split(/[;{}]/)) {
      if (!/#[0-9A-Fa-f]{3,8}/.test(decl)) continue;
      const [prop, ...rest] = decl.split(":");
      if (!rest.length) continue;                       // not a declaration
      if (!/^[-a-z]+$/.test(prop.trim())) continue;     // not CSS
      if (prop.trim().startsWith("--")) continue;       // declaring a token
      offenders.push(decl.trim().slice(0, 80));
    }
    expect(offenders).toEqual([]);
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

  it("keeps the activity calendar's month labels on their own columns", async () => {
    /**
     * Regression, and one no other test could have caught: a flex item
     * defaults to `min-width:auto`, which refuses to shrink below its content.
     * With `white-space:nowrap` on it, every labelled column came out as wide
     * as the word rather than the 10px basis asked for, and the error
     * compounded left to right — by the far end of the year September sat 80px
     * past the week it named, printed over empty space off the end of the
     * grid. The `overflow:visible` beside it is what says the box is meant to
     * stay narrow and let the text spill.
     *
     * Only a real browser can measure that, so what is pinned here is the one
     * declaration that makes the stated basis take effect.
     */
    const css = readFileSync(DIST, "utf8");
    const rule = css.match(/\.hm-month\{([^}]*)/);
    expect(rule?.[1], "the month label must be able to shrink to its basis")
      .toContain("min-width:0");
    expect(rule?.[1]).toContain("flex:0 0 var(--hm-cell)");
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
    await wait(120);
    // Settings are staged and saved on request; leaving the box is not the
    // act of changing a rate any more.
    btn(d, /Save changes/).click();
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

    const boxes = [...d.querySelectorAll(".row .row-check")];
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

    d.querySelectorAll(".row .row-check")[0].click();
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
    await wait(200);
    btn(d, /^Submit 1$/).click();
    await wait(300);
    expect(JSON.parse(window.localStorage.getItem("meter:v1"))
      .projects[0].tasks[0].state).toBe("submitted");

    d.querySelector(".trow .row-check").click();
    await wait(200);
    btn(d, /^Rejected 1$/).click();
    await wait(300);

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

    d.querySelectorAll(".row .row-check")[0].click();
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
    await wait(170);
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
    await wait(220);

    expect(d.querySelector(".grand-amt").textContent).toMatch(/900\.00/);
    expect(tileValue(d, "Billed")).toBe("2h 00m");
  }, 20_000);

  it("counts a session that ran past midnight in both days, not once in either", async () => {
    // The figure the whole reporting layer exists to get right. 23:30 to 00:30
    // is half an hour of yesterday and half an hour of today, and filing it
    // whole under either day would move money onto the wrong date.
    const dom = await bootDash({
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
    const dom = await bootDash({
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
    const dom = await bootDash({
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
    await wait(220);
    d.querySelectorAll(".step")[0].click();
    await wait(240);

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
    await wait(220);

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
    await wait(220);
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
    await wait(220);
    expect(d.querySelectorAll(".tcol")).toHaveLength(7);

    btn(d, /^Month$/).click();
    await wait(220);
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
    const dom = await bootDash({
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
    await wait(220);
    btn(d, /^Day$/).click();
    await wait(220);

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
    await wait(220);

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
    await wait(220);

    expect(tileValue(d, "Billed")).toBe("9h 00m");
    expect([...d.querySelectorAll(".prow-name")].map((n) => n.textContent))
      .toEqual(["Life", "Acme"]);
  }, 20_000);

  it("reports off-clock time in its own panel instead of dropping it", async () => {
    const dom = await bootDash(seed(true));
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
    await wait(250);

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
    const dom = await bootDash(seed(objectives));
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
    const dom = await bootDash(seed([
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
    const dom = await bootDash(seed([
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
    const dom = await bootDash(seed([objective("o1", "p2", "Bed by midnight")]));
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
    const dom = await bootDash(seed);
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
    const dom = await bootDash(seed);
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
    const dom = await bootDash(seed, ALL_TIME);
    await wait(150);
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
    const dom = await bootDash(seed, ALL_TIME);
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
      /**
       * Both today, on purpose. The Overview opens on the week, so a fixture
       * dated "2 days ago" sits outside it every Monday and Tuesday and this
       * assertion fails on the calendar rather than on the code. The test is
       * about pending money, not about dates, so it should not have one.
       */
      sessions: [
        block("s1", "a", 2, 0, { status: "pending" }),
        block("s2", "a", 3, 0, {
          status: "pending",
          createdAt: dayStart() + 13 * HOUR,
          closedAt: dayStart() + 16 * HOUR,
          segments: [{ startedAt: dayStart() + 13 * HOUR, endedAt: dayStart() + 16 * HOUR }],
        }),
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
    const dom = await bootDash(seed);
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
    const dom = await bootDash(seed, ALL_TIME);
    await wait(150);
    return dom.window.document;
  };

  it("appears for one company once it carries several projects", async () => {
    // The case a whole imported history lands in: forty projects, one client.
    const d = await open({
      projects: [
        project("a", { company: "Northwind" }),
        project("b", { company: "Northwind" }),
      ],
      sessions: [block("s1", "a", 2), block("s2", "b", 3)],
    });
    expect(d.querySelector(".crow")).not.toBeNull();
    expect(d.querySelector(".crow-name").textContent).toBe("Northwind");
    expect([...d.querySelectorAll(".sec-head")].some((h) => /1 company\b/.test(h.textContent)))
      .toBe(true);
  }, 25_000);

  it("still skips one company on one project, which is just its name again", async () => {
    const d = await open({
      projects: [project("a", { company: "Northwind" })],
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
    const dom = await bootDash(seedWith([1, 2, 3]));
    await wait(150);
    expect(dom.window.document.querySelector(".hm-head .step")).toBeNull();
  }, 25_000);

  it("steps back a whole calendar at a time and stops at the oldest record", async () => {
    const dom = await bootDash(seedWith([1, 400]));
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
  const block = (id, pid, hours, start) => ({
    id, projectId: pid, kind: "billed", taskId: null, rate: 100, currency: "USD",
    createdAt: start, closedAt: start + hours * HOUR, deletedAt: null,
    segments: [{ startedAt: start, endedAt: start + hours * HOUR }],
  });
  /**
   * History reaching back across two new years, so all time really has to
   * span years. Every session is in the past whatever the date: the newest
   * used to be 20 January of the current year, which from the 1st to the
   * 19th had not happened yet, and the total read $500 and 5h, not $900 and 9h.
   */
  const history = {
    projects: [project("a")],
    sessions: [
      block("s1", "a", 2, dayAt(thisYear - 2, 0, 15)), // Jan, two years ago
      block("s2", "a", 3, dayAt(thisYear - 1, 5, 10)), // Jun, last year
      block("s3", "a", 4, Date.now() - 2 * 86_400_000), // two days ago
    ],
  };
  const open = async (seed) => {
    const dom = await bootDash(seed);
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
      p("Lumen"), p("Delta Human Pref"), p("Gateway"),
      p("orion_env_building", { company: "Northwind", status: "done" }),
      p("pair review", { company: "Northwind", status: "done" }),
      p("extensions-pair-review", { company: "Northwind", status: "done" }),
      p("songbird", { company: "Northwind", status: "done" }),
      p("Weather Widget", { company: "Northwind", status: "done" }),
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
    const { d } = await open({ projects: [p("Lumen"), p("Gateway")], sessions: [] });
    expect(find(d)).toBeNull();
  }, 25_000);

  it("narrows the list as you type", async () => {
    const { dom, d } = await open(many);
    await type(dom, d, "songbird");
    expect(names(d)).toEqual(["songbird"]);
  }, 30_000);

  it("reaches into the filed-away work, which is where most of it is", async () => {
    // A match inside a collapsed group is a match the reader cannot see, so
    // searching opens it.
    const { dom, d } = await open(many);
    expect(names(d)).not.toContain("orion_env_building");
    await type(dom, d, "orion");
    expect(names(d)).toContain("orion_env_building");
  }, 30_000);

  it("ignores whether you typed spaces, underscores or hyphens", async () => {
    const { dom, d } = await open(many);
    await type(dom, d, "env building");
    expect(names(d)).toEqual(["orion_env_building"]);
    await type(dom, d, "pair-review");
    expect(names(d).sort()).toEqual(["extensions-pair-review", "pair review"]);
  }, 30_000);

  it("finds every project belonging to a client", async () => {
    const { dom, d } = await open(many);
    await type(dom, d, "northwind");
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
        id: "s1", projectId: "Lumen", kind: "billed", taskId: null, rate: 100,
        currency: "USD", createdAt: Date.now() - HOUR, closedAt: Date.now(), deletedAt: null,
        segments: [{ startedAt: Date.now() - HOUR, endedAt: Date.now() }],
      }],
    });
    const before = d.querySelector(".grand-amt").textContent;
    await type(dom, d, "songbird");
    expect(d.querySelector(".grand-amt").textContent).toBe(before);
  }, 30_000);

  it("brings the whole list back when cleared", async () => {
    const { dom, d } = await open(many);
    await type(dom, d, "songbird");
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
      id: "a", name: "orion", currentRate: 20, currency: "USD", company: "Northwind",
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

    // After the byte-order mark that tells Excel the file is UTF-8.
    const rows = csv.replace(/^\uFEFF/, "").trim().split("\n");
    expect(rows[0]).toMatch(/^"Date","Project","Company"/);
    expect(rows).toHaveLength(3); // header, the session, the piece-rate money
    expect(csv).toContain('"orion"');
    expect(csv).toContain('"Northwind"');
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
    const dom = await bootDash(s);
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
    const dom = await bootDash(seed);
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
    const dom = await bootDash({
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
    const dom = await bootDash({ projects: [project("a")], sessions: [work("s1", "a", 10, 100)] });
    await wait(250);
    expect(sorters(dom.window.document)).toHaveLength(0);
  }, 25_000);
});

describe("seeing what is running from anywhere", () => {
  const seed = {
    projects: [{
      id: "a", name: "Acme", currentRate: 60, currency: "USD", tasks: [],
      createdAt: Date.now() - 86_400_000, sessionGoal: null, overallGoal: null,
    }],
    sessions: [],
  };
  const bar = (d) => d.querySelector(".runbar");

  const startAndLeave = async () => {
    const dom = await boot(seed);
    await wait(250);
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await wait(200);
    await startMeter(dom);
    // Back out to the list, then over to the Overview.
    btn(d, /All projects/i).click();
    await wait(200);
    return { dom, d };
  };

  it("shows nothing at all while nothing is running", async () => {
    const dom = await boot(seed);
    await wait(250);
    // Furniture that says "not tracking" earns nothing, and this sits above
    // every screen in the app.
    expect(bar(dom.window.document)).toBeNull();
  }, 25_000);

  it("follows you from the project onto other tabs", async () => {
    const { d } = await startAndLeave();
    expect(bar(d)).not.toBeNull();
    expect(bar(d).textContent).toMatch(/Acme/);

    [...d.querySelectorAll("[role=tab]")].find((t) => t.textContent === "Overview").click();
    await wait(200);
    expect(bar(d)).not.toBeNull();
  }, 30_000);

  it("names the money as it accrues", async () => {
    const { d } = await startAndLeave();
    expect(bar(d).querySelector(".runbar-amt")).not.toBeNull();
    expect(bar(d).querySelector(".runbar-time").textContent).toMatch(/\d\d:\d\d:\d\d/);
  }, 30_000);

  it("stops the meter from wherever you are", async () => {
    const { dom, d } = await startAndLeave();
    bar(d).querySelector(".runbar-stop").click();
    await wait(350);
    expect(bar(d)).toBeNull();
    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.sessions[0].closedAt).not.toBeNull();
  }, 30_000);

  it("takes you to the project it belongs to", async () => {
    const { d } = await startAndLeave();
    bar(d).querySelector(".runbar-what").click();
    await wait(250);
    expect(btn(d, /All projects/i)).toBeTruthy();
  }, 30_000);

  it("quotes no money on idle time, which is not earnings", async () => {
    const dom = await boot(seed);
    await wait(250);
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await wait(200);
    await startMeter(dom, { idle: true });
    btn(d, /All projects/i).click();
    await wait(200);
    expect(bar(d).querySelector(".runbar-amt")).toBeNull();
    expect(bar(d).textContent).toMatch(/idle/i);
  }, 30_000);
});

describe("the span the Overview opens on", () => {
  const seed = {
    projects: [{
      id: "a", name: "Acme", currentRate: 20, currency: "USD", tasks: [],
      createdAt: Date.now() - 86_400_000, sessionGoal: null, overallGoal: null,
    }],
    sessions: [],
  };
  const chosen = (d) => d.querySelector('[aria-label="Reporting period"] .seg.on')?.textContent;

  it("opens on the week when nothing has been chosen", async () => {
    const dom = await bootDash(seed);
    await wait(250);
    expect(chosen(dom.window.document)).toBe("Week");
  }, 25_000);

  it("remembers the one you picked", async () => {
    const dom = await bootDash(seed);
    await wait(250);
    const d = dom.window.document;
    btn(d, /^Month$/).click();
    await wait(200);
    expect(dom.window.localStorage.getItem("meter:period")).toBe("month");
  }, 25_000);

  it("opens on it next time", async () => {
    const dom = await bootDash(seed, { "meter:period": "year" });
    await wait(250);
    expect(chosen(dom.window.document)).toBe("Year");
  }, 25_000);

  it("ignores a stored value it does not recognise", async () => {
    // A span from a future version, or a hand-edited one, must not leave the
    // Overview showing nothing at all.
    const dom = await bootDash(seed, { "meter:period": "fortnight" });
    await wait(250);
    expect(chosen(dom.window.document)).toBe("Week");
  }, 25_000);

  it("keeps it out of the ledger, where it would have to be merged", async () => {
    const dom = await bootDash(seed, { "meter:period": "month" });
    await wait(250);
    const saved = dom.window.localStorage.getItem("meter:v1");
    expect(saved === null || !saved.includes("\"period\"")).toBe(true);
  }, 25_000);
});

describe("choosing a theme", () => {
  const seed = {
    projects: [{
      id: "a", name: "Acme", currentRate: 20, currency: "USD", tasks: [],
      createdAt: Date.now() - 86_400_000, sessionGoal: null, overallGoal: null,
    }],
    sessions: [],
  };
  const root = (d) => d.querySelector(".mtr");
  // The switch is icons now, so it is found by the name it carries for
  // anyone who cannot see them.
  const themeBtn = (d, label) => d.querySelector(`.theme [aria-label="${label}"]`);

  it("follows the system until told otherwise", async () => {
    const dom = await boot(seed);
    await wait(250);
    // No attribute at all, which is what lets the media query decide.
    expect(root(dom.window.document).hasAttribute("data-theme")).toBe(false);
  }, 25_000);

  it("names each icon for anyone who cannot see it", async () => {
    const dom = await boot(seed);
    await wait(250);
    const d = dom.window.document;
    for (const label of ["Light", "Dark", "Match system"]) {
      expect(themeBtn(d, label), label).not.toBeNull();
    }
  }, 25_000);

  it("can be pinned to light even where the system is dark", async () => {
    // The case that stranded someone: the OS said dark and the app had no way
    // back, because the palette shipped before the switch did.
    const dom = await boot(seed);
    await wait(250);
    const d = dom.window.document;
    themeBtn(d, "Light").click();
    await wait(250);
    expect(root(d).getAttribute("data-theme")).toBe("light");
    expect(dom.window.localStorage.getItem("meter:theme")).toBe("light");
  }, 25_000);

  it("remembers the choice, and is not in the synced ledger", async () => {
    const dom = await boot(seed, { "meter:theme": "dark" });
    await wait(250);
    expect(root(dom.window.document).getAttribute("data-theme")).toBe("dark");
    const saved = dom.window.localStorage.getItem("meter:v1");
    expect(saved === null || !JSON.stringify(JSON.parse(saved)).includes("theme")).toBe(true);
  }, 25_000);

  it("goes back to following the system", async () => {
    const dom = await boot(seed, { "meter:theme": "dark" });
    await wait(250);
    const d = dom.window.document;
    themeBtn(d, "Match system").click();
    await wait(250);
    expect(root(d).hasAttribute("data-theme")).toBe(false);
    expect(dom.window.localStorage.getItem("meter:theme")).toBeNull();
  }, 25_000);
});

describe("pricing a task when you create it", () => {
  const hourly = {
    projects: [{
      id: "a", name: "Acme", currentRate: 16.40, currency: "USD", tasks: [],
      createdAt: Date.now() - 86_400_000, sessionGoal: null, overallGoal: null,
    }],
    sessions: [],
  };
  const field = (d, label) => [...d.querySelectorAll(".field")]
    .find((f) => new RegExp(label, "i").test(f.querySelector(".eyebrow")?.textContent ?? ""))
    ?.querySelector("input");

  const startWith = async (seed, label, pay) => {
    const dom = await boot(seed);
    await wait(250);
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await wait(200);
    btn(d, /Start the meter/i).click();
    await wait(200);
    btn(d, /New task/i).click();
    await wait(150);
    setValue(dom.window, field(d, "Name it"), label);
    await wait(120);
    if (pay !== null) {
      setValue(dom.window, field(d, "^Rate$|Per accepted item"), pay);
      await wait(120);
    }
    btn(d, /Start the meter/i).click();
    await wait(300);
    return { dom, d };
  };

  it("takes a rate at the moment the task comes into being", async () => {
    // Before this, the only way to price one task differently was to edit the
    // project rate, which repriced everything else filed under it.
    const { dom } = await startWith(hourly, "assessment", "4.92");
    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.projects[0].tasks[0]).toMatchObject({ label: "assessment", rate: 4.92 });
  }, 30_000);

  it("keeps a percentage as a percentage", async () => {
    const { dom } = await startWith(hourly, "assessment", "30%");
    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    const task = saved.projects[0].tasks[0];
    expect(task.factor).toBeCloseTo(0.3, 10);
    expect(task.rate).toBeFalsy();
  }, 30_000);

  it("writes nothing when the box is left empty", async () => {
    const { dom } = await startWith(hourly, "plain", null);
    const task = JSON.parse(dom.window.localStorage.getItem("meter:v1")).projects[0].tasks[0];
    expect(task).not.toHaveProperty("rate");
    expect(task).not.toHaveProperty("factor");
  }, 30_000);
});

describe("what a piece-rate session produced", () => {
  const piece = {
    projects: [{
      id: "a", name: "Gateway", currentRate: 0, perTask: 1500, paysOnAcceptance: true,
      currency: "USD", createdAt: Date.now() - 86_400_000, sessionGoal: null, overallGoal: null,
      tasks: [
        { id: "t1", label: "task", createdAt: Date.now() - 86_400_000 },
        { id: "t2", label: "CL", price: 300, createdAt: Date.now() - 86_400_000 },
      ],
    }],
    sessions: [],
  };
  const openProject = async () => {
    const dom = await boot(piece);
    await wait(250);
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await wait(200);
    return { dom, d };
  };
  const settleRows = (d) => [...d.querySelectorAll(".settle-row")];

  it("shows the price per task on the card, not an hourly zero", async () => {
    const dom = await boot(piece);
    await wait(250);
    const d = dom.window.document;
    await toProjects(d, "Work");
    expect(d.querySelector(".card-meta").textContent).toMatch(/\$1,500\.00 per task/);
    expect(d.querySelector(".card-meta").textContent).not.toMatch(/\/hr/);
  }, 30_000);

  it("never quotes an hourly rate it does not have", async () => {
    // The header said "$0.00 per hour", which is a confident answer to a
    // question this project does not ask.
    const { d } = await openProject();
    expect(d.querySelector(".plate-rate").textContent).toMatch(/\$1,500\.00 per accepted item/);
    expect(d.querySelector(".plate-rate").textContent).not.toMatch(/per hour/);
    // And nothing counts out an hour that is never going to be billed.
    expect(d.querySelector(".rail")).toBeNull();
  }, 30_000);

  it("shows the elapsed time once, not twice", async () => {
    const { d } = await openProject();
    expect(d.querySelector(".clock-main")).toBeNull();
    expect(d.querySelector(".money-head")).not.toBeNull();
  }, 30_000);

  it("calls the money what it is on a piece-rate project", async () => {
    // Every penny here arrives without the clock, so that name describes
    // nothing — and reads too close to the app's own "off the clock".
    const { d } = await openProject();
    // Scoped to the rendered app: the page inlines its own bundle, so
    // document.body.textContent contains every string literal in the source,
    // including the branch that was not taken.
    const shown = d.querySelector(".wrap").textContent;
    expect(shown).toMatch(/Accepted work/);
    expect(shown).not.toMatch(/Earned without the clock/);
  }, 30_000);

  it("asks what the sitting earned as soon as the meter stops", async () => {
    const { dom, d } = await openProject();
    await startMeter(dom, { existing: "task" });
    btn(d, /Stop and save/i).click();
    await wait(400);
    expect(d.querySelector(".settle-row")).not.toBeNull();
    expect(d.querySelector(".wrap").textContent).toMatch(/What did this earn/i);
  }, 30_000);

  it("records it as pending, against the session that produced it", async () => {
    // Acceptance is someone else's decision, days away. Filing it as money in
    // hand would make a month look paid when it is only submitted.
    const { dom, d } = await openProject();
    await startMeter(dom, { existing: "task" });
    btn(d, /Stop and save/i).click();
    await wait(400);
    btn(d, /Record it/i).click();
    await wait(400);

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.earnings).toHaveLength(1);
    expect(saved.earnings[0]).toMatchObject({
      cents: 150_000, status: "pending", taskIds: ["t1"], units: 1,
      sessionId: saved.sessions[0].id,
    });
  }, 30_000);

  it("prices two different things from one sitting", async () => {
    // 1,500 for the accepted task and 300 for the accepted changelist.
    const { dom, d } = await openProject();
    await startMeter(dom, { existing: "task" });
    btn(d, /Stop and save/i).click();
    await wait(400);
    btn(d, /Add another/i).click();
    await wait(200);
    expect(settleRows(d)).toHaveLength(2);
    setValue(dom.window, settleRows(d)[1].querySelector("select"), "t2");
    await wait(200);
    btn(d, /Record it/i).click();
    await wait(400);

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.earnings.map((e) => e.cents).sort((a, b) => a - b)).toEqual([30_000, 150_000]);
    expect(new Set(saved.earnings.map((e) => e.sessionId)).size).toBe(1);
  }, 30_000);
});

describe("creating a project that is paid per task", () => {
  const open = async () => {
    const dom = await boot({ projects: [], sessions: [] });
    await wait(200);
    const d = dom.window.document;
    await toProjects(d, "Work");
    btn(d, /New project/i).click();
    await wait(200);
    return { dom, d };
  };
  const pick = async (d, label) => {
    [...d.querySelectorAll('[aria-label="How this project pays"] .seg-btn')]
      .find((b) => b.textContent.trim() === label).click();
    await wait(150);
  };
  const field = (d, label) => [...d.querySelectorAll(".field")]
    .find((f) => new RegExp(label, "i").test(f.querySelector(".eyebrow")?.textContent ?? ""))
    ?.querySelector("input");

  it("offers the choice up front rather than making you correct it later", async () => {
    const { d } = await open();
    expect(d.querySelector('[aria-label="How this project pays"]')).not.toBeNull();
    expect(field(d, "Hourly rate")).not.toBeNull();
    await pick(d, "Per task");
    expect(field(d, "Per accepted task")).not.toBeNull();
    expect(field(d, "Hourly rate")).toBeUndefined();
  }, 25_000);

  it("asks what a task pays, not what an hour pays", async () => {
    const { dom, d } = await open();
    await pick(d, "Per task");
    setValue(dom.window, field(d, "Name"), "Batch work");
    btn(d, /^Add project$/i).click();
    await wait(200);
    expect(d.querySelector(".err").textContent).toMatch(/one task pay/i);
  }, 25_000);

  it("stores the price per item, no hourly rate, and pays on acceptance", async () => {
    const { dom, d } = await open();
    await pick(d, "Per task");
    setValue(dom.window, field(d, "Name"), "Batch work");
    setValue(dom.window, field(d, "Per accepted task"), "250");
    await wait(100);
    btn(d, /^Add project$/i).click();
    await wait(300);

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.projects).toHaveLength(1);
    expect(saved.projects[0]).toMatchObject({
      name: "Batch work", perTask: 250, paysOnAcceptance: true,
      // Zero, and correct: the clock earns nothing here. A rate invented to
      // satisfy the form would report income that never arrived.
      currentRate: 0,
    });
  }, 30_000);

  it("leaves an hourly project exactly as it was", async () => {
    const { dom, d } = await open();
    setValue(dom.window, field(d, "Name"), "Hourly work");
    setValue(dom.window, field(d, "Hourly rate"), "20.5");
    await wait(100);
    btn(d, /^Add project$/i).click();
    await wait(300);

    const p = JSON.parse(dom.window.localStorage.getItem("meter:v1")).projects[0];
    expect(p.currentRate).toBe(20.5);
    expect(p).not.toHaveProperty("perTask");
    expect(p).not.toHaveProperty("paysOnAcceptance");
  }, 30_000);

  it("prices a batch from the count, and lets the amount be overruled", async () => {
    const dom = await boot({
      projects: [{
        id: "a", name: "Batch", currentRate: 0, currency: "USD", perTask: 250,
        paysOnAcceptance: true, createdAt: Date.now() - 86_400_000,
        sessionGoal: null, overallGoal: null, tasks: [],
      }],
      sessions: [],
    });
    const d = dom.window.document;
    await wait(200);
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await wait(250);
    btn(d, /Add earnings/i).click();
    await wait(200);

    const units = [...d.querySelectorAll(".ern-form input")]
      .find((i) => i.step === "1");
    setValue(dom.window, units, "6");
    await wait(200);
    const amount = d.querySelector('.ern-form input[type="number"]');
    expect(amount.value).toBe("1500"); // 6 x $250

    // overruling it stands: a capped or part-paid batch is exactly that case
    setValue(dom.window, amount, "1200");
    await wait(150);
    btn(d, /^Add$/).click();
    await wait(300);
    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.earnings[0]).toMatchObject({ cents: 120_000, units: 6 });
  }, 30_000);
});

describe("the sync panel", () => {
  const seed = {
    projects: [{
      id: "a", name: "Acme", currentRate: 20, currency: "USD",
      createdAt: Date.now() - 86_400_000, sessionGoal: null, overallGoal: null, tasks: [],
    }],
    sessions: [],
  };
  const open = async () => {
    const dom = await boot(seed);
    await wait(250);
    const d = dom.window.document;
    await toProjects(d, "Work");
    return { dom, d };
  };
  const panel = (d) => [...d.querySelectorAll(".sec")]
    .find((x) => /^Sync/.test(x.querySelector(".eyebrow")?.textContent ?? ""));

  it("asks for a client ID before offering to sync anything", async () => {
    const { d } = await open();
    expect(panel(d)).toBeTruthy();
    expect(panel(d).textContent).toMatch(/client ID/i);
    expect(btn(d, /Sync now/i)).toBeUndefined();
  }, 25_000);

  it("explains that the permission cannot see the rest of your Drive", async () => {
    // Worth saying plainly: it is the reason this scope was chosen.
    const { d } = await open();
    expect(panel(d).textContent).toMatch(/cannot see the rest of your Drive/i);
  }, 25_000);

  it("keeps the client ID out of the ledger", async () => {
    // It is configuration, not work. In the ledger, the thing you need in order
    // to sync could only arrive by syncing.
    const { dom, d } = await open();
    setValue(dom.window, panel(d).querySelector(".inp"), "abc.apps.googleusercontent.com");
    await wait(150);
    btn(d, /^Save$/).click();
    await wait(300);

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(JSON.stringify(saved)).not.toContain("googleusercontent");
    expect(dom.window.localStorage.getItem("meter:google-client"))
      .toBe("abc.apps.googleusercontent.com");
  }, 25_000);

  it("offers to sign in once it is configured, and can forget the ID again", async () => {
    const dom = await boot(seed, { "meter:google-client": "abc.apps.googleusercontent.com" });
    const d = dom.window.document;
    await wait(250);
    await toProjects(d, "Work");
    expect(btn(d, /Sign in with Google/i)).toBeTruthy();
    expect(panel(d).textContent).toMatch(/merges rather than replaces/i);

    btn(d, /Change client ID/i).click();
    await wait(200);
    expect(dom.window.localStorage.getItem("meter:google-client")).toBeNull();
    expect(panel(d).textContent).toMatch(/client ID/i);
  }, 25_000);

  it("keeps one action prominent and the rest quiet", async () => {
    // Three buttons abreast read as three equally likely choices. Signing out
    // and changing the client ID are each done once; syncing is done daily.
    const dom = await boot(seed, { "meter:google-client": "abc.apps.googleusercontent.com" });
    const d = dom.window.document;
    await wait(250);
    await toProjects(d, "Work");
    expect(panel(d).querySelectorAll(".btn")).toHaveLength(1);
    expect(panel(d).querySelector(".btn").textContent).toMatch(/Sign in with Google/i);
    expect([...panel(d).querySelectorAll(".linkish")].map((b) => b.textContent))
      .toEqual(["Change client ID"]);
  }, 25_000);

  it("says it is working the moment you press it", async () => {
    // jsdom loads no external script, so the real sign-in cannot complete here;
    // what matters is that pressing the button visibly does something instead of
    // appearing dead. Failing AFTER a blocked load is covered in sync.test.js,
    // where the timeout can be made short.
    const dom = await boot(seed, { "meter:google-client": "abc.apps.googleusercontent.com" });
    const d = dom.window.document;
    await wait(250);
    await toProjects(d, "Work");
    btn(d, /Sign in with Google/i).click();
    await wait(400);
    expect(panel(d).textContent).toMatch(/Syncing/i);
    expect(btn(d, /Sync now|Sign in with Google/i).disabled).toBe(true);
  }, 25_000);

  it("stamps what a change touched, so two devices can be merged later", async () => {
    const { dom, d } = await open();
    d.querySelector(".card").click();
    await wait(250);
    // No task: naming one adds it to the PROJECT, which is a real change to the
    // project and would be stamped correctly.
    await startMeter(dom);

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(typeof saved.sessions[0].updatedAt).toBe("number");
    // and NOT the project, which this change never touched
    expect(saved.projects[0]).not.toHaveProperty("updatedAt");
  }, 30_000);

  it("shows no sync panel on the Life tab, which has no ledger of its own", async () => {
    const dom = await boot(seed);
    const d = dom.window.document;
    await wait(250);
    await toProjects(d, "Life");
    expect(panel(d)).toBeUndefined();
  }, 25_000);
});

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
    await wait(250);
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await wait(200);
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
    await wait(200);
    btn(d, /^Submit 2$/).click();
    await wait(300);

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
    await wait(200);
    btn(d, /^Submit 2$/).click();
    await wait(300);
    btn(d, /^Select all 2$/).click();
    await wait(200);
    btn(d, /^Accepted 2$/).click();
    await wait(300);

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
    await wait(200);
    btn(d, /^Submit 2$/).click();
    await wait(300);
    btn(d, /^Select all 2$/).click();
    await wait(200);

    const when = d.querySelector(".selbar-when input");
    expect(when.type).toBe("datetime-local");
    const at = yesterdayAt(1, 30);
    setValue(dom.window, when, stamp(at));
    await wait(100);
    btn(d, /^Accepted 2$/).click();
    await wait(300);

    expect(stored(dom).projects[0].tasks.map((t) => t.stateAt)).toEqual([at, at]);
  }, 30_000);

  it("lets the time of an answer be corrected afterwards, to the minute", async () => {
    const { dom, d } = await open();
    btn(d, /^Select all 2$/).click();
    await wait(200);
    btn(d, /^Submit 2$/).click();
    await wait(300);
    btn(d, /^Select all 2$/).click();
    await wait(200);
    btn(d, /^Accepted 2$/).click();
    await wait(300);

    const row = taskRows(d).find((r) => r.textContent.includes("1234"));
    [...row.querySelectorAll("button")].find((b) => b.textContent === "edit").click();
    await wait(200);
    const [, back] = d.querySelectorAll('.prompt input[type="datetime-local"]');
    const late = yesterdayAt(23, 45);
    setValue(dom.window, back, stamp(late));
    btn(d, /^Save$/i).click();
    await wait(300);

    const [t1, t2] = stored(dom).projects[0].tasks;
    expect(t1.stateAt).toBe(late);
    expect(t2.stateAt).not.toBe(late); // only the task that was edited
  }, 30_000);

  it("covers a batch with one reward, without splitting it between them", async () => {
    // Fifty tasks paid by one milestone are each paid for, and none of them is
    // worth a fiftieth of it — that price was never quoted.
    const { dom, d } = await open();
    btn(d, /^Select all 2$/).click();
    await wait(200);
    btn(d, /^One reward$/).click();
    await wait(200);
    const amount = [...d.querySelectorAll(".panel input[type=number]")].at(-1);
    setValue(dom.window, amount, "100");
    await wait(150);
    btn(d, /Record for 2 tasks/).click();
    await wait(300);

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
    await wait(200);
    btn(d, /^Submit 2$/).click();
    await wait(300);
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
    await wait(200);
    expect(recovery(d)).toBeNull();
  }, 20_000);

  it("shows in the running bar, and says it is not here", async () => {
    const d = (await boot(elsewhere())).window.document;
    await wait(200);
    const bar = d.querySelector(".runbar");
    expect(bar).not.toBeNull();
    expect(bar.textContent).toMatch(/Overnight/);
    expect(bar.textContent).toMatch(/elsewhere/);
  }, 20_000);

  it("stops from here, and the stop is a real edit that will travel", async () => {
    const dom = await boot(elsewhere());
    const d = dom.window.document;
    await wait(200);
    const before = Date.now();
    btn(d, /^Stop$/).click();
    await wait(250);

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
    await wait(200);
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
    await wait(250);
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await wait(200);
    btn(d, /^Open$/).click();
    await wait(200);
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
    await wait(250);
    expect(rateOf(dom)).toBe(80);
  }, 30_000);

  it("says so, and writes it when asked", async () => {
    const { dom, d } = await openSettings();
    setValue(dom.window, field(d, "Hourly rate"), "45");
    await wait(150);
    expect(d.querySelector(".savebar").textContent).toMatch(/Unsaved changes/);
    btn(d, /Save changes/).click();
    await wait(250);
    expect(rateOf(dom)).toBe(45);
    expect(d.querySelector(".savebar").textContent).toMatch(/^Saved$/);
  }, 30_000);

  it("puts everything back when discarded, and writes nothing", async () => {
    const { dom, d } = await openSettings();
    setValue(dom.window, field(d, "Project name"), "Something else");
    await wait(150);
    btn(d, /^Discard$/).click();
    await wait(200);
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
    await wait(250);
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await wait(200);

    btn(d, /Start the meter/i).click();
    await wait(200);
    const fields = [...d.querySelectorAll(".prompt .field")];
    const input = (label) => fields
      .find((f) => new RegExp(label, "i").test(f.querySelector(".eyebrow")?.textContent ?? ""))
      ?.querySelector("input, textarea");
    setValue(dom.window, input("Name it"), "1234");
    setValue(dom.window, input("^Note$"), "QA-88, rerun weekly");
    await wait(120);
    btn(d, /^Start the meter$/).click();
    await wait(300);

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
    await wait(300);
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
    await wait(300);
    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    const live = saved.sessions.find((s) => s.segments.some((g) => g.endedAt == null));
    expect(live).toMatchObject({ projectId: "a", taskId: "t1" });
  }, 20_000);

  it("puts the one-click starts away while a meter is going", async () => {
    // Starting one closes whatever else is open, so a row of one-click starts
    // beside a running session is a row of one-click ways to end it.
    const { d } = await open();
    d.querySelectorAll(".again")[0].click();
    await wait(300);
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
    await wait(250);
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
    await wait(300);
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
    await wait(250);
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await wait(200);
    return { dom, d };
  };
  const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
  const submitAll = async (d) => {
    btn(d, /^Select all 2$/).click();
    await wait(200);
    btn(d, /^Submit 2$/).click();
    await wait(300);
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
    await wait(200);
    btn(d, /^Accepted 2$/).click();
    await wait(300);
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
    await wait(200);
    btn(d, /^Accepted 2$/).click();
    await wait(300);

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
    await wait(200);
    btn(d, /^Rejected 2$/).click();
    await wait(300);

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
    await wait(200);
    btn(d, /^Rejected 2$/).click();
    await wait(300);
    btn(d, /^Select all 2$/).click();
    await wait(200);
    btn(d, /^Accepted 2$/).click();
    await wait(300);

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
    await wait(200);
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
    await wait(200);
    btn(d, /^Reopen 2$/).click();
    await wait(300);

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
    await wait(200);
    btn(d, /^More per hour$/).click();
    await wait(150);
    const box = [...d.querySelectorAll(".field")]
      .find((f) => /Extra per hour/i.test(f.querySelector(".eyebrow")?.textContent ?? ""))
      .querySelector("input");
    setValue(dom.window, box, "10");
    await wait(150);
    btn(d, /Save changes/).click();
    await wait(300);

    const project = stored(dom).projects[0];
    expect(project.bonusPerHour).toBe(10);
    // The model not chosen is cleared, so the project never holds two answers
    // to what acceptance pays.
    expect(project.perTask).toBeNull();
  }, 30_000);
});

describe("fixes: data, export and layout", () => {
  const stored = (dom) => dom.window.localStorage.getItem("meter:v1");
  const keysOf = (dom) => Array.from(
    { length: dom.window.localStorage.length }, (_, i) => dom.window.localStorage.key(i));
  const bannerSaying = (d, re) => [...d.querySelectorAll(".banner")].find((b) => re.test(b.textContent));

  /** jsdom makes no blob URLs and will not read a Blob back, so a download is
   *  caught on its way in: the text handed to the Blob IS the file. */
  const grab = async (dom, click) => {
    const written = [];
    const RealBlob = dom.window.Blob;
    dom.window.Blob = function Caught(parts, opts) {
      written.push(parts.map(String).join(""));
      return new RealBlob(parts, opts);
    };
    dom.window.URL.createObjectURL = () => "blob:x";
    dom.window.URL.revokeObjectURL = () => {};
    click();
    await wait(300);
    dom.window.Blob = RealBlob;
    return written[0];
  };

  const addProject = async (dom, name) => {
    const d = dom.window.document;
    await toProjects(d, "Work");
    btn(d, /New project/i).click();
    await wait(120);
    const [nameBox, rateBox] = d.querySelectorAll(".panel input");
    setValue(dom.window, nameBox, name);
    setValue(dom.window, rateBox, "50");
    btn(d, /Add project/i).click();
    await wait(200);
  };

  describe("a saved ledger that cannot be read", () => {
    // Most of a real ledger, cut off part-way through its sessions.
    const CUT = JSON.stringify({
      projects: [{ id: "a", name: "Orion", currentRate: 40, currency: "USD", createdAt: 1 }],
      sessions: [{ id: "s1", projectId: "a", kind: "billed", rate: 40, currency: "USD",
                   createdAt: 1, closedAt: 2, deletedAt: null,
                   segments: [{ startedAt: 1, endedAt: 2 }] }],
    }).slice(0, -30);
    const aside = (dom) => keysOf(dom).find((k) => k.startsWith("meter:v1:unreadable:"));
    const unreadableBanner = (d) => bannerSaying(d, /couldn.t be read/i);

    /** Storage with no room for a second copy of the ledger. */
    const bootFull = async (raw) => {
      const full = `<script>
        localStorage.setItem('meter:v1', ${JSON.stringify(raw)});
        const real = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          if (String(k).startsWith('meter:v1:unreadable:')) throw new Error('QuotaExceededError');
          return real.call(this, k, v);
        };
      </script>`;
      const html = readFileSync(DIST, "utf8")
        .replace('<div id="root"></div>', `<div id="root"></div>${full}`);
      const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/" });
      await wait(700);
      return dom;
    };

    it("is kept aside and said so, instead of opening empty in silence", async () => {
      const dom = await boot(null, { "meter:v1": CUT });
      const d = dom.window.document;
      expect(unreadableBanner(d)).toBeTruthy();
      expect(dom.window.localStorage.getItem(aside(dom))).toBe(CUT);
      // The banner names where it went, so it can be found again.
      expect(unreadableBanner(d).textContent).toContain(aside(dom));
      expect(stored(dom)).toBe(CUT);
    }, 25_000);

    it("is still there after the first change, which used to replace it for good", async () => {
      // The reported case: adding one project saved a 221-byte ledger over the
      // whole of the original.
      const dom = await boot(null, { "meter:v1": CUT });
      const key = aside(dom);
      await addProject(dom, "Fresh start");
      expect(JSON.parse(stored(dom)).projects.map((p) => p.name)).toEqual(["Fresh start"]);
      expect(dom.window.localStorage.getItem(key)).toBe(CUT);
    }, 25_000);

    it("can be downloaded exactly as it was stored", async () => {
      const dom = await boot(null, { "meter:v1": CUT });
      const d = dom.window.document;
      const file = await grab(dom, () => btn(unreadableBanner(d), /^Download it$/).click());
      expect(file).toBe(CUT);
    }, 25_000);

    it("points the way to a backup", async () => {
      const dom = await boot(null, { "meter:v1": CUT });
      const d = dom.window.document;
      btn(unreadableBanner(d), /restore a backup/i).click();
      await wait(200);
      expect(btn(d, /^Restore$/)).toBeTruthy();
    }, 25_000);

    it("is not saved over at all while there is no room to keep a copy, until it is downloaded", async () => {
      const dom = await bootFull(CUT);
      const d = dom.window.document;
      expect(aside(dom)).toBeUndefined();
      expect(unreadableBanner(d).textContent).toMatch(/nothing will be saved over it/i);
      // No way to put the warning away while it is the only thing standing
      // between the original and the next save.
      expect(btn(unreadableBanner(d), /Dismiss/)).toBeUndefined();

      await addProject(dom, "Fresh start");
      expect(stored(dom)).toBe(CUT);
      expect(d.querySelector(".card-name").textContent).toContain("Fresh start");

      expect(await grab(dom, () => btn(unreadableBanner(d), /^Download it$/).click())).toBe(CUT);
      await wait(200);
      // The user holds the original now, so what is on screen is saved.
      expect(JSON.parse(stored(dom)).projects.map((p) => p.name)).toEqual(["Fresh start"]);
      expect(unreadableBanner(d).textContent).toMatch(/saving has started again/i);
    }, 30_000);

    it("says nothing when the ledger reads fine", async () => {
      const dom = await boot({ projects: [], sessions: [] });
      expect(unreadableBanner(dom.window.document)).toBeUndefined();
      expect(aside(dom)).toBeUndefined();
    }, 25_000);
  });

  describe("the backup nudge", () => {
    const HOUR = 3_600_000;
    const ago = (days) => Date.now() - days * 86_400_000;
    const ledger = (count) => ({
      projects: [{ id: "a", name: "Orion", currentRate: 40, currency: "USD", createdAt: ago(30),
                   sessionGoal: null, overallGoal: null, tasks: [] }],
      sessions: Array.from({ length: count }, (_, i) => ({
        id: `s${i}`, projectId: "a", kind: "billed", taskId: null, rate: 40, currency: "USD",
        createdAt: ago(3 + i), closedAt: ago(3 + i) + HOUR, deletedAt: null,
        segments: [{ startedAt: ago(3 + i), endedAt: ago(3 + i) + HOUR }],
      })),
    });
    const nudge = (d) => bannerSaying(d, /backed up/i).textContent;

    it("says one record exists, not exist", async () => {
      const dom = await boot(ledger(1));
      expect(nudge(dom.window.document)).toMatch(/1 record exists only in this browser/);
    }, 25_000);

    it("still says records exist when there are more", async () => {
      const dom = await boot(ledger(2));
      expect(nudge(dom.window.document)).toMatch(/2 records exist only in this browser/);
    }, 25_000);
  });

  describe("the CSV export", () => {
    const HOUR = 3_600_000;
    const back = (days) => Date.now() - days * 86_400_000;
    const exportCsv = async (seed) => {
      const dom = await boot(seed);
      const d = dom.window.document;
      await toProjects(d, "Work");
      return grab(dom, () => btn(d, /Export CSV/i).click());
    };

    it("opens with a byte-order mark, so Excel reads names as UTF-8", async () => {
      // Without it Excel on Windows used the ANSI code page, and Arabic names,
      // emoji and the "·" in notes came out as mojibake.
      const csv = await exportCsv({
        projects: [{ id: "a", name: "مشروع 🚀", currentRate: 20, currency: "USD", createdAt: back(40),
                     sessionGoal: null, overallGoal: null, tasks: [] }],
        sessions: [{ id: "s1", projectId: "a", kind: "billed", taskId: null, rate: 20, currency: "USD",
                     createdAt: back(2), closedAt: back(2) + HOUR, deletedAt: null,
                     segments: [{ startedAt: back(2), endedAt: back(2) + HOUR }] }],
        lastBackupAt: back(1),
      });
      expect(csv.charCodeAt(0)).toBe(0xFEFF);
      expect(csv.slice(1).startsWith('"Date"')).toBe(true);
      expect(csv).toContain('"مشروع 🚀"');
    }, 25_000);
  });

  describe("restoring a backup", () => {
    const HOUR = 3_600_000;
    const at = (y, m, d, h = 9) => new Date(y, m, d, h).getTime();
    const project = (id, name) => ({
      id, name, currentRate: 40, currency: "USD", createdAt: at(2024, 0, 1),
      sessionGoal: null, overallGoal: null, tasks: [],
    });
    const session = (id, projectId, start) => ({
      id, projectId, kind: "billed", taskId: null, rate: 40, currency: "USD",
      createdAt: start, closedAt: start + HOUR, deletedAt: null,
      segments: [{ startedAt: start, endedAt: start + HOUR }],
    });
    const mine = {
      projects: [project("a", "Orion"), project("b", "Lumen")],
      sessions: [
        session("s1", "a", at(2025, 2, 4)), session("s2", "b", at(2025, 5, 9)),
        session("s3", "a", at(2025, 8, 1)),
        // Deleted: it is in storage, and in no count a person would recognise.
        { ...session("s4", "a", at(2025, 8, 2)), deletedAt: at(2025, 8, 3) },
      ],
      lastBackupAt: at(2025, 8, 2),
    };
    const file = {
      projects: [project("x", "Gateway")],
      sessions: [session("f1", "x", at(2024, 0, 15))],
      earnings: [{
        id: "e1", projectId: "x", kind: "piece", cents: 5_000, currency: "USD",
        at: at(2024, 1, 2, 12), createdAt: at(2024, 1, 2), deletedAt: null,
      }],
    };
    const names = (dom) => JSON.parse(stored(dom)).projects.map((p) => p.name);
    const panel = (d) => d.querySelector(".restore");

    /** What the file picker hands over when a file is chosen. Polled rather
     *  than slept on: the file is read asynchronously, and the first read in
     *  a cold run can take longer than any fixed wait worth writing down. */
    const pick = async (dom, content, name = "meter-2024-02-03.json") => {
      const d = dom.window.document;
      await toProjects(d, "Work");
      const input = d.querySelector("input[type=file]");
      const chosen = new dom.window.File([content], name, { type: "application/json" });
      Object.defineProperty(input, "files", { value: [chosen], configurable: true });
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      for (let waited = 0; waited < 5000 && !d.querySelector(".restore, .toast"); waited += 50) {
        await wait(50);
      }
      await wait(100);
    };

    it("asks first, setting what would be replaced beside what the file holds", async () => {
      const dom = await boot(mine);
      await pick(dom, JSON.stringify(file));
      const d = dom.window.document;
      expect(panel(d).textContent).toMatch(/replaces everything here/i);
      expect(panel(d).textContent).toContain("meter-2024-02-03.json");
      const [here, there] = [...panel(d).querySelectorAll("dd")].map((x) => x.textContent);
      expect(here).toMatch(/^2 projects and 3 sessions, from .*2025.* to .*2025/);
      expect(there).toMatch(/^1 project, 1 session and 1 payment, from .*2024.* to .*2024/);
      // Picking the file changed nothing.
      expect(names(dom)).toEqual(["Orion", "Lumen"]);
    }, 25_000);

    it("replaces the ledger only on Replace my ledger, and can still be undone", async () => {
      const dom = await boot(mine);
      await pick(dom, JSON.stringify(file));
      const d = dom.window.document;
      btn(d, /^Replace my ledger$/).click();
      await wait(250);
      expect(names(dom)).toEqual(["Gateway"]);
      expect(panel(d)).toBeNull();
      expect(d.querySelector(".toast").textContent).toMatch(/Backup restored/);
      btn(d.querySelector(".toast"), /^Undo$/).click();
      await wait(250);
      expect(names(dom)).toEqual(["Orion", "Lumen"]);
    }, 25_000);

    it("leaves everything as it was on Cancel", async () => {
      const dom = await boot(mine);
      const before = stored(dom);
      await pick(dom, JSON.stringify(file));
      const d = dom.window.document;
      btn(panel(d), /^Cancel$/).click();
      await wait(200);
      expect(panel(d)).toBeNull();
      expect(stored(dom)).toBe(before);
      expect(btn(d, /^Restore$/)).toBeTruthy();
    }, 25_000);

    it("is the way back from a ledger that could not be read", async () => {
      const dom = await boot(null, { "meter:v1": "{not json" });
      const d = dom.window.document;
      btn(bannerSaying(d, /couldn.t be read/i), /restore a backup/i).click();
      await wait(200);
      await pick(dom, JSON.stringify(file));
      expect(panel(d).querySelector("dd").textContent).toBe("nothing at all");
      btn(panel(d), /^Replace my ledger$/).click();
      await wait(250);
      expect(names(dom)).toEqual(["Gateway"]);
    }, 25_000);

    it("turns away a file that is not a backup without asking anything", async () => {
      const dom = await boot(mine);
      await pick(dom, '{"nope":1}', "notes.json");
      const d = dom.window.document;
      expect(panel(d)).toBeNull();
      expect(d.querySelector(".toast").textContent).toMatch(/isn.t a Meter backup/);
      expect(names(dom)).toEqual(["Orion", "Lumen"]);
    }, 25_000);
  });

  describe("the top bar on a narrow phone", () => {
    it("narrows the tabs with the screen, so 320px does not scroll sideways", () => {
      // Only a real browser can measure this, so it was measured in one: at
      // 320px the tab bar stuck out 39px before and fits now, on all four main
      // screens in both themes, and from 390px up every tab is exactly as wide
      // as it was. What is pinned here are the two declarations that do it.
      const css = readFileSync(DIST, "utf8");
      const tab = css.match(/\.tab\{([^}]*)/)?.[1];
      expect(tab).toContain("padding:8px clamp(5px,calc((100vw - 300px) / 6),15px)");
      expect(tab).not.toContain("padding:8px 15px");
      // And if the tabs still cannot fit beside the name, they wrap below it
      // rather than push the page wider than the screen.
      expect(css.match(/\.topbar\{([^}]*)/)?.[1]).toContain("flex-wrap:wrap");
    });
  });
});

describe("fixes: clock, Today and Overview", () => {
  /** A named wall-clock instant in the zone the suite runs in. Every test in
   *  this block pins the page's clock to one of these, so none of them
   *  depends on the day, the weekday or the hour it happens to run at. Early
   *  October 2026: Sunday the 4th, Monday the 5th, Wednesday the 7th. */
  const at = (m, d, h = 0, min = 0) => new Date(2026, m - 1, d, h, min).getTime();

  /**
   * Boots with the page's clock set to `instant` rather than the real one.
   *
   * `Date.now` in the page reads the real clock plus a shift, so time still
   * passes while a test runs, and `window.__setNow` moves it on. `lapse` runs
   * the page's long timers (ten seconds and over) every 200ms instead, so a
   * thirty-second tick can be watched without waiting thirty seconds.
   */
  const bootAt = async (seed, instant, { settings = null, lapse = false } = {}) => {
    let html = readFileSync(DIST, "utf8");
    const clock = `<script>(() => {
      const real = Date.now.bind(Date);
      let shift = ${instant} - real();
      Date.now = () => real() + shift;
      window.__setNow = (t) => { shift = t - real(); };
      ${lapse ? "const every = window.setInterval.bind(window);"
        + " window.setInterval = (fn, ms, ...rest) => every(fn, ms >= 10000 ? 200 : ms, ...rest);" : ""}
    })();</script>`;
    const sets = [
      seed && `localStorage.setItem('meter:v1', ${JSON.stringify(JSON.stringify(seed))});`,
      ...Object.entries(settings ?? {}).map(
        ([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`),
    ].filter(Boolean);
    html = html.replace('<div id="root"></div>',
      `<div id="root"></div>${clock}<script>${sets.join("")}</script>`);
    const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/" });
    await wait(700);
    return dom;
  };

  const project = (id, name, extra = {}) => ({
    id, name, currentRate: 60, currency: "USD", createdAt: at(8, 1),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  const sitting = (id, projectId, from, to, extra = {}) => ({
    id, projectId, kind: "billed", taskId: null, rate: 60, currency: "USD",
    createdAt: from, closedAt: to, deletedAt: null,
    segments: [{ startedAt: from, endedAt: to }], ...extra,
  });
  /** The Today tab's section for the day, found by its heading. */
  const todaySec = (d) => [...d.querySelectorAll(".sec")]
    .find((s) => /^Today/.test(s.querySelector(".sec-head")?.textContent ?? ""));
  /** What that section's heading says the day came to. */
  const todayHead = (d) => todaySec(d).querySelectorAll(".sec-head .eyebrow")[1].textContent;
  const short = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

  describe("the clock moves with no meter running", () => {
    const seed = () => ({
      projects: [project("a", "Acme")],
      sessions: [sitting("s1", "a", at(10, 4, 20), at(10, 4, 21))],
    });

    it("turns Today over to the new day on its own", async () => {
      // Opened on Sunday night and still open on Monday morning. Nothing is
      // running, so only the idle tick can carry the app across midnight.
      const dom = await bootAt(seed(), at(10, 4, 23), { lapse: true });
      const d = dom.window.document;
      expect(todayHead(d)).toBe("$60.00 · 1h 00m");

      dom.window.__setNow(at(10, 5, 10));
      await wait(700);
      expect(todayHead(d)).toBe("nothing yet");
      expect(d.querySelector(".panel .empty").textContent).toMatch(/Nothing recorded today/);
    }, 20_000);

    it("catches up as soon as the app is looked at again", async () => {
      // A tab in the background, or a laptop asleep overnight, has its timers
      // held back: coming back to it must not show the week it was left on.
      const dom = await bootAt(seed(), at(10, 4, 23));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      const span = () => d.querySelector(".dash-sub").textContent;
      expect(span()).toContain(short(at(9, 28)));
      expect(d.querySelector(".grand-amt").textContent).toBe("$60.00");

      dom.window.__setNow(at(10, 5, 10));
      d.dispatchEvent(new dom.window.Event("visibilitychange"));
      await wait(250);
      expect(span()).toContain(short(at(10, 5)));
      expect(d.querySelector(".grand-amt").textContent).toBe("—");

      dom.window.__setNow(at(10, 12, 10));
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      await wait(250);
      expect(span()).toContain(short(at(10, 12)));
    }, 20_000);
  });

  describe("Today counts work, not sleep", () => {
    // An hour and a half of paid work, and a night's sleep tracked at a rate
    // that ran from 23:00 into this morning: seven of its hours are today's.
    const seed = () => ({
      projects: [
        project("a", "Acme", { currentRate: 40 }),
        project("z", "Sleep", { currentRate: 10, offClock: true }),
      ],
      sessions: [
        sitting("s1", "a", at(10, 5, 9), at(10, 5, 10, 30), { rate: 40 }),
        sitting("s2", "z", at(10, 4, 23), at(10, 5, 7), { rate: 10 }),
      ],
    });

    it("keeps off-the-clock time out of the day's heading", async () => {
      const dom = await bootAt(seed(), at(10, 5, 12));
      const d = dom.window.document;
      expect(todayHead(d)).toBe("$60.00 · 1h 30m");
      // and out of the same day's heading under Recent
      expect(d.querySelector(".day .day-sum").textContent).toBe("$60.00 · 1h 30m");
    }, 20_000);

    it("still lists the sleep with its hours, below the work and marked", async () => {
      const dom = await bootAt(seed(), at(10, 5, 12));
      const d = dom.window.document;
      const rows = [...todaySec(d).querySelectorAll(".trow")];
      expect(rows.map((r) => r.querySelector(".trow-label").textContent)).toEqual(["Acme", "Sleep"]);
      expect(rows[1].querySelector(".trow-sub").textContent).toMatch(/off the clock/);
      expect(rows[1].querySelector(".trow-time").textContent).toBe("7h 00m");
      expect(rows[1].querySelector(".trow-amt")).toBeNull();
    }, 20_000);
  });

  describe("a sitting across midnight in the Recent list", () => {
    /** The figure in a row or heading, as a number of dollars. */
    const dollars = (text) => Number(text.replace(/[^0-9.]/g, ""));
    // An hour before midnight and two after, then an hour on Monday morning.
    const seed = () => ({
      projects: [project("a", "Acme")],
      sessions: [
        sitting("s1", "a", at(10, 4, 23), at(10, 5, 2)),
        sitting("s2", "a", at(10, 5, 9), at(10, 5, 10)),
      ],
    });

    it("is listed under each day with that day's share of the hours and the money", async () => {
      const dom = await bootAt(seed(), at(10, 5, 12));
      const d = dom.window.document;
      const [monday, sunday] = [...d.querySelectorAll(".day")];
      expect(monday.querySelector(".day-sum").textContent).toBe("$180.00 · 3h 00m");
      expect(sunday.querySelector(".day-sum").textContent).toBe("$60.00 · 1h 00m");

      const carried = [...monday.querySelectorAll(".row")]
        .find((r) => /of 3h 00m/.test(r.querySelector(".row-meta").textContent));
      expect(carried.querySelector(".row-meta").textContent).toBe("2h 00m of 3h 00m");
      expect(carried.querySelector(".row-amt").textContent).toBe("$120.00");
      // it says which day it started on, since Monday's list holds no start
      expect(carried.querySelector(".row-when").textContent).toContain(short(at(10, 4)));

      const started = sunday.querySelector(".row");
      expect(started.querySelector(".row-meta").textContent)
        .toBe("1h 00m of 3h 00m · ran past midnight");
      expect(started.querySelector(".row-amt").textContent).toBe("$60.00");
    }, 20_000);

    it("leaves every day's rows adding up to its heading", async () => {
      const dom = await bootAt(seed(), at(10, 5, 12));
      for (const day of dom.window.document.querySelectorAll(".day")) {
        const rows = [...day.querySelectorAll(".row-amt")]
          .reduce((sum, r) => sum + dollars(r.textContent), 0);
        expect(rows).toBeCloseTo(dollars(day.querySelector(".day-sum").textContent.split(" · ")[0]), 2);
      }
    }, 20_000);
  });

  describe("rows whose money has not landed", () => {
    // Three hours on Monday: one paid, one waiting on an answer, one rejected.
    const seed = () => ({
      projects: [project("a", "Acme")],
      sessions: [
        sitting("s1", "a", at(10, 5, 9), at(10, 5, 10)),
        sitting("s2", "a", at(10, 5, 10), at(10, 5, 11), { status: "pending" }),
        sitting("s3", "a", at(10, 5, 11), at(10, 5, 12), { status: "cancelled" }),
      ],
    });
    const rowOf = (d, id) => {
      // newest first: the rejected hour, the pending one, then the paid one
      const order = ["s3", "s2", "s1"];
      return d.querySelectorAll(".day .row")[order.indexOf(id)];
    };
    const tags = (row) => [...row.querySelectorAll(".tag")].map((t) => t.textContent);

    it("marks a rejected sitting and strikes its money, as the ledger does", async () => {
      const dom = await bootAt(seed(), at(10, 5, 13));
      const row = rowOf(dom.window.document, "s3");
      expect(tags(row)).toEqual(["cancelled"]);
      expect(row.className).toMatch(/\bis-void\b/);
    }, 20_000);

    it("marks a sitting still waiting on an answer as pending", async () => {
      const dom = await bootAt(seed(), at(10, 5, 13));
      const d = dom.window.document;
      expect(tags(rowOf(d, "s2"))).toEqual(["pending"]);
      expect(rowOf(d, "s2").className).not.toMatch(/is-void/);
      expect(tags(rowOf(d, "s1"))).toEqual([]);
    }, 20_000);

    it("says in the heading what is pending, apart from what was earned", async () => {
      // Every row's figure is then in the heading or visibly struck out of it.
      const dom = await bootAt(seed(), at(10, 5, 13));
      const d = dom.window.document;
      expect(d.querySelector(".day .day-sum").textContent).toBe("$60.00 · 3h 00m · $60.00 pending");
      expect(todayHead(d)).toBe("$60.00 · 3h 00m · $60.00 pending");
    }, 20_000);
  });

  describe("comparing with the period before", () => {
    // Read on Wednesday at noon. This week: two hours on Monday. Last week:
    // an hour on Monday, then eight on Thursday, which this week has not
    // reached yet. The week before that: three hours.
    const seed = () => ({
      projects: [project("a", "Acme", { currentRate: 100 })],
      sessions: [
        sitting("s1", "a", at(10, 5, 9), at(10, 5, 11), { rate: 100 }),
        sitting("s2", "a", at(9, 28, 9), at(9, 28, 10), { rate: 100 }),
        sitting("s3", "a", at(10, 1, 9), at(10, 1, 17), { rate: 100 }),
        sitting("s4", "a", at(9, 21, 9), at(9, 21, 12), { rate: 100 }),
      ],
    });
    const deltas = (d) => [...d.querySelectorAll(".delta")].map((x) => x.textContent);

    it("sets the week so far against last week up to the same point", async () => {
      // $200 by Wednesday noon against $100 by last Wednesday noon. Against
      // all of last week, $900, the same week read as 78% down.
      const dom = await bootAt(seed(), at(10, 7, 12));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      expect(d.querySelector(".grand-amt").textContent).toBe("$200.00");
      expect(d.querySelector(".dash-sub .delta").textContent).toBe("+100% vs this point last week");
      expect(deltas(d)).toContain("+100% vs this point last week"); // the Billed tile, in hours
      expect(deltas(d).some((t) => /78%/.test(t))).toBe(false);
    }, 20_000);

    it("sets a week that is over against the whole week before it, and says so", async () => {
      const dom = await bootAt(seed(), at(10, 7, 12));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      d.querySelectorAll(".step")[0].click();
      await wait(250);
      expect(d.querySelector(".grand-amt").textContent).toBe("$900.00");
      expect(d.querySelector(".dash-sub .delta").textContent).toBe("+200% vs the week before");
    }, 20_000);
  });

  describe("two currencies in one week", () => {
    const fmt = (cents, currency) => new Intl.NumberFormat(undefined, {
      style: "currency", currency, minimumFractionDigits: 2,
    }).format(cents / 100);
    // $40 and EGP 300 on Tuesday, $30 on Wednesday: three dollar hours and
    // one pound hour. And a night's sleep at $10 an hour, which is no money.
    const seed = () => ({
      projects: [
        project("u", "USD work", { currentRate: 20 }),
        project("e", "EGP work", { currentRate: 300, currency: "EGP" }),
        project("u2", "USD work 2", { currentRate: 30 }),
        project("z", "Sleep", { currentRate: 10, offClock: true }),
      ],
      sessions: [
        sitting("s1", "u", at(10, 6, 9), at(10, 6, 11), { rate: 20 }),
        sitting("s2", "e", at(10, 6, 12), at(10, 6, 13), { rate: 300, currency: "EGP" }),
        sitting("s3", "u2", at(10, 7, 9), at(10, 7, 10), { rate: 30 }),
        sitting("s4", "z", at(10, 6, 23), at(10, 7, 7), { rate: 10 }),
      ],
    });
    const open = async () => {
      const dom = await bootAt(seed(), at(10, 7, 18));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      return d;
    };

    it("leads with the currency the hours were in, not the bigger number", async () => {
      const d = await open();
      expect(d.querySelector(".grand-amt").textContent).toBe("$70.00");
      expect(d.querySelector(".grand-alt").textContent).toBe(fmt(30_000, "EGP"));
    }, 20_000);

    it("quotes an hour in each currency over that currency's own hours", async () => {
      // EGP 300 over all four hours read "EGP 75.00/hr", a rate nobody paid.
      const d = await open();
      const hours = [...d.querySelectorAll(".tile")]
        .filter((t) => /An hour came to/.test(t.textContent))
        .map((t) => t.querySelector(".tile-val").textContent);
      expect(hours).toEqual([`${fmt(2_333, "USD")}/hr`, `${fmt(30_000, "EGP")}/hr`]);
    }, 20_000);

    it("lists each currency in a day's tooltip rather than adding them", async () => {
      const d = await open();
      const tip = (i) => [...d.querySelectorAll(".tcol")[i].querySelectorAll(".ttip span")]
        .map((s) => s.textContent);
      // Monday first: Tuesday is the second column, Wednesday the third.
      expect(tip(1)).toEqual(["3h 00m billed", fmt(4_000, "USD"), fmt(30_000, "EGP")]);
      expect(tip(2)).toEqual(["1h 00m billed", fmt(3_000, "USD")]);
    }, 20_000);

    it("draws no share of a total that would add pounds to dollars", async () => {
      // "EGP work is 100% of it" left $70 of dollar work out of "it".
      const d = await open();
      expect(d.querySelector(".concentration")).toBeNull();
    }, 20_000);

    it("compares each currency with itself, and says against what once", async () => {
      const d = await open();
      const deltas = [...d.querySelectorAll(".dash-sub .delta")].map((x) => x.textContent);
      expect(deltas).toEqual(["USD —", "EGP — vs this point last week"]);
    }, 20_000);
  });

  describe("one client typed two ways", () => {
    it("is one company in By company, under the spelling met first", async () => {
      // The payday rule already reads these as one client. By company listed
      // them as two, each with half of the money.
      const dom = await bootAt({
        projects: [
          project("a", "Pref", { currentRate: 100, company: "Northwind" }),
          project("b", "Reviews", { currentRate: 100, company: "northwind" }),
        ],
        sessions: [
          sitting("s1", "a", at(10, 5, 9), at(10, 5, 11), { rate: 100 }),
          sitting("s2", "b", at(10, 6, 9), at(10, 6, 12), { rate: 100 }),
        ],
      }, at(10, 7, 12));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      const rows = [...d.querySelectorAll(".crow")];
      expect(rows).toHaveLength(1);
      expect(rows[0].querySelector(".crow-name").textContent).toBe("Northwind");
      expect(rows[0].querySelector(".crow-amt").textContent).toBe("$500.00");
      expect(rows[0].textContent).toMatch(/2 projects/);
      expect([...d.querySelectorAll(".sec-head")].some((h) => /By company1 company$/.test(h.textContent)))
        .toBe(true);
    }, 20_000);
  });

  describe("the activity legend with few days on it", () => {
    it("states each boundary once", async () => {
      // Two days of two hours: every quantile is the same day, and the legend
      // read "to 2h 00m" three times before "over 2h 00m".
      const dom = await bootAt({
        projects: [project("a", "Acme")],
        sessions: [
          sitting("s1", "a", at(10, 2, 9), at(10, 2, 11)),
          sitting("s2", "a", at(10, 5, 9), at(10, 5, 11)),
        ],
      }, at(10, 7, 12));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      const legend = [...d.querySelectorAll(".hm-legend .legend-item")].map((e) => e.textContent);
      expect(legend).toEqual(["to 2h 00m", "over 2h 00m"]);
      expect(d.querySelector(`.hm-cell[data-at="${at(10, 5)}"]`).dataset.level).toBe("1");
    }, 25_000);
  });

  describe("money targets and the money no clock measured", () => {
    const weekly = (target) => ({ overallGoal: { type: "money", target, period: "week" } });
    const earning = (id, projectId, cents, when, extra = {}) => ({
      id, projectId, kind: "bonus", cents, currency: "USD", at: when, note: "",
      createdAt: when, deletedAt: null, ...extra,
    });
    // Alpha: two hours at $60 and a $60 bonus this week, and $100 more still
    // waiting on an answer. Beta is paid per accepted item, never by the clock.
    const seed = () => ({
      projects: [
        project("a", "Alpha", weekly(500)),
        project("b", "Beta", { currentRate: 0, perTask: 50, ...weekly(300) }),
      ],
      sessions: [sitting("s1", "a", at(10, 5, 9), at(10, 5, 11))],
      earnings: [
        earning("e1", "a", 6_000, at(10, 6, 12)),
        earning("e2", "a", 10_000, at(10, 6, 13), { status: "pending" }),
        earning("e3", "b", 15_000, at(10, 6, 12), { kind: "piece", units: 3 }),
      ],
    });
    const target = (d, name) => [...d.querySelectorAll(".trg")]
      .find((t) => t.querySelector(".trg-name").textContent === name)
      .querySelector(".goal-val").textContent;

    it("counts a settled bonus toward the week's target on the Overview", async () => {
      const dom = await bootAt(seed(), at(10, 7, 12));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      expect(target(d, "Alpha")).toBe("$180.00 / $500.00");
    }, 20_000);

    it("lets a target move on a project paid per accepted item", async () => {
      const dom = await bootAt(seed(), at(10, 7, 12));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      expect(target(d, "Beta")).toBe("$150.00 / $300.00");
    }, 20_000);

    it("reads the same on the project's own page", async () => {
      const dom = await bootAt(seed(), at(10, 7, 12));
      const d = dom.window.document;
      await toProjects(d, "Work");
      [...d.querySelectorAll(".card")].find((c) => /Alpha/.test(c.textContent)).click();
      await wait(250);
      expect(d.querySelector(".goal .goal-val").textContent).toBe("$180.00 / $500.00");
    }, 20_000);
  });
});

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
    await wait(250);
    const d = dom.window.document;
    await toProjects(d, "Work");
    [...d.querySelectorAll(".card")].find((c) => c.textContent.includes(name)).click();
    await wait(250);
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
    await wait(200);
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
    await wait(300);
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
    await wait(300);
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
    await wait(200);
    expect(field(d, "Project name").value).toBe("Alpha");

    d.querySelector(".runbar-what").click();
    await wait(300);
    expect(d.querySelector(".plate-name").textContent).toContain("Beta");
    if (btn(d, /^Open$/)) {
      btn(d, /^Open$/).click();
      await wait(200);
    }
    expect(field(d, "Project name").value).toBe("Beta");
    expect(field(d, "Hourly rate").value).toBe("70");

    setValue(dom.window, field(d, "Hourly rate"), "75");
    await wait(150);
    btn(d, /Save changes/).click();
    await wait(300);
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
    await wait(300);
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
    await wait(200);
    const name = field(d.querySelector(".prompt"), "Name it");
    setValue(dom.window, name, " t-1 ");
    await wait(150);

    const warning = d.querySelector(".prompt .hint.warn");
    expect(warning.textContent).toMatch(/“T-1” was submitted, so it takes no more time/);
    expect(btn(d, /^Start the meter$/).disabled).toBe(true);
    name.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(200);

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
    await wait(150);
    btn(d, /Assign to task/).click();
    await wait(200);
    setValue(dom.window, field(d.querySelector(".prompt"), "Name it"), "T-1");
    await wait(150);

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
    await wait(150);
    btn(d, /Assign to task/).click();
    await wait(200);
    setValue(dom.window, d.querySelector(".prompt select"), "t2");
    await wait(150);

    taskRow(d, "T-2").querySelector(".row-check").click();
    await wait(200);
    btn(d, /^Submit 1$/).click();
    await wait(300);

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
    await wait(200);
    expect([...field(d.querySelector(".prompt"), "^Task$").options].map((o) => o.textContent))
      .toEqual(["No task", "T-2"]);
  }, 30_000);

  it("says why typed-in time was refused, and keeps what was typed", async () => {
    const { dom, d } = await openProject(twoTasks(), "Acme");
    btn(d, /add time/i).click();
    await wait(200);
    const [from, to] = d.querySelectorAll('.prompt input[type="datetime-local"]');
    const at = minute(Date.now()) - 30 * HOUR;
    setValue(dom.window, from, stamp(at));
    setValue(dom.window, to, stamp(at + HOUR));
    await wait(150);
    // The project stops taking time while the form is still open.
    btn(d, /^Open$/).click();
    await wait(200);
    btn(d, /^Paused$/).click();
    await wait(250);

    btn(d, /^Add time$/).click();
    await wait(250);
    expect(d.querySelector(".toast").textContent)
      .toMatch(/Nothing was added\. This project is on hold, so it won't take new time\./);
    expect(d.querySelector(".prompt input[type=\"datetime-local\"]").value).toBe(stamp(at));
    expect(stored(dom).sessions).toHaveLength(2);
  }, 30_000);

  it("says so in the form when the task picked there is handed in meanwhile", async () => {
    const { dom, d } = await openProject(twoTasks(), "Acme");
    btn(d, /add time/i).click();
    await wait(200);
    setValue(dom.window, field(d.querySelector(".prompt"), "^Task$"), "t2");
    await wait(150);
    taskRow(d, "T-2").querySelector(".row-check").click();
    await wait(200);
    btn(d, /^Submit 1$/).click();
    await wait(300);

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
    await wait(150);
    expect(form.querySelector(".hint.warn").textContent).toMatch(/can't be below zero/);
    expect(btn(d, /^Save$/).disabled).toBe(true);
    setValue(dom.window, rate, "abc");
    await wait(150);
    expect(form.querySelector(".hint.warn").textContent).toMatch(/“abc” isn't a rate/);
    rate.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(200);
    expect(stored(dom).projects[0].tasks[1].rate).toBe(35);

    setValue(dom.window, rate, "12,5");
    await wait(150);
    expect(form.querySelector(".hint.warn")).toBeNull();
    btn(d, /^Save$/).click();
    await wait(300);
    expect(stored(dom).projects[0].tasks[1].rate).toBe(12.5);
  }, 30_000);

  it("refuses to give a task another task's name", async () => {
    // Two tasks could both be "T-b", and the prompt then resolved the name to
    // the first one, leaving the second out of reach by name.
    const { dom, d } = await openProject(twoTasks(), "Acme");
    await press(taskRow(d, "T-2"), "edit");
    const form = d.querySelector(".prompt");
    setValue(dom.window, field(form, "^Name$"), " t-1 ");
    await wait(150);

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
    await wait(150);
    expect(d.querySelector(".prompt .hint.warn").textContent).toMatch(/It ends before it starts/);
    expect(d.querySelector(".preview-now").textContent).toBe("—");
    expect(btn(d, /Save correction/).disabled).toBe(true);

    setValue(dom.window, end, stamp(a.segments[0].startedAt));
    await wait(150);
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
    await wait(150);
    expect(d.querySelector(".clash").textContent).toMatch(/overlaps 1 record/);
    expect(d.querySelector(".clash li").textContent).toMatch(/T-2/);
    expect(d.querySelector(".clash-ok").textContent).toMatch(/Save it anyway/);
    expect(btn(d, /Save correction/).disabled).toBe(true);

    d.querySelector(".clash-ok input").click();
    await wait(150);
    btn(d, /Save correction/).click();
    await wait(300);
    expect(stored(dom).sessions.find((x) => x.id === "s1").closedAt).toBe(stretched);
  }, 30_000);

  it("will not add earnings without a day to put them on", async () => {
    // Added with the date box cleared, $40 was stored with no date: the week
    // it was earned in read $40 short, and the CSV would have dated it 1970.
    const { dom, d } = await openProject(twoTasks(), "Acme");
    btn(d, /Add earnings/).click();
    await wait(200);
    const form = d.querySelector(".ern-form");
    setValue(dom.window, field(form, "^Amount"), "40");
    setValue(dom.window, field(form, "^Date$"), "");
    await wait(150);

    expect(form.querySelector(".hint.warn").textContent).toMatch(/Pick the day it was earned/);
    expect(btn(d, /^Add$/).disabled).toBe(true);
    btn(d, /^Add$/).click();
    await wait(200);
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
    await wait(200);
    setValue(dom.window, field(d, "Project name"), "Alpha renamed");
    await wait(150);

    btn(d, /^Close$/).click();
    await wait(200);
    expect(settingsTag(d).textContent).toBe("Unsaved");

    btn(d, /All projects/).click();
    await wait(250);
    await toProjects(d, "Work");
    [...d.querySelectorAll(".card")].find((c) => c.textContent.includes("Alpha")).click();
    await wait(250);
    expect(settingsTag(d).textContent).toBe("Unsaved");
    expect(stored(dom).projects[0].name).toBe("Alpha");

    btn(d, /^Open$/).click();
    await wait(200);
    expect(field(d, "Project name").value).toBe("Alpha renamed");
    expect(d.querySelector(".savebar").textContent).toMatch(/Unsaved changes/);
    btn(d, /Save changes/).click();
    await wait(250);
    expect(stored(dom).projects[0].name).toBe("Alpha renamed");
    btn(d, /^Close$/).click();
    await wait(200);
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
    await wait(200);
    setValue(dom.window, field(d, "Hourly rate"), "45");
    await wait(150);
    expect(closing()).toBe(true);

    btn(d, /^Discard$/).click();
    await wait(200);
    expect(closing()).toBe(false);
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
    await wait(250);
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await wait(250);
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
    await wait(200);
    btn(d, /^Submit 1$/).click();
    await wait(300);
  };

  it("keeps a task handed in under the open move prompt in its box", async () => {
    // It left the list when it was submitted, so the box showed "No task"
    // while the warning named T-2, and choosing "No task" changed nothing.
    const { dom, d } = await open(seed());
    [...d.querySelectorAll(".row")]
      .find((r) => r.querySelector(".row-meta")?.textContent.startsWith("No task"))
      .querySelector(".row-check").click();
    await wait(150);
    btn(d, /Assign to task/).click();
    await wait(200);
    setValue(dom.window, d.querySelector(".prompt select"), "t2");
    await wait(150);
    await submitT2(d);

    const select = d.querySelector(".prompt select");
    expect(select.selectedOptions[0].textContent).toBe("T-2");
    expect(select.selectedOptions[0].disabled).toBe(true);
    setValue(dom.window, select, "t1");
    await wait(150);
    expect(d.querySelector(".prompt .hint.warn")).toBeNull();
    expect(inPrompt(d, /^Move 1 session$/).disabled).toBe(false);
  }, 30_000);

  it("keeps a task handed in under the open Add time form in its box", async () => {
    const { dom, d } = await open(seed());
    btn(d, /add time/i).click();
    await wait(200);
    setValue(dom.window, field(d.querySelector(".prompt"), "^Task$"), "t2");
    await wait(150);
    await submitT2(d);

    const select = field(d.querySelector(".prompt"), "^Task$");
    expect(select.selectedOptions[0].textContent).toBe("T-2");
    expect(select.selectedOptions[0].disabled).toBe(true);
    setValue(dom.window, select, "");
    await wait(150);
    expect(d.querySelector(".prompt .hint.warn")).toBeNull();
  }, 30_000);

  it("reads a task's price as its rate is read, and refuses what is not a price", async () => {
    // The price box was a number box, which hands back nothing for "12,5",
    // and nothing saved as no price at all.
    const ledger = seed({ currentRate: 0, perTask: 50 });
    ledger.projects[0].tasks[1].price = 35;
    const { dom, d } = await open(ledger);
    [...taskRow(d, "T-2").querySelectorAll("button")].find((b) => b.textContent === "edit").click();
    await wait(200);
    const form = d.querySelector(".prompt");
    const price = field(form, "Per accepted item");
    expect(price.placeholder).toMatch(/the project's price$/);

    setValue(dom.window, price, "30%");
    await wait(150);
    expect(form.querySelector(".hint.warn").textContent).toMatch(/“30%” isn't a price/);
    expect(inPrompt(d, /^Save$/).disabled).toBe(true);
    setValue(dom.window, price, "-5");
    await wait(150);
    expect(form.querySelector(".hint.warn").textContent).toMatch(/price can't be below zero/);
    expect(stored(dom).projects[0].tasks[1].price).toBe(35);

    setValue(dom.window, price, "12,5");
    await wait(150);
    expect(form.querySelector(".hint.warn")).toBeNull();
    inPrompt(d, /^Save$/).click();
    await wait(300);
    expect(stored(dom).projects[0].tasks[1].price).toBe(12.5);
  }, 30_000);

  it("reads a new task's pay box as it is labelled, and says what it cannot read", async () => {
    // On hourly work with a per-item bonus the box says Rate, but what was
    // typed was saved as the task's item price: 45 meant as $45 an hour gave
    // the task a $45 item price and no rate.
    const { dom, d } = await open(seed({ perTask: 70 }));
    btn(d, /Start the meter/i).click();
    await wait(200);
    btn(d, /New task/i).click();
    await wait(150);
    const form = d.querySelector(".prompt");
    setValue(dom.window, field(form, "Name it"), "T-9");
    const pay = field(form, "^Rate$");
    setValue(dom.window, pay, "abc");
    await wait(150);
    expect(form.querySelector(".hint.warn").textContent).toMatch(/“abc” isn't a rate/);
    expect(inPrompt(d, /Start the meter/i).disabled).toBe(true);

    setValue(dom.window, pay, "45");
    await wait(150);
    expect(form.querySelector(".hint.warn")).toBeNull();
    inPrompt(d, /Start the meter/i).click();
    await wait(300);
    const task = stored(dom).projects[0].tasks.find((t) => t.label === "T-9");
    expect(task.rate).toBe(45);
    expect(task).not.toHaveProperty("price");
  }, 30_000);

  it("reads a decimal comma in a new task's price on work paid per item", async () => {
    const { dom, d } = await open(seed({ currentRate: 0, perTask: 50 }));
    btn(d, /Start the meter/i).click();
    await wait(200);
    btn(d, /New task/i).click();
    await wait(150);
    const form = d.querySelector(".prompt");
    setValue(dom.window, field(form, "Name it"), "T-9");
    setValue(dom.window, field(form, "Per accepted item"), "12,5");
    await wait(150);
    expect(form.querySelector(".hint.warn")).toBeNull();
    inPrompt(d, /Start the meter/i).click();
    await wait(300);
    expect(stored(dom).projects[0].tasks.find((t) => t.label === "T-9").price).toBe(12.5);
  }, 30_000);
});

describe("fixes: paydays and settling", () => {
  const HOUR = 3_600_000;
  const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));

  /** Boots a ledger and opens its first project. */
  const openFirst = async (seed, settings = null) => {
    const dom = await boot(seed, settings);
    await wait(250);
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await wait(200);
    return { dom, d };
  };

  /** Ticks one task's row in By task. */
  const tick = async (d, label) => {
    const row = [...d.querySelectorAll(".trow")]
      .find((r) => r.querySelector(".trow-label")?.textContent.startsWith(label));
    row.querySelector("input.row-check").click();
    await wait(150);
  };

  const press = async (d, re) => {
    btn(d, re).click();
    await wait(300);
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
    await wait(200);
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
    await wait(150);
    expect(d.querySelector(".wrap").textContent).toMatch(/Every button records the time in the box/);
    btn(d, /^use the defaults$/).click();
    await wait(150);
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
    await wait(700);
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
        { id: "a", name: "Gateway", company: "Clockwork", currentRate: 40, currency: "USD",
          createdAt: at - 80 * HOUR, sessionGoal: null, overallGoal: null,
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
    await wait(150);
    await toProjects(d, "Overview");
    expect(payLabels(d)).toEqual([`Not before ${payday(2)}`]);

    dom.window.__skew += 60_000;
    await wait(1_500);
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
    await wait(150);
    const lines = [...d.querySelectorAll(".payline")].map((e) => e.textContent);
    expect(lines).toContain("Two-task bonus · 2 tasks · Gateway$60.00");
  }, 30_000);

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
    await wait(200);
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
    await wait(300);
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
    await wait(150);
    await save(d);

    expect(stored(dom).projects[0].company).toBe("Outlier");
    expect(ruleOf(dom, "Outlier")).toMatchObject({ kind: "weekly", payday: 3, closesAt: 19 * 60 });
    // Northwind keeps its own, for whatever other projects it has.
    expect(ruleOf(dom, "Northwind")).toEqual(MONDAY_WEDNESDAY);
    btn(d, /All projects/).click();
    await wait(200);
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
    await wait(150);
    // Untouched, the payday follows the company named: joining Outlier means
    // Outlier's Friday, and there is nothing to warn about.
    expect(control(d, "Is paid on").value).toBe("5");
    expect(warned()).toBe(false);

    setValue(dom.window, control(d, "Is paid on"), "4");
    await wait(150);
    expect(warned()).toBe(true);
    btn(d, /Use Outlier's instead/).click();
    await wait(150);
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
    await wait(150);
    await save(d);
    expect(stored(dom).projects[0].company).toBe("outlier");
    expect(ruleOf(dom, "Outlier").payday).toBe(5);
  }, 30_000);
});
