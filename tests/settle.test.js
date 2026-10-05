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
import { earningsCents } from "../src/domain/money.js";
import { elapsedMs } from "../src/domain/time.js";

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
/** Paid as the work happens, with acceptance deciding nothing about the
 *  money. The hours land when they are handed in, because by then every event
 *  that could affect them has happened. */
const asWorked = { ...plain, paysOnAcceptance: false };

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

  it("leaves the hours pending where the money waits on acceptance", () => {
    /*
     * Handing work in is not being paid for it. On a project paid per
     * accepted task the work is delivered and under review, which is exactly
     * what pending means — booking it as earned would credit money that a
     * rejection is about to take straight back out.
     */
    let s = seed(hourly);
    s = worked(s, 3);
    expect(payStateOf(s.sessions[0])).toBe(PAY.PENDING);
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, counter());
    expect(payStateOf(s.sessions[0])).toBe(PAY.PENDING);
  });

  it("settles the hours on submission where the work is paid as worked", () => {
    // Nothing downstream can change what this is worth, so handing it in is
    // the last event that matters and the money lands.
    let s = seed(asWorked);
    s = worked(s, 3);
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, counter());
    expect(payStateOf(s.sessions[0])).toBe(PAY.PAID);
  });

  it("pays the hours out when the answer finally comes back yes", () => {
    // The other half of leaving them pending: acceptance is what settles
    // them, so the money is not stranded in pending for ever.
    let s = seed(hourly);
    s = worked(s, 3);
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, counter());
    s = answerTasks(s, proj(s), ["t1"], TASK.ACCEPTED, T + 5 * HOUR);
    expect(payStateOf(s.sessions[0])).toBe(PAY.PAID);
    expect(payStateOf(rewards(s)[0])).toBe(PAY.PAID);
  });

  it("marks the task submitted", () => {
    let s = seed(hourly);
    s = worked(s, 1);
    s = submitTasks(s, proj(s), ["t1"], T + 2 * HOUR, counter());
    expect(taskState(findTask(proj(s), "t1"))).toBe(TASK.SUBMITTED);
  });

  it("still submits and moves the money for a project with no reward at all", () => {
    let s = seed(plain);
    s = worked(s, 3);
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, counter());
    expect(rewards(s)).toHaveLength(0);
    expect(taskState(findTask(proj(s), "t1"))).toBe(TASK.SUBMITTED);
    // No reward line, but the hours still follow the project's own rule.
    expect(payStateOf(s.sessions[0])).toBe(PAY.PENDING);
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

  it("takes the hours with the reward when the answer is no", () => {
    /*
     * Payment is per accepted task out of one consolidated amount, so work
     * that does not pass review earns nothing at all — there is no half of it
     * left to keep. The hours stay on the record; only the money goes.
     */
    const s = answerTasks(submitted(), hourly, ["t1"], TASK.CANCELLED, T + 5 * HOUR);
    expect(isCancelled(rewards(s)[0])).toBe(true);
    expect(payStateOf(s.sessions[0])).toBe(PAY.CANCELLED);
    expect(taskState(findTask(proj(s), "t1"))).toBe(TASK.CANCELLED);
    // The time itself is untouched: it happened, whatever they decided.
    expect(s.sessions[0].segments).toEqual(submitted().sessions[0].segments);
  });

  it("gives it all back when a rejection is answered the other way", () => {
    /*
     * The answer is the one act in the app that destroys money, so it has to
     * be undoable. Accepting a task that was rejected restores the hours AND
     * the reward: leaving one paid and the other dead would be a state no
     * sequence of honest clicks should be able to reach.
     */
    let s = answerTasks(submitted(), hourly, ["t1"], TASK.CANCELLED, T + 5 * HOUR);
    s = answerTasks(s, hourly, ["t1"], TASK.ACCEPTED, T + 6 * HOUR);
    expect(payStateOf(rewards(s)[0])).toBe(PAY.PAID);
    expect(payStateOf(s.sessions[0])).toBe(PAY.PAID);
    expect(taskState(findTask(proj(s), "t1"))).toBe(TASK.ACCEPTED);
  });

  it("answers the same way twice without compounding anything", () => {
    const once = answerTasks(submitted(), hourly, ["t1"], TASK.CANCELLED, T + 5 * HOUR);
    const twice = answerTasks(once, hourly, ["t1"], TASK.CANCELLED, T + 5 * HOUR);
    expect(twice.sessions).toEqual(once.sessions);
    expect(twice.earnings).toEqual(once.earnings);
  });

  it("puts a rejected task's money back to pending when it is reopened", () => {
    /*
     * An open task is one being worked on, and it has no answer: the
     * rejection that zeroed its money is exactly what reopening undoes. The
     * money is owed again, not earned — pending, hours and reward alike, until
     * the task is accepted.
     */
    let s = answerTasks(submitted(), hourly, ["t1"], TASK.CANCELLED, T + 5 * HOUR);
    s = reopenTasks(s, hourly, ["t1"], T + 6 * HOUR);
    expect(payStateOf(s.sessions[0])).toBe(PAY.PENDING);
    expect(taskState(findTask(proj(s), "t1"))).toBeNull();
    // Kept rather than left cancelled: handing the task in again re-uses this
    // line instead of writing a second, so the task is never owed twice.
    expect(rewards(s)).toHaveLength(1);
    expect(payStateOf(rewards(s)[0])).toBe(PAY.PENDING);
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

describe("a task handed in more than once", () => {
  /** $40 an hour, and $50 more for each accepted item: the ledger in which a
   *  rejected, reopened and resubmitted task read $140 earned instead of $90. */
  const priced = { ...hourly, currentRate: 40, bonusPerHour: undefined, perTask: 50 };

  /** Every cent counted as paid: settled hours plus settled lines. */
  const paidCents = (s, at) =>
    s.sessions.filter((x) => !x.deletedAt && payStateOf(x) === PAY.PAID)
      .reduce((n, x) => n + earningsCents(x.rate, elapsedMs(x, at)), 0)
    + rewards(s).filter((e) => payStateOf(e) === PAY.PAID).reduce((n, e) => n + e.cents, 0);

  /** Live lines naming t1 and nothing else. */
  const ownLines = (s) => rewards(s).filter((e) => e.taskIds?.length === 1 && e.taskIds[0] === "t1");

  it("pays the reward once after a rejection is reopened and handed in again", () => {
    let s = worked(seed(priced), 1);
    const next = counter();
    s = submitTasks(s, proj(s), ["t1"], T + 2 * HOUR, next);
    s = answerTasks(s, proj(s), ["t1"], TASK.CANCELLED, T + 3 * HOUR);
    s = reopenTasks(s, proj(s), ["t1"], T + 4 * HOUR);
    s = submitTasks(s, proj(s), ["t1"], T + 5 * HOUR, next);
    s = answerTasks(s, proj(s), ["t1"], TASK.ACCEPTED, T + 6 * HOUR);

    expect(ownLines(s)).toHaveLength(1);
    expect(paidCents(s, T + 6 * HOUR)).toBe(4_000 + 5_000);
  });

  it("pays it once after an acceptance is reopened and handed in again", () => {
    let s = worked(seed(priced), 1);
    const next = counter();
    s = submitTasks(s, proj(s), ["t1"], T + 2 * HOUR, next);
    s = answerTasks(s, proj(s), ["t1"], TASK.ACCEPTED, T + 3 * HOUR);
    s = reopenTasks(s, proj(s), ["t1"], T + 4 * HOUR);
    s = submitTasks(s, proj(s), ["t1"], T + 5 * HOUR, next);
    s = answerTasks(s, proj(s), ["t1"], TASK.ACCEPTED, T + 6 * HOUR);

    expect(ownLines(s)).toHaveLength(1);
    expect(paidCents(s, T + 6 * HOUR)).toBe(4_000 + 5_000);
  });

  it("re-prices the reward from the hours the task has now", () => {
    // Usually the reason it was reopened: more work went into it.
    let s = worked(seed(hourly), 3);
    const next = counter();
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, next);
    s = answerTasks(s, proj(s), ["t1"], TASK.ACCEPTED, T + 5 * HOUR);
    s = reopenTasks(s, proj(s), ["t1"], T + 6 * HOUR);
    s = worked(s, 1, { id: "s2", at: T + 7 * HOUR });
    s = submitTasks(s, proj(s), ["t1"], T + 9 * HOUR, next);

    expect(ownLines(s)).toHaveLength(1);
    expect(ownLines(s)[0]).toMatchObject({
      cents: 4_000, note: "Accepted · t1 · 4h 00m at 10/hr", at: T + 9 * HOUR,
    });
    expect(isPending(ownLines(s)[0])).toBe(true);
  });

  it("keeps an amount recorded by hand, and writes no second line beside it", () => {
    let s = worked(seed(flat), 1);
    s = addEarning(s, proj(s), {
      cents: 2_500, kind: EARNING.PIECE, units: 1, taskIds: ["t1"], note: "what it earned",
    }, T + HOUR, "mine");
    s = submitTasks(s, proj(s), ["t1"], T + 2 * HOUR, counter());

    expect(ownLines(s)).toHaveLength(1);
    expect(ownLines(s)[0]).toMatchObject({ id: "mine", cents: 2_500, note: "what it earned" });
    // The task's state decides what its money is worth, and it is under review.
    expect(isPending(ownLines(s)[0])).toBe(true);
  });

  it("does not let an adjustment stand in for the reward", () => {
    // A clawback filed against the task is a correction, not what acceptance
    // pays, so the reward is still written and the clawback is left alone.
    let s = worked(seed(flat), 1);
    s = addEarning(s, proj(s), {
      cents: -500, kind: EARNING.ADJUSTMENT, taskIds: ["t1"],
    }, T + HOUR, "fix");
    s = submitTasks(s, proj(s), ["t1"], T + 2 * HOUR, counter());

    const fix = ownLines(s).find((e) => e.id === "fix");
    expect(ownLines(s)).toHaveLength(2);
    expect(payStateOf(fix)).toBe(PAY.PAID);
    expect(ownLines(s).find((e) => e.id !== "fix")).toMatchObject({ cents: 1_000, status: PAY.PENDING });
  });

  it("keeps one written reward where an earlier build left two", () => {
    // Builds before this wrote a fresh line on every hand-in, so a task that
    // went round twice can already carry two. One is all it is owed.
    let s = worked(seed(flat), 1);
    const line = { cents: 1_000, kind: EARNING.PIECE, units: 1, taskIds: ["t1"], note: "Accepted · t1" };
    s = addEarning(s, proj(s), { ...line, status: PAY.CANCELLED }, T + HOUR, "first");
    s = addEarning(s, proj(s), { ...line, status: PAY.PENDING }, T + 2 * HOUR, "second");
    s = setTaskState(s, "p1", "t1", TASK.SUBMITTED, T + 2 * HOUR);
    s = reopenTasks(s, proj(s), ["t1"], T + 3 * HOUR);
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, counter());
    s = answerTasks(s, proj(s), ["t1"], TASK.ACCEPTED, T + 5 * HOUR);

    expect(ownLines(s)).toHaveLength(1);
    expect(paidCents(s, T + 5 * HOUR)).toBe(8_000 + 1_000);
    // Deleted the ordinary way, so an Undo or a merge can still see it.
    expect(s.earnings.find((e) => e.id === "second").deletedAt).toBe(T + 4 * HOUR);
  });

  it("drops the written reward when a fresh hand-in would no longer write one", () => {
    let s = worked(seed(flat), 1);
    const next = counter();
    s = submitTasks(s, proj(s), ["t1"], T + 2 * HOUR, next);
    s = reopenTasks(s, proj(s), ["t1"], T + 3 * HOUR);
    s = { ...s, projects: [{ ...proj(s), perTask: undefined }] };
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, next);
    expect(ownLines(s)).toHaveLength(0);
  });
});

describe("reopening an answered task", () => {
  it("withdraws an accepted task's money until it is accepted again", () => {
    // "If I did it by mistake it should subtract all money added because of
    // it until I mark it accepted and paid again."
    let s = worked(seed(hourly), 3);
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, counter());
    s = answerTasks(s, proj(s), ["t1"], TASK.ACCEPTED, T + 5 * HOUR);
    s = reopenTasks(s, proj(s), ["t1"], T + 6 * HOUR);
    expect(payStateOf(s.sessions[0])).toBe(PAY.PENDING);
    expect(payStateOf(rewards(s)[0])).toBe(PAY.PENDING);
  });

  it("does the same on a project paid as worked, and handing it in again counts the hours", () => {
    let s = worked(seed({ ...asWorked, perTask: 10 }), 3);
    const next = counter();
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, next);
    s = answerTasks(s, proj(s), ["t1"], TASK.ACCEPTED, T + 5 * HOUR);
    s = reopenTasks(s, proj(s), ["t1"], T + 6 * HOUR);
    expect(payStateOf(s.sessions[0])).toBe(PAY.PENDING);
    expect(payStateOf(rewards(s)[0])).toBe(PAY.PENDING);

    s = submitTasks(s, proj(s), ["t1"], T + 7 * HOUR, next);
    expect(payStateOf(s.sessions[0])).toBe(PAY.PAID);
    expect(rewards(s)).toHaveLength(1);
    expect(payStateOf(rewards(s)[0])).toBe(PAY.PENDING);
  });

  it("leaves a reward shared across many tasks alone", () => {
    let s = seed(hourly);
    s = addTask(s, "p1", { id: "t2", label: "t2" }, T);
    s = worked(s, 3);
    s = addEarning(s, proj(s), {
      cents: 50_000, kind: EARNING.BONUS, taskIds: ["t1", "t2"],
    }, T, "shared");
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, counter());
    s = answerTasks(s, proj(s), ["t1"], TASK.ACCEPTED, T + 5 * HOUR);
    s = reopenTasks(s, proj(s), ["t1"], T + 6 * HOUR);
    expect(payStateOf(rewards(s).find((e) => e.id === "shared"))).toBe(PAY.PAID);
  });

  it("reads where the task stands from the ledger, not from a stale project", () => {
    // The caller's copy of the project can be a click behind. This one has no
    // tasks at all, and the reopen must still see that t1 was accepted.
    let s = worked(seed(hourly), 3);
    s = submitTasks(s, proj(s), ["t1"], T + 4 * HOUR, counter());
    s = answerTasks(s, proj(s), ["t1"], TASK.ACCEPTED, T + 5 * HOUR);
    s = reopenTasks(s, hourly, ["t1"], T + 6 * HOUR);
    expect(payStateOf(s.sessions[0])).toBe(PAY.PENDING);
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
