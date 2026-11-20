import { describe, it, expect } from "vitest";
import { PERIOD, companyList, setPayPeriod } from "../src/domain/payPeriod.js";

const project = (id, company, extra = {}) => ({
  id, name: id, currentRate: 10, currency: "USD", createdAt: 1, deletedAt: null, company, ...extra,
});
const weekly = { kind: PERIOD.WEEKLY, cutoff: 1, payday: 3, after: 0, closesAt: 0, zone: null };

describe("the list of clients", () => {
  it("is empty with no projects and no schedules", () => {
    expect(companyList({ projects: [] })).toEqual([]);
    expect(companyList(null)).toEqual([]);
  });

  it("lists a client once however its name is spelled, with its project count", () => {
    const state = { projects: [project("a", "Northwind"), project("b", "northwind "), project("c", "Acme")] };
    expect(companyList(state)).toEqual([
      { name: "Acme", rule: null, projects: 1 },
      { name: "Northwind", rule: null, projects: 2 },
    ]);
  });

  it("carries the stored schedule, under the record's own spelling of the name", () => {
    const state = setPayPeriod({ projects: [project("a", "northwind")] }, "Northwind", weekly, 1);
    const [row] = companyList(state);
    expect(row.name).toBe("Northwind");
    expect(row.rule).toMatchObject({ kind: PERIOD.WEEKLY, cutoff: 1, payday: 3 });
    expect(row.projects).toBe(1);
  });

  it("keeps a client with a schedule after no project names it, with a count of zero", () => {
    const state = setPayPeriod({ projects: [] }, "Gone Ltd", weekly, 1);
    expect(companyList(state)).toEqual([
      expect.objectContaining({ name: "Gone Ltd", projects: 0 }),
    ]);
  });

  it("leaves out a record that has neither a schedule nor a project", () => {
    const state = setPayPeriod({ projects: [] }, "Nobody", null, 1);
    expect(companyList(state)).toEqual([]);
  });

  it("ignores deleted projects and deleted company records", () => {
    const state = setPayPeriod({
      projects: [project("a", "Acme", { deletedAt: 5 }), project("b", "Acme")],
    }, "Acme", weekly, 1);
    expect(companyList(state)[0].projects).toBe(1);
    const dead = { ...state, companies: state.companies.map((c) => ({ ...c, deletedAt: 9 })) };
    expect(companyList(dead)).toEqual([{ name: "Acme", rule: null, projects: 1 }]);
    const none = { ...state, projects: state.projects.map((p) => ({ ...p, deletedAt: 5 })) };
    expect(companyList(none)).toEqual([expect.objectContaining({ name: "Acme", projects: 0 })]);
  });

  it("never counts off-clock projects", () => {
    const state = { projects: [project("a", "Acme", { offClock: true }), project("b", "Beta")] };
    expect(companyList(state).map((c) => c.name)).toEqual(["Beta"]);
  });

  it("is sorted by name", () => {
    const state = { projects: [project("a", "zeta"), project("b", "Alpha"), project("c", "mid")] };
    expect(companyList(state).map((c) => c.name)).toEqual(["Alpha", "mid", "zeta"]);
  });
});
