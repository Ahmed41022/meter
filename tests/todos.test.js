import { describe, it, expect } from "vitest";
import {
  addTodo, allTodos, clearDone, doneTodos, editTodo, linkedProject, liveTodos,
  openTodos, removeTodo, restoreTodos, toggleTodo,
} from "../src/domain/todos.js";
import { mergeState } from "../src/domain/merge.js";

const T = 1_700_000_000_000;
const base = { projects: [{ id: "p1", name: "Aether" }], sessions: [] };
const one = (fields = {}) => addTodo(base, { text: "Renew the domain", ...fields }, T, "d1");

describe("adding a to-do", () => {
  it("records the words, open and unlinked", () => {
    expect(allTodos(one())[0]).toEqual({
      id: "d1", text: "Renew the domain", projectId: null,
      done: false, doneAt: null, createdAt: T, deletedAt: null,
    });
  });

  it("trims the words and refuses none at all", () => {
    expect(allTodos(addTodo(base, { text: "  Pay the rent  " }, T, "d1"))[0].text).toBe("Pay the rent");
    expect(addTodo(base, { text: "   " }, T, "d1")).toBe(base);
  });

  it("may name a project, and an empty pick names none", () => {
    expect(allTodos(one({ projectId: "p1" }))[0].projectId).toBe("p1");
    expect(allTodos(one({ projectId: "" }))[0].projectId).toBeNull();
  });

  it("reads a store written before to-dos existed as having none", () => {
    // Absent means none, so there is no schema bump and nothing to migrate.
    expect(allTodos({ projects: [], sessions: [] })).toEqual([]);
  });
});

describe("ticking, editing and removing", () => {
  it("records when a to-do was ticked, and forgets it when unticked", () => {
    const done = toggleTodo(one(), "d1", T + 5);
    expect(allTodos(done)[0]).toMatchObject({ done: true, doneAt: T + 5 });
    expect(allTodos(toggleTodo(done, "d1", T + 9))[0]).toMatchObject({ done: false, doneAt: null });
  });

  it("changes the words and the project, but not to nothing", () => {
    let s = editTodo(one(), "d1", { text: " Renew it ", projectId: "p1" });
    expect(allTodos(s)[0]).toMatchObject({ text: "Renew it", projectId: "p1" });
    s = editTodo(s, "d1", { text: "  " });
    expect(allTodos(s)[0].text).toBe("Renew it");
    expect(allTodos(editTodo(s, "d1", { projectId: "" }))[0].projectId).toBeNull();
  });

  it("removes by stamping, so Undo and a sync both see it", () => {
    const gone = removeTodo(one(), "d1", T + 1);
    expect(liveTodos(gone)).toEqual([]);
    expect(allTodos(gone)[0].deletedAt).toBe(T + 1);
    expect(liveTodos(restoreTodos(gone, ["d1"]))).toHaveLength(1);
  });
});

describe("clearing what is done", () => {
  const three = () => {
    let s = one();
    s = addTodo(s, { text: "Call the bank" }, T + 1, "d2");
    s = addTodo(s, { text: "Email Mars Corp" }, T + 2, "d3");
    s = toggleTodo(s, "d2", T + 3);
    return toggleTodo(s, "d3", T + 4);
  };

  it("removes every done to-do and leaves the open ones", () => {
    const { state, ids } = clearDone(three(), T + 9);
    expect(ids).toEqual(["d2", "d3"]);
    expect(liveTodos(state).map((t) => t.id)).toEqual(["d1"]);
  });

  it("names only what it cleared, so Undo does not bring back one removed by hand", () => {
    const earlier = removeTodo(three(), "d3", T + 5);
    const { state, ids } = clearDone(earlier, T + 9);
    expect(ids).toEqual(["d2"]);
    expect(liveTodos(restoreTodos(state, ids)).map((t) => t.id)).toEqual(["d1", "d2"]);
  });

  it("does nothing when nothing is done", () => {
    expect(clearDone(one(), T).ids).toEqual([]);
  });
});

describe("the order the list shows", () => {
  const todos = [
    { id: "a", createdAt: 3, done: false },
    { id: "b", createdAt: 1, done: false },
    { id: "c", createdAt: 2, done: true, doneAt: 10 },
    { id: "d", createdAt: 4, done: true, doneAt: 20 },
  ];

  it("lists what is left in the order it was written down", () => {
    expect(openTodos(todos).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("opens the done fold on the latest finished", () => {
    expect(doneTodos(todos).map((t) => t.id)).toEqual(["d", "c"]);
  });
});

describe("a to-do's project", () => {
  it("is the project it names while that project exists", () => {
    expect(linkedProject({ projectId: "p1" }, base.projects)?.name).toBe("Aether");
  });

  it("reads as none once the project is gone, and the to-do stays", () => {
    // The list handed in is the live projects, so a removed one is absent.
    expect(linkedProject({ projectId: "p1" }, [])).toBeNull();
    expect(linkedProject({ projectId: null }, base.projects)).toBeNull();
  });
});

describe("two devices", () => {
  it("merge their lists record by record, the later edit winning", () => {
    const mine = { projects: [], sessions: [], todos: [
      { id: "d1", text: "old", updatedAt: 1 }, { id: "d2", text: "mine only", updatedAt: 1 }] };
    const theirs = { projects: [], sessions: [], todos: [
      { id: "d1", text: "new", updatedAt: 9 }, { id: "d3", text: "theirs only", updatedAt: 1 }] };
    const out = mergeState(mine, theirs);
    expect(out.todos.map((t) => [t.id, t.text])).toEqual([["d1", "new"], ["d2", "mine only"], ["d3", "theirs only"]]);
  });
});
