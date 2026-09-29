import { describe, it, expect } from "vitest";
import {
  answerTasks, billedMsForTask, reopenTasks, submitTasks,
} from "../src/domain/settle.js";
import {
  TASK, isOpenTask, setTaskState, takesTime, takesTimeIn, taskState,
} from "../src/domain/taskState.js";
import {
  EARNING, PAY, REWARD, acceptanceCents, addEarning, bonusPerHour, hasReward,
  isCancelled, isPending, payStateOf, rewardModel,
} from "../src/domain/earnings.js";
import { KIND, addManualSession, startSession, stopSession } from "../src/domain/sessions.js";
import { addTask, findTask } from "../src/domain/tasks.js";

const T = 1_700_000_000_000;
const HOUR = 3_600_000;

/** $80/hr, and $10 more per hour once the work is accepted — the shape the
 *  flat per-item model got wrong. */
const hourly = {
  id: "p1", name: "Orion", currentRate: 80, currency: "USD", tasks: [],
  paysOnAcceptance: true, bonusPerHour: 10,
};
/** The older shape: a flat amount per accepted item, whatever it took. */
const flat = { ...hourly, bonusPerHour: undefined, perTask: 10 };
/** Paid by the hour with nothing extra on acceptance. */
const plain = { ...hourly, bonusPerHour: undefined };

const proj = (s) => s.projects[0];
const seed = (project, taskId = "t1") =>
  addTask({ projects: [project], sessions: [], earnings: [] },
          project.id, { id: taskId, label: taskId }, T);

/** A finished sitting of `hours` under a task. */
const worked = (state, hours, { taskId = "t1", id = "s1", kind = KIND.BILLED, at = T } = {}) =>
  stopSession(
    startSession(state, proj(state), { now: at, id, kind, taskId }),
    id, at + hours * HOUR,
  );

/** Ids for submit, which writes one earning per task. */
const counter = () => {
  let n = 0;
  return () => "e" + (++n);
};

const rewards = (s) => (s.earnings ?? []).filter((e) => !e.deletedAt);

describe("the hourly acceptance bonus", () => {
  it("reads a positive number and nothing else", () => {
    expect(bonusPerHour({ bonusPerHour: 10 })).toBe(10);
    expect(bonusPerHour({ bonusPerHour: 0 })).toBeNull();
    expect(bonusPerHour({ bonusPerHour: -5 })).toBeNull();
    expect(bonusPerHour({ bonusPerHour: "nope" })).toBeNull();
    expect(bonusPerHour({})).toBeNull();
  });

  it("is absent on every project written before it existed", () => {
    expect(hasReward({ id: "p", currentRate: 80 })).toBe(false);
    expect(rewardModel({ id: "p", currentRate: 80 })).toBeNull();
  });

  it("names which of the two models a project pays", () => {
    expect(rewardModel(hourly)).toBe(REWARD.PER_HOUR);
    expect(rewardModel(flat)).toBe(REWARD.PER_TASK);
  });

  it("prefers the hourly one if a project somehow holds both", () => {
    // The form never writes both. If a merge or a hand-edited file produces
    // one, it must price by ONE model rather than pick per caller.
    const both = { ...hourly, perTask: 10 };
    expect(rewardModel(both)).toBe(REWARD.PER_HOUR);
  });
});

describe("what acceptance is worth", () => {
  it("multiplies the bonus by the hours actually worked", () => {
    expect(acceptanceCents(hourly, null, 3 * HOUR)).toBe(3_000);
    expect(acceptanceCents(hourly, null, HOUR / 2)).toBe(500);
  });

  it("is the whole point: two tasks of different length are worth different money", () => {
    // The flat model paid the same for both, which is wrong in both
    // directions at once.
    expect(acceptanceCents(hourly, null, 6 * HOUR)).toBe(6_000);
    expect(acceptanceCents(hourly, null, HOUR / 3)).toBe(333);
    expect(acceptanceCents(flat, null, 6 * HOUR))
      .toBe(acceptanceCents(flat, null, HOUR / 3));
  });

  it("ignores the hours entirely under the flat model", () => {
    expect(acceptanceCents(flat, null, 3 * HOUR)).toBe(1_000);
    expect(acceptanceCents(flat, null, 0)).toBe(1_000);
  });

  it("records nothing rather than a line worth zero", () => {
    expect(acceptanceCents(hourly, null, 0)).toBeNull();
    expect(acceptanceCents(plain, null, 3 * HOUR)).toBeNull();
  });

  it("lets a task's own price override the flat amount", () => {
    expect(acceptanceCents(flat, { price: 25 }, 0)).toBe(2_500);
  });
});

describe("counting the hours a task collected", () => {
  it("adds up every sitting filed under it", () => {
    let s = seed(hourly);
    s = worked(s, 2);
    s = worked(s, 1, { id: "s2", at: T + 5 * HOUR });
    expect(billedMsForTask(s, "p1", "t1", T + 9 * HOUR)).toBe(3 * HOUR);
  });

  it("leaves idle time out, because nobody tops up idle minutes", () => {
    let s = seed(hourly);
    s = worked(s, 2);
    s = worked(s, 4, { id: "s2", kind: KIND.IDLE, at: T + 5 * HOUR });
    expect(billedMsForTask(s, "p1", "t1", T + 20 * HOUR)).toBe(2 * HOUR);
  });
});

describe("submitting a batch", () => {
  it("writes one pending reward per task, each priced by its own hours", () => {
    let s = seed(hourly);
    s = addTask(s, "p1", { id: "t2", label: "t2" }, T);
    s = worked(s, 3);
    s = worked(s, 0.5, { taskId: "t2", id: "s2", at: T + 4 * HOUR });
    s = submitTasks(s, proj(s), ["t1", "t2"], T + 9 * HOUR, counter());

    const lines = rewards(s);
    expect(lines).toHaveLength(2);
    expect(lines.map((e) => e.cents)).toEqual([3_000, 500]);
    expect(lines.every(isPending)).toBe(true);
    expect(lines.map((e) => e.taskIds)).toEqual([["t1"], ["t2"]]);
  });

  it("settles the hourly money, which submitting is what earns", () => {
    let s = seed(hourly);
    s = worked(s, 3);
    // Pending from the moment it started, because the project pays on
    // acceptance.
    expect(payStateOf(s.sessions[0])).toBe(PAY.PENDING);
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, counter());
    expect(payStateOf(s.sessions[0])).toBe(PAY.PAID);
  });

  it("marks the task submitted", () => {
    let s = seed(hourly);
    s = worked(s, 1);
    s = submitTasks(s, proj(s), ["t1"], T + 2 * HOUR, counter());
    expect(taskState(findTask(proj(s), "t1"))).toBe(TASK.SUBMITTED);
  });

  it("still submits and settles a project with no reward at all", () => {
    let s = seed(plain);
    s = worked(s, 3);
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, counter());
    expect(rewards(s)).toHaveLength(0);
    expect(taskState(findTask(proj(s), "t1"))).toBe(TASK.SUBMITTED);
    expect(payStateOf(s.sessions[0])).toBe(PAY.PAID);
  });

  it("will not write a second reward for a task already handed in", () => {
    let s = seed(hourly);
    s = worked(s, 3);
    const next = counter();
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, next);
    s = submitTasks(s, proj(s), ["t1"], T + 5 * HOUR, next);
    expect(rewards(s)).toHaveLength(1);
  });

  it("says on the line what it was for, so the ledger reads on its own", () => {
    let s = seed(hourly);
    s = worked(s, 3);
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, counter());
    expect(rewards(s)[0].note).toBe("Accepted · t1 · 3h 00m at 10/hr");
    expect(rewards(s)[0].kind).toBe(EARNING.BONUS);
  });

  it("counts a flat reward as one item, and an hourly one as no items", () => {
    // `units` means accepted items. Writing 1 against an hourly bonus would
    // print a per-item price nobody quoted.
    let h = worked(seed(hourly), 3);
    h = submitTasks(h, proj(h), ["t1"], T + 4 * HOUR, counter());
    expect(rewards(h)[0]).not.toHaveProperty("units");

    let f = worked(seed(flat), 3);
    f = submitTasks(f, proj(f), ["t1"], T + 4 * HOUR, counter());
    expect(rewards(f)[0].units).toBe(1);
    expect(rewards(f)[0].kind).toBe(EARNING.PIECE);
  });
});

describe("a submitted task takes no more hours", () => {
  const handedIn = (project = hourly) => {
    let s = seed(project);
    s = worked(s, 1);
    return submitTasks(s, proj(s), ["t1"], T + 2 * HOUR, counter());
  };

  it("refuses the meter", () => {
    const s = handedIn();
    expect(startSession(s, proj(s), { now: T + 3 * HOUR, id: "s9", taskId: "t1" })).toBe(s);
  });

  it("refuses typed-in time too, which is the same new time by another door", () => {
    const s = handedIn();
    expect(addManualSession(s, proj(s), {
      startedAt: T + 3 * HOUR, endedAt: T + 4 * HOUR, taskId: "t1",
    }, T + 4 * HOUR, "s9")).toBe(s);
  });

  it("does not refuse the meter on a task that is still open", () => {
    const s = seed(hourly);
    expect(takesTimeIn(proj(s), "t1")).toBe(true);
    expect(startSession(s, proj(s), { now: T, id: "s1", taskId: "t1" }).sessions).toHaveLength(1);
  });

  it("never blocks work filed under no task at all", () => {
    // Nothing has been submitted, so there is nothing to have frozen.
    expect(takesTimeIn(proj(seed(hourly)), null)).toBe(true);
  });

  it("lets time back in once the task is reopened", () => {
    let s = handedIn();
    s = reopenTasks(s, proj(s), ["t1"], T + 3 * HOUR);
    expect(isOpenTask(findTask(proj(s), "t1"))).toBe(true);
    expect(startSession(s, proj(s), { now: T + 4 * HOUR, id: "s9", taskId: "t1" }).sessions)
      .toHaveLength(2);
  });

  it("leaves the money exactly where it was when reopened", () => {
    let s = seed(hourly);
    s = worked(s, 3);
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, counter());
    const before = rewards(s).map((e) => [e.cents, payStateOf(e)]);
    s = reopenTasks(s, proj(s), ["t1"], T + 5 * HOUR);
    expect(rewards(s).map((e) => [e.cents, payStateOf(e)])).toEqual(before);
  });
});

describe("hearing back", () => {
  const submitted = () => {
    let s = seed(hourly);
    s = worked(s, 3);
    return submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, counter());
  };

  it("pays the reward when the answer is yes", () => {
    const s = answerTasks(submitted(), hourly, ["t1"], TASK.ACCEPTED, T + 5 * HOUR);
    expect(payStateOf(rewards(s)[0])).toBe(PAY.PAID);
    expect(taskState(findTask(proj(s), "t1"))).toBe(TASK.ACCEPTED);
  });

  it("cancels the reward when the answer is no, and keeps the hours paid", () => {
    // Submitting is what earned the hourly money. A rejection is about the
    // top-up, not a clawback of work that was done and delivered.
    const s = answerTasks(submitted(), hourly, ["t1"], TASK.CANCELLED, T + 5 * HOUR);
    expect(isCancelled(rewards(s)[0])).toBe(true);
    expect(payStateOf(s.sessions[0])).toBe(PAY.PAID);
    expect(taskState(findTask(proj(s), "t1"))).toBe(TASK.CANCELLED);
  });

  it("does not resurrect a reward already cancelled", () => {
    let s = answerTasks(submitted(), hourly, ["t1"], TASK.CANCELLED, T + 5 * HOUR);
    s = answerTasks(s, hourly, ["t1"], TASK.ACCEPTED, T + 6 * HOUR);
    expect(isCancelled(rewards(s)[0])).toBe(true);
  });

  it("leaves a reward shared across many tasks alone", () => {
    // "Finish fifty and we pay you X" is fifty tasks' worth of money.
    // Accepting one of them must not settle the other forty-nine.
    let s = seed(hourly);
    s = addTask(s, "p1", { id: "t2", label: "t2" }, T);
    s = addEarning(s, proj(s), {
      cents: 50_000, kind: EARNING.BONUS, taskIds: ["t1", "t2"], status: PAY.PENDING,
    }, T, "shared");
    s = answerTasks(s, proj(s), ["t1"], TASK.ACCEPTED, T + HOUR);
    expect(isPending(rewards(s).find((e) => e.id === "shared"))).toBe(true);
  });

  it("still records the answer on a task that was never priced", () => {
    let s = seed(plain);
    s = worked(s, 2);
    s = submitTasks(s, proj(s), ["t1"], T + 3 * HOUR, counter());
    s = answerTasks(s, proj(s), ["t1"], TASK.ACCEPTED, T + 4 * HOUR);
    expect(taskState(findTask(proj(s), "t1"))).toBe(TASK.ACCEPTED);
  });
});

describe("the state itself", () => {
  it("reads absent as open, so nothing already stored changed meaning", () => {
    expect(taskState({ id: "t", label: "x" })).toBeNull();
    expect(isOpenTask({ id: "t", label: "x" })).toBe(true);
    expect(takesTime({ id: "t", label: "x" })).toBe(true);
  });

  it("stamps when the state was set, and clears it on reopen", () => {
    let s = setTaskState(seed(hourly), "p1", "t1", TASK.SUBMITTED, T + 9);
    expect(findTask(proj(s), "t1").stateAt).toBe(T + 9);
    s = setTaskState(s, "p1", "t1", null, T + 10);
    expect(findTask(proj(s), "t1")).not.toHaveProperty("stateAt");
    expect(findTask(proj(s), "t1")).not.toHaveProperty("state");
  });

  it("does not reach into another project's tasks", () => {
    const two = {
      projects: [{ ...hourly, tasks: [{ id: "t1", label: "a" }] },
                 { ...hourly, id: "p2", tasks: [{ id: "t1", label: "a" }] }],
      sessions: [], earnings: [],
    };
    const s = setTaskState(two, "p1", "t1", TASK.SUBMITTED, T);
    expect(taskState(s.projects[1].tasks[0])).toBeNull();
  });
});
