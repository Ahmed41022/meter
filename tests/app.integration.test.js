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

const boot = async (seed) => {
  let html = readFileSync(DIST, "utf8");
  if (seed) {
    html = html.replace(
      '<div id="root"></div>',
      `<div id="root"></div><script>localStorage.setItem('meter:v1', ${JSON.stringify(JSON.stringify(seed))});</script>`
    );
  }
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/" });
  await wait(700);
  return dom;
};

const btn = (d, re) => [...d.querySelectorAll("button")].find((b) => re.test(b.textContent));
const setValue = (win, el, value) => {
  const proto = el.tagName === "SELECT" ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
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

    btn(d, /Start the meter/i).click();
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
    btn(d, /Start the meter/i).click();
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
    btn(d, /Start the meter/i).click();
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

    btn(d, /Start idle/i).click();
    await wait(1200);
    expect(d.querySelector(".face").className).toContain("idle");
    expect(d.querySelector(".state").textContent.trim()).toBe("Idling");
    expect(d.querySelector(".money-label").textContent).toMatch(/not billed/i);
  }, 20_000);

  it("keeps idle money out of the grand total", async () => {
    const dom = await boot();
    const { window } = dom, d = window.document;
    await makeProject(dom);

    btn(d, /Start idle/i).click();
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
    btn(d, /Start idle/i).click();
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

    btn(d, /Start the meter/i).click();
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
