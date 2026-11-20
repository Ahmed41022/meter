/**
 * The sort bar on the Work and Life project lists, and the synced default that
 * decides which order they open in. Drives the built artifact.
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import {
  boot, btn, guardBuiltApp, setValue, settle, toProjects,
} from "./app.integration.helpers.js";

guardBuiltApp();

const HOUR = 3_600_000;
const DAY = 86_400_000;
const T = Date.now();

const project = (id, name, rate, currency, extra = {}) => ({
  id, name, currentRate: rate, currency, createdAt: T - 400 * DAY,
  sessionGoal: null, overallGoal: null, tasks: [], ...extra,
});
const sitting = (id, projectId, rate, currency, hours, daysBack) => {
  const start = T - daysBack * DAY;
  return {
    id, projectId, kind: "billed", taskId: null, rate, currency, createdAt: start,
    closedAt: start + hours * HOUR, deletedAt: null,
    segments: [{ startedAt: start, endedAt: start + hours * HOUR }],
  };
};

// Added order is Charlie, Alpha, Echo, Delta, Bravo: not alphabetical, so Name
// and Added cannot be mistaken for each other.
//   Charlie  EGP  4 h at 50    =  200 EGP, worked 3 days ago
//   Alpha    EGP  1 h at 100   =  100 EGP, worked 5 days ago
//   Echo     EGP  nothing
//   Delta    USD  0.5 h at 500 =  250 USD, worked 2 days ago
//   Bravo    USD  3 h at 20    =   60 USD, worked 1 day ago
// Delta's 25,000 cents is more than Charlie's 20,000, which is the trap: a
// list that compared the bare numbers would put a dollar figure above EGP.
const seed = {
  projects: [
    project("c", "Charlie", 50, "EGP"), project("a", "Alpha", 100, "EGP"),
    project("e", "Echo", 10, "EGP"), project("d", "Delta", 500, "USD"),
    project("b", "Bravo", 20, "USD"),
  ],
  sessions: [
    sitting("s1", "c", 50, "EGP", 4, 3), sitting("s2", "a", 100, "EGP", 1, 5),
    sitting("s3", "d", 500, "USD", 0.5, 2), sitting("s4", "b", 20, "USD", 3, 1),
  ],
};
const lifeSeed = {
  projects: [
    project("l1", "Sleep", 0, "USD", { offClock: true }),
    project("l2", "Chess", 0, "USD", { offClock: true }),
    project("l3", "Art", 0, "USD", { offClock: true }),
  ],
  sessions: [
    { ...sitting("t1", "l1", 0, "USD", 8, 1), kind: "idle" },
    { ...sitting("t2", "l2", 0, "USD", 1, 4), kind: "idle" },
  ],
};

const names = (d) => [...d.querySelectorAll(".stack > .card .card-name")].map((n) => n.textContent);
const bar = (d) => d.querySelector(".sortbar");
const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
const sortBy = async (d, label) => { btn(d, new RegExp(`^${label}`)).click(); await settle(); };
const open = async (state, tab = "Work", settings = null) => {
  const dom = await boot(state, settings);
  await settle();
  await toProjects(dom.window.document, tab);
  return dom;
};
const pref = (key, value) => ({ id: key, value, createdAt: 1, updatedAt: 1, deletedAt: null });

describe("the sort bar on the Work list", () => {
  it("offers Added, Earned, Recently worked, Name and Time", async () => {
    const d = (await open(seed)).window.document;
    expect([...bar(d).querySelectorAll("button")].map((b) => b.textContent.replace(/ [↓↑]$/, "")))
      .toEqual(["Added", "Earned", "Recently worked", "Name", "Time"]);
  }, 25_000);

  it("opens in today's order, with Added marked", async () => {
    const d = (await open(seed)).window.document;
    expect(names(d)).toEqual(["Charlie", "Alpha", "Echo", "Delta", "Bravo"]);
    expect(btn(d, /^Added/).getAttribute("aria-pressed")).toBe("true");
  }, 25_000);

  it("is not shown for a single project", async () => {
    const d = (await open({ projects: [seed.projects[0]], sessions: [] })).window.document;
    expect(bar(d)).toBeNull();
  }, 25_000);

  it("Earned groups by currency, most hours first, biggest first inside, empty last", async () => {
    const d = (await open(seed)).window.document;
    await sortBy(d, "Earned");
    // EGP has 5 h against 3.5 h of USD, so it leads. Delta's bigger bare
    // number does not lift it over an EGP project.
    expect(names(d)).toEqual(["Charlie", "Alpha", "Delta", "Bravo", "Echo"]);
  }, 25_000);

  it("Earned turns round inside each group and keeps the empty one last", async () => {
    const d = (await open(seed)).window.document;
    await sortBy(d, "Earned");
    await sortBy(d, "Earned");
    expect(names(d)).toEqual(["Alpha", "Charlie", "Bravo", "Delta", "Echo"]);
  }, 25_000);

  it("Recently worked puts the latest sitting first and the untouched last", async () => {
    const d = (await open(seed)).window.document;
    await sortBy(d, "Recently worked");
    expect(names(d)).toEqual(["Bravo", "Delta", "Charlie", "Alpha", "Echo"]);
  }, 25_000);

  it("Name reads A to Z, and a second click reads Z to A", async () => {
    const d = (await open(seed)).window.document;
    await sortBy(d, "Name");
    expect(names(d)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
    await sortBy(d, "Name");
    expect(names(d)).toEqual(["Echo", "Delta", "Charlie", "Bravo", "Alpha"]);
  }, 25_000);

  it("Time puts the longest first and the project with none last", async () => {
    const d = (await open(seed)).window.document;
    await sortBy(d, "Time");
    expect(names(d)).toEqual(["Charlie", "Bravo", "Alpha", "Delta", "Echo"]);
  }, 25_000);

  it("Added turns today's order round", async () => {
    const d = (await open(seed)).window.document;
    await sortBy(d, "Added");
    expect(names(d)).toEqual(["Bravo", "Delta", "Echo", "Alpha", "Charlie"]);
  }, 25_000);

  it("orders the Done list the same way as the live one", async () => {
    const done = {
      projects: [
        ...seed.projects.slice(0, 2),
        { ...project("x", "Xray", 10, "USD"), status: "done" },
        { ...project("y", "Yankee", 10, "USD"), status: "done" },
      ],
      sessions: [sitting("s1", "c", 50, "EGP", 4, 3), sitting("s9", "y", 10, "USD", 2, 1)],
    };
    const dom = await open(done);
    const d = dom.window.document;
    btn(d, /Done/).click();
    await settle();
    await sortBy(d, "Earned");
    const all = [...d.querySelectorAll(".card .card-name")].map((n) => n.textContent);
    // Live list first, then the Done one; Yankee has money, Xray has none.
    expect(all).toEqual(["Charlie", "Alpha", "Yankee", "Xray"]);
  }, 25_000);
});

describe("the sort bar on the Life list", () => {
  it("offers no Earned", async () => {
    const d = (await open(lifeSeed, "Life")).window.document;
    expect([...bar(d).querySelectorAll("button")].map((b) => b.textContent.replace(/ [↓↑]$/, "")))
      .toEqual(["Added", "Recently worked", "Name", "Time"]);
  }, 25_000);

  it("orders by time with the untracked project last", async () => {
    const d = (await open(lifeSeed, "Life")).window.document;
    await sortBy(d, "Time");
    expect(names(d)).toEqual(["Sleep", "Chess", "Art"]);
  }, 25_000);

  it("does not carry an Earned pick from Work over to Life", async () => {
    const mixed = { ...seed, projects: [...seed.projects, ...lifeSeed.projects] };
    const dom = await open(mixed);
    const d = dom.window.document;
    await sortBy(d, "Earned");
    await toProjects(d, "Life");
    expect(btn(d, /^Added/).getAttribute("aria-pressed")).toBe("true");
  }, 25_000);
});

describe("the synced default for the lists", () => {
  const section = (d) => d.querySelector("#settings-defaults").parentElement;
  const select = (d, label) => [...section(d).querySelectorAll("label")]
    .find((l) => l.textContent.startsWith(label)).querySelector("select");

  it("is set in Settings, stored in the ledger, and opens the list after a reload", async () => {
    const dom = await open(seed, "Settings");
    const d = dom.window.document;
    setValue(dom.window, select(d, "Work projects open sorted by"), "earned");
    await settle();
    expect(stored(dom).prefs.find((r) => r.id === "cardsSort")).toMatchObject({ value: "earned" });

    const again = await open(stored(dom));
    const e = again.window.document;
    expect(btn(e, /^Earned/).getAttribute("aria-pressed")).toBe("true");
    expect(names(e)).toEqual(["Charlie", "Alpha", "Delta", "Bravo", "Echo"]);
  }, 30_000);

  it("is offered for every list, labelled with the list it changes", async () => {
    const d = (await open(seed, "Settings")).window.document;
    const labels = [...section(d).querySelectorAll("label .eyebrow")].map((l) => l.textContent);
    expect(labels).toEqual([
      "Overview opens on",
      "Work projects open sorted by",
      "Life projects open sorted by",
      "Overview, By project, opens sorted by",
      "Overview, By company, opens sorted by",
      "A project’s earnings open sorted by",
      "A project’s sessions open sorted by",
    ]);
    expect([...select(d, "Life projects").options].map((o) => o.textContent))
      .toEqual(["Added", "Recently worked", "Name", "Time"]);
    expect(select(d, "Work projects").value).toBe("added");
  }, 25_000);

  it("opens Life on its own default, separate from Work's", async () => {
    const d = (await open({
      ...lifeSeed, prefs: [pref("cardsSort", "earned"), pref("lifeSort", "name")],
    }, "Life")).window.document;
    expect(names(d)).toEqual(["Art", "Chess", "Sleep"]);
  }, 25_000);

  it("a pick on the list lasts only until the list is left", async () => {
    const dom = await open({ ...seed, prefs: [pref("cardsSort", "name")] });
    const d = dom.window.document;
    await sortBy(d, "Time");
    expect(names(d)[0]).toBe("Charlie");
    await toProjects(d, "Overview");
    await toProjects(d, "Work");
    expect(btn(d, /^Name/).getAttribute("aria-pressed")).toBe("true");
    expect(names(d)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
  }, 25_000);

  it("falls back to Added for a stored value it does not know", async () => {
    const d = (await open({ ...seed, prefs: [pref("cardsSort", "fastest")] })).window.document;
    expect(names(d)).toEqual(["Charlie", "Alpha", "Echo", "Delta", "Bravo"]);
  }, 25_000);
});
