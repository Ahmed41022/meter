/**
 * Integration tests against the BUILT artifact, not the source. These catch
 * things unit tests structurally cannot: bundling mistakes, event wiring,
 * and CSS that silently fails (an inline element ignoring margin-top, say).
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DIST, wait, until, settle, boot, runningSeed, btn, toProjects, setValue, startMeter, guardBuiltApp } from "./app.integration.helpers.js";

guardBuiltApp();

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
    await settle();
    const [name, rate] = d.querySelectorAll("input");
    setValue(window, name, "Acme");
    setValue(window, rate, "450");
    btn(d, /Add project/i).click();
    await settle();
    expect(d.querySelector(".card-name").textContent).toContain("Acme");

    await toProjects(d);
    d.querySelector(".card").click();
    await settle();
    expect(d.querySelector(".state").textContent.trim()).toBe("Stopped");

    await startMeter(dom);
    // The clock really has to tick: a stuck clock never reaches 1-2 seconds.
    await until(() => /00:00:0[12]/.test(d.querySelector(".clock-main")?.textContent ?? ""),
      { what: "the clock to read 00:00:01 or 00:00:02" });
    expect(d.querySelector(".state").textContent.trim()).toBe("Running");
    expect(d.querySelector(".clock-main").textContent).toMatch(/00:00:0[12]/);

    btn(d, /^Pause$/i).click();
    await settle();
    expect(d.querySelector(".state").textContent.trim()).toBe("Paused");
    expect(btn(d, /Resume/i)).toBeTruthy();

    btn(d, /Resume/i).click();
    await settle();
    expect(d.querySelector(".state").textContent.trim()).toBe("Running");

    btn(d, /Stop and save/i).click();
    await settle();
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
    await settle();
    const [name, rate] = d.querySelectorAll("input");
    setValue(window, name, "Acme");
    setValue(window, rate, "500");
    btn(d, /Add project/i).click();
    await settle();
    await toProjects(d);
    d.querySelector(".card").click();
    await settle();
    await startMeter(dom);
    await until(() => d.querySelector(".state")?.textContent.trim() === "Running", { what: "the face to read Running" }); // nothing here depends on elapsed time, only on a running session

    btn(d, /^Open$/i).click();
    await settle();
    const rateInput = d.querySelectorAll("input[type=number]")[0];
    setValue(window, rateInput, "900");
    await settle();
    // Settings are staged and saved on request; leaving the box is not the
    // act of changing a rate any more.
    btn(d, /Save changes/).click();
    await settle();

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
    await settle();
    const [name, rate] = d.querySelectorAll("input");
    setValue(window, name, "Acme");
    setValue(window, rate, "450");
    btn(d, /Add project/i).click();
    await settle();
    await toProjects(d);
    d.querySelector(".card").click();
    await settle();
    await startMeter(dom);
    // Keeps the original intent (a session that has really run): until the clock moves off zero.
    await until(() => d.querySelector(".clock-main")?.textContent !== "00:00:00",
      { what: "the clock to move off 00:00:00" });
    btn(d, /Stop and save/i).click();
    await settle();
    expect(d.querySelectorAll(".row")).toHaveLength(1);

    d.querySelector(".x").click();
    await settle();
    expect(d.querySelectorAll(".row")).toHaveLength(0);
    expect(d.querySelector(".toast")).not.toBeNull();

    btn(d, /Undo/i).click();
    await settle();
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
    await settle();
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

  it("repaints the face so idle can never be mistaken for earnings", async () => {
    const dom = await boot();
    const d = dom.window.document;
    await makeProject(dom);

    await startMeter(dom, { idle: true });
    await until(() => d.querySelector(".state")?.textContent.trim() === "Idling", { what: "the face to read Idling" });
    expect(d.querySelector(".face").className).toContain("idle");
    expect(d.querySelector(".state").textContent.trim()).toBe("Idling");
    expect(d.querySelector(".money-label").textContent).toMatch(/not billed/i);
  }, 20_000);

  it("keeps idle money out of the grand total", async () => {
    const dom = await boot();
    const { window } = dom, d = window.document;
    await makeProject(dom);

    await startMeter(dom, { idle: true });
    // "One idle second recorded": wait until the idle clock has really moved.
    await until(() => d.querySelector(".clock-main")?.textContent !== "00:00:00",
      { what: "the idle clock to move off 00:00:00" });
    btn(d, /Stop idling/i).click();
    await settle();

    const saved = JSON.parse(window.localStorage.getItem("meter:v1"));
    expect(saved.sessions[0].kind).toBe("idle");

    btn(d, /All projects/i).click();
    await settle();
    // One idle second recorded, zero billed: the headline total must be empty.
    await toProjects(d);
    expect(d.querySelector(".grand-amt").textContent.trim()).toBe("—");
  }, 20_000);

  it("shows the idle row tagged in the ledger", async () => {
    const dom = await boot();
    const d = dom.window.document;
    await makeProject(dom);
    await startMeter(dom, { idle: true });
    await until(() => d.querySelector(".state")?.textContent.trim() === "Idling", { what: "the face to read Idling" });
    btn(d, /Stop idling/i).click();
    await settle();
    expect(d.querySelector(".row.is-idle")).not.toBeNull();
    expect(d.querySelector(".tag").textContent.trim()).toBe("Idle");
  }, 20_000);

  it("stops the billed meter when idle starts, so wall-clock time is never double counted", async () => {
    const dom = await boot();
    const { window } = dom, d = window.document;
    await makeProject(dom);

    await startMeter(dom);
    await until(() => d.querySelector(".state")?.textContent.trim() === "Running", { what: "the face to read Running" });
    btn(d, /Switch to idle/i).click();
    await settle();

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
    await settle();

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
    await settle();
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
    // A real window, longer than the app's 1 s render tick (TICK_MS): a shorter
    // or conditional wait would let this pass without a tick ever happening.
    await wait(1200);
    expect(window.__reads - before).toBe(0);
  }, 20_000);

  it("does not write to storage while merely rendering", async () => {
    const dom = await boot(runningSeed(5_000));
    const { window } = dom;
    const before = window.__writes;
    // Real window, longer than the 1 s render tick (see above).
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
    await settle();
    const first = d.querySelector(".clock-main").textContent;
    await until(() => d.querySelector(".clock-main").textContent !== first,
      { what: "the live clock to change from " + first });
    expect(d.querySelector(".clock-main").textContent).not.toBe(first);
  }, 20_000);
});
