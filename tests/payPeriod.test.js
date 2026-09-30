import { describe, it, expect } from "vitest";
import {
  PERIOD, companyId, describePeriod, findCompany, nextPayout, normalisePeriod,
  payPeriodFor, setPayPeriod,
} from "../src/domain/payPeriod.js";
import { upcomingPay } from "../src/domain/payout.js";
import { submitTasks, answerTasks } from "../src/domain/settle.js";
import { TASK, setSubmittedAt } from "../src/domain/taskState.js";
import { PAY } from "../src/domain/earnings.js";
import { KIND, startSession, stopSession } from "../src/domain/sessions.js";
import { addTask } from "../src/domain/tasks.js";

const HOUR = 3_600_000;
/** A local-midnight date, built the way the domain builds them. */
const on = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const day = (t) => new Date(t).toDateString();

/** Outlier: anything in before Monday is paid the following Wednesday. */
const outlier = { kind: PERIOD.WEEKLY, cutoff: 1, payday: 3, after: 0 };
/** Alignerr: in before Monday, paid the following Friday. */
const alignerr = { kind: PERIOD.WEEKLY, cutoff: 1, payday: 5, after: 0 };

describe("reading a schedule", () => {
  it("keeps a weekly rule and fills in the missing offset", () => {
    expect(normalisePeriod({ kind: "weekly", cutoff: 1, payday: 3 }))
      .toEqual({ kind: "weekly", cutoff: 1, payday: 3, after: 0 });
  });

  it("refuses a weekday outside the week, rather than clamping into a lie", () => {
    expect(normalisePeriod({ kind: "weekly", cutoff: 0, payday: 3 })).toBeNull();
    expect(normalisePeriod({ kind: "weekly", cutoff: 1, payday: 8 })).toBeNull();
    expect(normalisePeriod({ kind: "monthly", cutoff: 32, payday: 1 })).toBeNull();
    expect(normalisePeriod({ kind: "fortnightly", cutoff: 1, payday: 3 })).toBeNull();
    expect(normalisePeriod(null)).toBeNull();
  });

  it("has no default, because there is no sensible one", () => {
    // A guessed payday would print a date nobody has reason to believe.
    expect(normalisePeriod({ kind: "weekly" })).toBeNull();
  });
});

describe("Outlier: in before Monday, paid the following Wednesday", () => {
  it("pays work from the weekend on the Wednesday just after", () => {
    // Sunday 4 Oct 2026 is before the Monday cutoff, so the period closes
    // Monday 5th and pays Wednesday 7th.
    expect(day(nextPayout(outlier, on(2026, 10, 4)))).toBe(day(on(2026, 10, 7)));
  });

  it("rolls work done ON the Monday into the next week", () => {
    // The rule says BEFORE Monday. Monday itself is not before Monday, and
    // rounding that the friendly way would promise money a week early.
    expect(day(nextPayout(outlier, on(2026, 10, 5)))).toBe(day(on(2026, 10, 14)));
  });

  it("treats the cutoff instant itself as too late", () => {
    const midnight = new Date(2026, 9, 5).getTime();
    expect(day(nextPayout(outlier, midnight))).toBe(day(on(2026, 10, 14)));
    expect(day(nextPayout(outlier, midnight - 1))).toBe(day(on(2026, 10, 7)));
  });

  it("pays a whole week's work on one day, which is the point of a period", () => {
    const tue = nextPayout(outlier, on(2026, 10, 6));
    const thu = nextPayout(outlier, on(2026, 10, 8));
    const sat = nextPayout(outlier, on(2026, 10, 10));
    expect(day(tue)).toBe(day(thu));
    expect(day(thu)).toBe(day(sat));
  });

  it("lands on a Wednesday whatever day the work was", () => {
    for (let d = 1; d <= 28; d += 1) {
      const at = nextPayout(outlier, on(2026, 10, d));
      expect(new Date(at).getDay(), `day ${d}`).toBe(3);
    }
  });
});

describe("Alignerr: in before Monday, paid the following Friday", () => {
  it("pays the Friday of the week the period closed in", () => {
    expect(day(nextPayout(alignerr, on(2026, 10, 4)))).toBe(day(on(2026, 10, 9)));
  });

  it("is always later in the week than Outlier, for the same work", () => {
    const at = on(2026, 10, 3);
    expect(nextPayout(alignerr, at)).toBeGreaterThan(nextPayout(outlier, at));
  });
});

describe("a payday further out", () => {
  it("adds whole weeks", () => {
    const later = { ...outlier, after: 1 };
    expect(day(nextPayout(later, on(2026, 10, 4)))).toBe(day(on(2026, 10, 14)));
  });

  it("pays on the cutoff day itself when that is the rule", () => {
    const monToMon = { kind: PERIOD.WEEKLY, cutoff: 1, payday: 1, after: 0 };
    expect(day(nextPayout(monToMon, on(2026, 10, 4)))).toBe(day(on(2026, 10, 5)));
  });
});

describe("a monthly schedule", () => {
  const first = { kind: PERIOD.MONTHLY, cutoff: 1, payday: 15, after: 0 };

  it("pays on the 15th after the month closes", () => {
    expect(day(nextPayout(first, on(2026, 9, 20)))).toBe(day(on(2026, 10, 15)));
  });

  it("rolls into the next month when the cutoff has passed", () => {
    expect(day(nextPayout(first, on(2026, 10, 3)))).toBe(day(on(2026, 11, 15)));
  });

  it("handles a payday before the cutoff by going round", () => {
    const late = { kind: PERIOD.MONTHLY, cutoff: 25, payday: 10, after: 0 };
    expect(day(nextPayout(late, on(2026, 10, 3)))).toBe(day(on(2026, 11, 10)));
  });

  it("clamps a day number past the end of a short month", () => {
    // The 31st of February is the 28th, not the 3rd of March.
    const endish = { kind: PERIOD.MONTHLY, cutoff: 1, payday: 31, after: 0 };
    const at = nextPayout(endish, on(2026, 1, 20));
    expect(day(at)).toBe(day(on(2026, 2, 28)));
  });

  it("does not let one short month shorten every month after it", () => {
    // Counted from the payday NUMBER, so passing through February does not
    // turn a rule paying on the 31st into one paying on the 28th for ever.
    const endish = { kind: PERIOD.MONTHLY, cutoff: 1, payday: 31, after: 1 };
    expect(new Date(nextPayout(endish, on(2026, 1, 20))).getDate()).toBe(31);
  });
});

describe("saying the rule out loud", () => {
  it("reads back as the sentence you set up", () => {
    expect(describePeriod(outlier))
      .toBe("Work in before Monday is paid the following Wednesday.");
    expect(describePeriod({ kind: PERIOD.MONTHLY, cutoff: 1, payday: 15, after: 0 }))
      .toBe("Work in before the 1st is paid on the 15th.");
  });

  it("says nothing at all where there is no rule", () => {
    expect(describePeriod(null)).toBe("");
    expect(describePeriod({ kind: "weekly", cutoff: 99, payday: 1 })).toBe("");
  });
});

describe("whose schedule it is", () => {
  const base = { projects: [], sessions: [], earnings: [], companies: [] };

  it("is the company's, so every project under it inherits one rule", () => {
    const s = setPayPeriod(base, "Outlier", outlier, 1);
    expect(payPeriodFor(s, { company: "Outlier" })).toEqual(outlier);
    expect(payPeriodFor(s, { company: "outlier " })).toEqual(outlier);
  });

  it("folds two spellings onto one record, so a merge cannot split them", () => {
    let s = setPayPeriod(base, "Northwind", outlier, 1);
    s = setPayPeriod(s, "northwind", alignerr, 2);
    expect(s.companies).toHaveLength(1);
    expect(payPeriodFor(s, { company: "Northwind" })).toEqual(alignerr);
    expect(companyId("Northwind")).toBe(companyId("northwind "));
  });

  it("has none for a project with no company", () => {
    const s = setPayPeriod(base, "Outlier", outlier, 1);
    expect(payPeriodFor(s, { company: "" })).toBeNull();
    expect(payPeriodFor(s, {})).toBeNull();
  });

  it("keeps the company when its schedule is cleared", () => {
    // Cleared is not deleted: it is still a client, it just has no stated
    // payday, and tombstoning it would read as removed on the next device.
    let s = setPayPeriod(base, "Outlier", outlier, 1);
    s = setPayPeriod(s, "Outlier", null, 2);
    expect(findCompany(s, "Outlier")).not.toBeNull();
    expect(payPeriodFor(s, { company: "Outlier" })).toBeNull();
  });

  it("ignores a blank name rather than filing a rule under nothing", () => {
    expect(setPayPeriod(base, "   ", outlier, 1)).toBe(base);
  });
});

describe("what is coming in", () => {
  const T = on(2026, 10, 3); // Saturday
  const project = {
    id: "p1", name: "Orion", company: "Outlier", currentRate: 80, bonusPerHour: 10,
    currency: "USD", paysOnAcceptance: true, tasks: [],
  };
  const proj = (s) => s.projects[0];

  const seeded = () => {
    let s = { projects: [project], sessions: [], earnings: [], companies: [] };
    s = setPayPeriod(s, "Outlier", outlier, T);
    s = addTask(s, "p1", { id: "t1", label: "1234" }, T);
    s = startSession(s, proj(s), { now: T - 4 * HOUR, id: "s1", taskId: "t1", kind: KIND.BILLED });
    return stopSession(s, "s1", T - 1 * HOUR);
  };

  it("says nothing at all before anything is submitted", () => {
    // Work in progress has no date: it has not been handed in, so no period
    // has closed on it.
    expect(upcomingPay(seeded(), T)).toEqual({ due: [], waiting: [] });
  });

  it("dates the hourly money from the day the work went in", () => {
    const s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    const { due } = upcomingPay(s, T);
    expect(due).toHaveLength(1);
    expect(day(due[0].at)).toBe(day(on(2026, 10, 7)));
    expect(due[0].cents).toBe(24_000); // 3h at 80
    expect(due[0].company).toBe("Outlier");
  });

  it("will not date a reward nobody has decided on yet", () => {
    const s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    const { due, waiting } = upcomingPay(s, T);
    // The 3h bonus at 10/hr is real money, but it has no date and must not be
    // folded into a figure that reads as expected income.
    expect(waiting).toHaveLength(1);
    expect(waiting[0].cents).toBe(3_000);
    expect(due.every((r) => r.cents === 24_000)).toBe(true);
  });

  it("dates the reward from the day it was accepted, not the day it went in", () => {
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    // Answered a fortnight later, so it rides a different period entirely.
    const answered = on(2026, 10, 20);
    s = answerTasks(s, project, ["t1"], TASK.ACCEPTED, answered);
    const { due, waiting } = upcomingPay(s, answered);
    expect(waiting).toHaveLength(0);
    /*
     * One task, two paydays, which is the whole point of the split. The hours
     * went in on Saturday 3 Oct and rode that week to Wednesday 7 Oct — by
     * the 20th that has been and gone, so it has dropped off. The answer came
     * back Tuesday 20 Oct, which is past that Monday cutoff, so the reward
     * rides the week after: Wednesday 28 Oct.
     */
    expect(due).toHaveLength(1);
    expect(day(due[0].at)).toBe(day(on(2026, 10, 28)));
    expect(due[0].cents).toBe(3_000);
  });

  it("files work by the day it went in, not the day the box was ticked", () => {
    /*
     * The bug this fixes, on Outlier's rule: in before Monday, paid the
     * following Wednesday.
     *
     * Work handed in on Saturday 26 September is before the Monday cutoff, so
     * it belongs to the period paying Wednesday 30 September. Ticking Submit
     * on the Wednesday used to stamp THAT day, which is past the cutoff, and
     * quietly pushed the money to the 7th of October — a whole payday late,
     * for a reason nothing on screen explained.
     */
    const saturday = on(2026, 9, 26);
    const ticked = on(2026, 9, 30);

    const byTick = submitTasks(seeded(), project, ["t1"], ticked, () => "e1");
    expect(day(upcomingPay(byTick, ticked).due[0].at)).toBe(day(on(2026, 10, 7)));

    const byDay = submitTasks(seeded(), project, ["t1"], ticked, () => "e1", saturday);
    expect(day(upcomingPay(byDay, ticked).due[0].at)).toBe(day(on(2026, 9, 30)));
  });

  it("still values the hours by the clock, not by the day chosen", () => {
    // The chosen day decides which period the money falls in and nothing
    // else. It must never reach an amount.
    const ticked = on(2026, 9, 30);
    const byTick = submitTasks(seeded(), project, ["t1"], ticked, () => "e1");
    const byDay = submitTasks(seeded(), project, ["t1"], ticked, () => "e1", on(2026, 9, 26));
    const total = (x) => upcomingPay(x, ticked).due.reduce((n, r) => n + r.cents, 0);
    expect(total(byDay)).toBe(total(byTick));
  });

  it("lets a date recorded wrong be put right afterwards", () => {
    const ticked = on(2026, 9, 30);
    let s = submitTasks(seeded(), project, ["t1"], ticked, () => "e1");
    expect(day(upcomingPay(s, ticked).due[0].at)).toBe(day(on(2026, 10, 7)));
    s = setSubmittedAt(s, "p1", "t1", on(2026, 9, 26));
    expect(day(upcomingPay(s, ticked).due[0].at)).toBe(day(on(2026, 9, 30)));
  });

  it("will not invent a handed-in date for a task still being worked", () => {
    const s = setSubmittedAt(seeded(), "p1", "t1", on(2026, 9, 26));
    expect(s.projects[0].tasks[0].submittedAt).toBeUndefined();
  });

  it("does not let the answer re-date the hours behind you", () => {
    // One stateAt for both would have moved three hours of settled work into
    // a period it was never part of, silently, weeks after the fact.
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    const beforeAnswer = upcomingPay(s, T).due.find((r) => r.cents === 24_000).at;
    s = answerTasks(s, project, ["t1"], TASK.ACCEPTED, on(2026, 10, 20));
    const afterAnswer = upcomingPay(s, T).due.find((r) => r.cents === 24_000).at;
    expect(afterAnswer).toBe(beforeAnswer);
  });

  it("keeps the hours when work is rejected, and drops the reward", () => {
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    s = answerTasks(s, project, ["t1"], TASK.CANCELLED, T);
    const { due, waiting } = upcomingPay(s, T);
    expect(waiting).toHaveLength(0);
    expect(due).toHaveLength(1);
    expect(due[0].cents).toBe(24_000);
  });

  it("drops a payday that has already been and gone", () => {
    const s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    // Looking back from a month later: that money arrived.
    expect(upcomingPay(s, on(2026, 11, 20)).due).toEqual([]);
  });

  it("forecasts nothing for a company with no schedule", () => {
    let s = seeded();
    s = setPayPeriod(s, "Outlier", null, T);
    const after = submitTasks(s, project, ["t1"], T, () => "e1");
    expect(upcomingPay(after, T).due).toEqual([]);
  });

  it("sums a payday across tasks, because that is one payment", () => {
    let s = seeded();
    s = addTask(s, "p1", { id: "t2", label: "1235" }, T);
    s = startSession(s, proj(s), { now: T - 9 * HOUR, id: "s2", taskId: "t2" });
    s = stopSession(s, "s2", T - 8 * HOUR);
    s = submitTasks(s, proj(s), ["t1", "t2"], T, (() => {
      let n = 0;
      return () => `e${++n}`;
    })());
    const { due } = upcomingPay(s, T);
    expect(due).toHaveLength(1);
    expect(due[0].items).toBe(2);
    expect(due[0].cents).toBe(24_000 + 8_000);
  });

  it("keeps two clients on their own paydays", () => {
    let s = seeded();
    s.projects = [...s.projects, {
      ...project, id: "p2", name: "Tasks", company: "Alignerr", tasks: [],
    }];
    s = setPayPeriod(s, "Alignerr", alignerr, T);
    s = addTask(s, "p2", { id: "u1", label: "9000" }, T);
    s = startSession(s, s.projects[1], { now: T - 3 * HOUR, id: "s3", taskId: "u1" });
    s = stopSession(s, "s3", T - 2 * HOUR);
    s = submitTasks(s, s.projects[0], ["t1"], T, () => "e1");
    s = submitTasks(s, s.projects[1], ["u1"], T, () => "e2");

    const { due } = upcomingPay(s, T);
    expect(due).toHaveLength(2);
    // Soonest first: Outlier's Wednesday before Alignerr's Friday.
    expect(due.map((r) => r.company)).toEqual(["Outlier", "Alignerr"]);
    expect(day(due[0].at)).toBe(day(on(2026, 10, 7)));
    expect(day(due[1].at)).toBe(day(on(2026, 10, 9)));
  });

  it("never mixes currencies into one figure", () => {
    let s = seeded();
    s.projects = [...s.projects, {
      ...project, id: "p2", name: "Egypt", company: "Outlier", currency: "EGP", tasks: [],
    }];
    s = addTask(s, "p2", { id: "u1", label: "9000" }, T);
    s = startSession(s, s.projects[1], { now: T - 3 * HOUR, id: "s3", taskId: "u1" });
    s = stopSession(s, "s3", T - 2 * HOUR);
    s = submitTasks(s, s.projects[0], ["t1"], T, () => "e1");
    s = submitTasks(s, s.projects[1], ["u1"], T, () => "e2");

    const { due } = upcomingPay(s, T);
    expect(due).toHaveLength(2);
    expect(new Set(due.map((r) => r.currency))).toEqual(new Set(["USD", "EGP"]));
  });

  it("leaves off-clock time out, as every other earnings figure does", () => {
    let s = seeded();
    s.projects = [{ ...proj(s), offClock: true }];
    const after = submitTasks(s, proj(s), ["t1"], T, () => "e1");
    expect(upcomingPay(after, T).due).toEqual([]);
  });

  it("does not schedule a reward shared across many tasks", () => {
    // Fifty tasks covered by one milestone is not this task's money to date.
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    s = {
      ...s,
      earnings: s.earnings.map((e) => ({ ...e, taskIds: ["t1", "other"], status: PAY.PENDING })),
    };
    expect(upcomingPay(s, T).waiting).toEqual([]);
  });
});
