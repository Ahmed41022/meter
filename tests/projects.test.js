import { describe, it, expect } from "vitest";
import {
  acceptsTime, activeProjects, addProject, companiesIn, companyOf, finishedProjects,
  isActive, isDone, isPaused, matchesQuery, patchProject, removeProject, searchProjects,
  setStatus, statusOf, validateProject,
} from "../src/domain/projects.js";
import { startSession } from "../src/domain/sessions.js";

const T = 1_700_000_000_000;
const empty = { projects: [], sessions: [] };

describe("creating", () => {
  it("trims whitespace from the name", () => {
    const s = addProject(empty, { name: "  Acme  ", rate: 450, currency: "EGP" }, T, "p1");
    expect(s.projects[0].name).toBe("Acme");
  });

  it("starts with no goals set", () => {
    const s = addProject(empty, { name: "Acme", rate: 450, currency: "EGP" }, T, "p1");
    expect(s.projects[0].sessionGoal).toBeNull();
    expect(s.projects[0].overallGoal).toBeNull();
  });
});

describe("validation", () => {
  it("rejects a blank name", () => {
    expect(validateProject({ name: "   ", rate: 450 })).toMatch(/name/i);
  });

  it("rejects a zero, negative, or non-numeric rate", () => {
    expect(validateProject({ name: "A", rate: 0 })).toMatch(/rate/i);
    expect(validateProject({ name: "A", rate: -5 })).toMatch(/rate/i);
    expect(validateProject({ name: "A", rate: "abc" })).toMatch(/rate/i);
  });

  it("accepts a fractional rate", () => {
    expect(validateProject({ name: "A", rate: "62.50" })).toBeNull();
  });
});

describe("removal", () => {
  it("takes the project's sessions with it and leaves others alone", () => {
    let s = addProject(empty, { name: "A", rate: 450, currency: "EGP" }, T, "p1");
    s = addProject(s, { name: "B", rate: 900, currency: "EGP" }, T, "p2");
    s = startSession(s, s.projects[0], { now: T, id: "s1" });
    s = startSession(s, s.projects[1], { now: T, id: "s2" });
    const after = removeProject(s, "p1");
    expect(after.projects.map((p) => p.id)).toEqual(["p2"]);
    expect(after.sessions.map((x) => x.id)).toEqual(["s2"]);
  });

  it("can be undone by restoring the prior state", () => {
    let s = addProject(empty, { name: "A", rate: 450, currency: "EGP" }, T, "p1");
    s = startSession(s, s.projects[0], { now: T, id: "s1" });
    const snapshot = s;
    removeProject(s, "p1");
    expect(snapshot.projects).toHaveLength(1); // reducers never mutate
    expect(snapshot.sessions).toHaveLength(1);
  });
});

describe("editing", () => {
  it("changes only the named project", () => {
    let s = addProject(empty, { name: "A", rate: 450, currency: "EGP" }, T, "p1");
    s = addProject(s, { name: "B", rate: 900, currency: "EGP" }, T, "p2");
    s = patchProject(s, "p1", { currentRate: 600 });
    expect(s.projects[0].currentRate).toBe(600);
    expect(s.projects[1].currentRate).toBe(900);
  });
});

describe("active, paused and done", () => {
  const state = { projects: [{ id: "p1", name: "Acme", createdAt: T }], sessions: [] };
  const only = (s) => s.projects[0];

  it("reads a project written before statuses existed as active", () => {
    // Absent means active, so nothing already stored changed meaning.
    expect(statusOf({ id: "p1" })).toBe("active");
    expect(isActive({ id: "p1" })).toBe(true);
    expect(acceptsTime({ id: "p1" })).toBe(true);
  });

  it("pauses and finishes, stamping when it happened", () => {
    expect(only(setStatus(state, "p1", "paused", T))).toMatchObject({ status: "paused", statusAt: T });
    expect(only(setStatus(state, "p1", "done", T))).toMatchObject({ status: "done", statusAt: T });
  });

  it("refuses new time in either stopped state", () => {
    // A goal you are not working towards is noise, and a project you stopped
    // should not quietly resume because the start button still worked.
    expect(acceptsTime(only(setStatus(state, "p1", "paused", T)))).toBe(false);
    expect(acceptsTime(only(setStatus(state, "p1", "done", T)))).toBe(false);
  });

  it("cannot be two things at once", () => {
    const paused = setStatus(state, "p1", "paused", T);
    const done = setStatus(paused, "p1", "done", T + 1000);
    expect(isPaused(only(done))).toBe(false);
    expect(isDone(only(done))).toBe(true);
    expect(statusOf(only(done))).toBe("done");
  });

  it("clears the stamp on the way back to active", () => {
    // A stale date on a project that is running again would report a range
    // that never ended.
    const back = setStatus(setStatus(state, "p1", "done", T), "p1", "active", T + 5000);
    expect(only(back)).toMatchObject({ status: null, statusAt: null });
    expect(isActive(only(back))).toBe(true);
    expect(acceptsTime(only(back))).toBe(true);
  });

  it("separates the ones still running from the ones finished", () => {
    const many = [
      { id: "a" },
      { id: "b", status: "paused" },
      { id: "c", status: "done" },
    ];
    expect(activeProjects(many).map((p) => p.id)).toEqual(["a"]);
    expect(finishedProjects(many).map((p) => p.id)).toEqual(["c"]);
  });
});

describe("who the work is for", () => {
  it("reads a missing, empty or blank company as none", () => {
    expect(companyOf({ id: "p1" })).toBeNull();
    expect(companyOf({ id: "p1", company: "" })).toBeNull();
    expect(companyOf({ id: "p1", company: "   " })).toBeNull();
  });

  it("trims what was typed", () => {
    expect(companyOf({ company: "  Outlier " })).toBe("Outlier");
  });

  it("lists the companies named so far, alphabetically", () => {
    expect(companiesIn([
      { company: "Outlier" }, { company: "Aether" }, { id: "none" },
    ])).toEqual(["Aether", "Outlier"]);
  });

  it("does not let a capital letter create a second client", () => {
    // "Outlier" and "outlier" are one company, and the suggestion list is
    // what keeps them from diverging in the first place.
    expect(companiesIn([{ company: "Outlier" }, { company: "outlier" }, { company: "OUTLIER" }]))
      .toEqual(["Outlier"]);
  });
});

describe("finding a project in a long list", () => {
  const p = (name, extra = {}) => ({ id: name, name, ...extra });

  it("matches on any part of the name, ignoring case", () => {
    expect(matchesQuery(p("hyperion_env_building"), "HYPERION")).toBe(true);
    expect(matchesQuery(p("hyperion_env_building"), "building")).toBe(true);
    expect(matchesQuery(p("hyperion_env_building"), "gamebird")).toBe(false);
  });

  it("treats spaces, underscores and hyphens as the same separator", () => {
    // The same work is filed three ways in this ledger, so a reader typing one
    // spelling must find the others.
    expect(matchesQuery(p("extensions-code-v-code"), "code v code")).toBe(true);
    expect(matchesQuery(p("code v code"), "code-v-code")).toBe(true);
    expect(matchesQuery(p("hyperion_env_building"), "env building")).toBe(true);
    expect(matchesQuery(p("map_explorer_gateway"), "explorer gateway")).toBe(true);
  });

  it("matches the company, not just the project", () => {
    expect(matchesQuery(p("gamebird", { company: "Outlier" }), "outlier")).toBe(true);
    expect(matchesQuery(p("gamebird"), "outlier")).toBe(false);
  });

  it("shows everything again when the box is cleared", () => {
    const list = [p("a"), p("b")];
    expect(searchProjects(list, "")).toHaveLength(2);
    expect(searchProjects(list, "   ")).toHaveLength(2);
    expect(searchProjects(list, undefined)).toHaveLength(2);
  });

  it("keeps the order it was given, so the list does not rearrange as you type", () => {
    const list = [p("code_SQL"), p("code v code"), p("gamebird")];
    expect(searchProjects(list, "code").map((x) => x.name)).toEqual(["code_SQL", "code v code"]);
  });
});
