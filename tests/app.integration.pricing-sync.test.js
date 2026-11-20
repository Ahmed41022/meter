/**
 * Integration tests against the BUILT artifact, not the source. These catch
 * things unit tests structurally cannot: bundling mistakes, event wiring,
 * and CSS that silently fails (an inline element ignoring margin-top, say).
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { settle, boot, btn, bootDash, toProjects, setValue, startMeter, guardBuiltApp } from "./app.integration.helpers.js";

guardBuiltApp();

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
    await settle();
    expect(chosen(dom.window.document)).toBe("Week");
  }, 25_000);

  it("remembers the one you picked", async () => {
    const dom = await bootDash(seed);
    await settle();
    const d = dom.window.document;
    btn(d, /^Month$/).click();
    await settle();
    expect(dom.window.localStorage.getItem("meter:period")).toBe("month");
  }, 25_000);

  it("opens on it next time", async () => {
    const dom = await bootDash(seed, { "meter:period": "year" });
    await settle();
    expect(chosen(dom.window.document)).toBe("Year");
  }, 25_000);

  it("ignores a stored value it does not recognise", async () => {
    // A span from a future version, or a hand-edited one, must not leave the
    // Overview showing nothing at all.
    const dom = await bootDash(seed, { "meter:period": "fortnight" });
    await settle();
    expect(chosen(dom.window.document)).toBe("Week");
  }, 25_000);

  it("keeps it out of the ledger, where it would have to be merged", async () => {
    const dom = await bootDash(seed, { "meter:period": "month" });
    await settle();
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
    await settle();
    // No attribute at all, which is what lets the media query decide.
    expect(root(dom.window.document).hasAttribute("data-theme")).toBe(false);
  }, 25_000);

  it("names each icon for anyone who cannot see it", async () => {
    const dom = await boot(seed);
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Settings");
    for (const label of ["Light", "Dark", "Match system"]) {
      expect(themeBtn(d, label), label).not.toBeNull();
    }
  }, 25_000);

  it("can be pinned to light even where the system is dark", async () => {
    // The case that stranded someone: the OS said dark and the app had no way
    // back, because the palette shipped before the switch did.
    const dom = await boot(seed);
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Settings");
    themeBtn(d, "Light").click();
    await settle();
    expect(root(d).getAttribute("data-theme")).toBe("light");
    expect(dom.window.localStorage.getItem("meter:theme")).toBe("light");
  }, 25_000);

  it("remembers the choice, and is not in the synced ledger", async () => {
    const dom = await boot(seed, { "meter:theme": "dark" });
    await settle();
    expect(root(dom.window.document).getAttribute("data-theme")).toBe("dark");
    const saved = dom.window.localStorage.getItem("meter:v1");
    expect(saved === null || !JSON.stringify(JSON.parse(saved)).includes("theme")).toBe(true);
  }, 25_000);

  it("goes back to following the system", async () => {
    const dom = await boot(seed, { "meter:theme": "dark" });
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Settings");
    themeBtn(d, "Match system").click();
    await settle();
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
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    btn(d, /Start the meter/i).click();
    await settle();
    btn(d, /New task/i).click();
    await settle();
    setValue(dom.window, field(d, "Name it"), label);
    await settle();
    if (pay !== null) {
      setValue(dom.window, field(d, "^Rate$|Per accepted item"), pay);
      await settle();
    }
    btn(d, /Start the meter/i).click();
    await settle();
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
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    return { dom, d };
  };
  const settleRows = (d) => [...d.querySelectorAll(".settle-row")];

  it("shows the price per task on the card, not an hourly zero", async () => {
    const dom = await boot(piece);
    await settle();
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
    await settle();
    expect(d.querySelector(".settle-row")).not.toBeNull();
    expect(d.querySelector(".wrap").textContent).toMatch(/What did this earn/i);
  }, 30_000);

  it("records it as pending, against the session that produced it", async () => {
    // Acceptance is someone else's decision, days away. Filing it as money in
    // hand would make a month look paid when it is only submitted.
    const { dom, d } = await openProject();
    await startMeter(dom, { existing: "task" });
    btn(d, /Stop and save/i).click();
    await settle();
    btn(d, /Record it/i).click();
    await settle();

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
    await settle();
    btn(d, /Add another/i).click();
    await settle();
    expect(settleRows(d)).toHaveLength(2);
    setValue(dom.window, settleRows(d)[1].querySelector("select"), "t2");
    await settle();
    btn(d, /Record it/i).click();
    await settle();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.earnings.map((e) => e.cents).sort((a, b) => a - b)).toEqual([30_000, 150_000]);
    expect(new Set(saved.earnings.map((e) => e.sessionId)).size).toBe(1);
  }, 30_000);
});

describe("creating a project that is paid per task", () => {
  const open = async () => {
    const dom = await boot({ projects: [], sessions: [] });
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Work");
    btn(d, /New project/i).click();
    await settle();
    return { dom, d };
  };
  const pick = async (d, label) => {
    [...d.querySelectorAll('[aria-label="How this project pays"] .seg-btn')]
      .find((b) => b.textContent.trim() === label).click();
    await settle();
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
    await settle();
    expect(d.querySelector(".err").textContent).toMatch(/one task pay/i);
  }, 25_000);

  it("stores the price per item, no hourly rate, and pays on acceptance", async () => {
    const { dom, d } = await open();
    await pick(d, "Per task");
    setValue(dom.window, field(d, "Name"), "Batch work");
    setValue(dom.window, field(d, "Per accepted task"), "250");
    await settle();
    btn(d, /^Add project$/i).click();
    await settle();

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
    await settle();
    btn(d, /^Add project$/i).click();
    await settle();

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
    await settle();
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    btn(d, /Add earnings/i).click();
    await settle();

    const units = [...d.querySelectorAll(".ern-form input")]
      .find((i) => i.step === "1");
    setValue(dom.window, units, "6");
    await settle();
    const amount = d.querySelector('.ern-form input[type="number"]');
    expect(amount.value).toBe("1500"); // 6 x $250

    // overruling it stands: a capped or part-paid batch is exactly that case
    setValue(dom.window, amount, "1200");
    await settle();
    btn(d, /^Add$/).click();
    await settle();
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
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Settings");
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
    await settle();
    btn(d, /^Save$/).click();
    await settle();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(JSON.stringify(saved)).not.toContain("googleusercontent");
    expect(dom.window.localStorage.getItem("meter:google-client"))
      .toBe("abc.apps.googleusercontent.com");
  }, 25_000);

  it("offers to sign in once it is configured, and can forget the ID again", async () => {
    const dom = await boot(seed, { "meter:google-client": "abc.apps.googleusercontent.com" });
    const d = dom.window.document;
    await settle();
    await toProjects(d, "Settings");
    expect(btn(d, /Sign in with Google/i)).toBeTruthy();
    expect(panel(d).textContent).toMatch(/merges rather than replaces/i);

    btn(d, /Change client ID/i).click();
    await settle();
    expect(dom.window.localStorage.getItem("meter:google-client")).toBeNull();
    expect(panel(d).textContent).toMatch(/client ID/i);
  }, 25_000);

  it("keeps one action prominent and the rest quiet", async () => {
    // Three buttons abreast read as three equally likely choices. Signing out
    // and changing the client ID are each done once; syncing is done daily.
    const dom = await boot(seed, { "meter:google-client": "abc.apps.googleusercontent.com" });
    const d = dom.window.document;
    await settle();
    await toProjects(d, "Settings");
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
    await settle();
    await toProjects(d, "Settings");
    btn(d, /Sign in with Google/i).click();
    await settle();
    expect(panel(d).textContent).toMatch(/Syncing/i);
    expect(btn(d, /Sync now|Sign in with Google/i).disabled).toBe(true);
  }, 25_000);

  it("stamps what a change touched, so two devices can be merged later", async () => {
    const { dom, d } = await open();
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
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
    await settle();
    await toProjects(d, "Life");
    expect(panel(d)).toBeUndefined();
  }, 25_000);
});
