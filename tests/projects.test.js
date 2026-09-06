import { describe, it, expect } from "vitest";
import { addProject, patchProject, removeProject, validateProject } from "../src/domain/projects.js";
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
