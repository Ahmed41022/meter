import { describe, it, expect } from "vitest";
import {
  PERIOD, companyId, describePeriod, findCompany, nextClose, nextPayout, normalisePeriod,
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

/**
 * Outlier: anything in before Monday is paid the following Wednesday.
 *
 * Spelled out to the normalised shape, because these are compared against
 * what comes back out of the ledger. A cutoff with no time on it closes at
 * midnight on this device's own clock — which is what every rule meant before
 * a cutoff could carry a time at all.
 */
const outlier = { kind: PERIOD.WEEKLY, cutoff: 1, payday: 3, after: 0, closesAt: 0, zone: null };
/** Alignerr: in before Monday, paid the following Friday. */
const alignerr = { kind: PERIOD.WEEKLY, cutoff: 1, payday: 5, after: 0, closesAt: 0, zone: null };

describe("reading a schedule", () => {
  it("keeps a weekly rule and fills in the missing offset", () => {
    expect(normalisePeriod({ kind: "weekly", cutoff: 1, payday: 3 }))
      .toEqual({ kind: "weekly", cutoff: 1, payday: 3, after: 0, closesAt: 0, zone: null });
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

describe("a cutoff with an hour and a clock of its own", () => {
  /**
   * The rule as a platform actually states it: the week runs Monday through
   * Sunday and shuts Sunday at 7pm Eastern, paid the following Friday.
   */
  const stated = {
    kind: PERIOD.WEEKLY, cutoff: 7, payday: 5, after: 0,
    closesAt: 19 * 60, zone: "America/New_York",
  };

  /**
   * A date as a named zone reads it.
   *
   * Every assertion here goes through this, because a `toDateString()` would
   * render on whichever clock the machine running the test happens to keep —
   * and these answers are deliberately not computed on that clock.
   */
  const dateIn = (t, zone) => new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(t);

  /** An instant, named by what a New York clock reads at it. The offset is
   *  written out so each test says which side of a DST change it is on. */
  const edt = (text) => new Date(`${text}-04:00`).getTime();
  const est = (text) => new Date(`${text}-05:00`).getTime();

  it("shuts at the hour it says, not at midnight", () => {
    // Two minutes apart, two different paydays a week apart. With a
    // whole-day cutoff both of these were the same week, which is the bug.
    const before = nextPayout(stated, edt("2026-09-27T18:59"));
    const after = nextPayout(stated, edt("2026-09-27T19:01"));
    expect(dateIn(before, "America/New_York")).toBe("2026-10-02");
    expect(dateIn(after, "America/New_York")).toBe("2026-10-09");
  });

  it("is not before the cutoff at the cutoff itself", () => {
    // Strictly before, as the rule says. Rounding this the friendly way
    // would promise money a week early.
    expect(nextPayout(stated, edt("2026-09-27T19:00")))
      .toBe(nextPayout(stated, edt("2026-09-27T19:01")));
  });

  it("reads the hour on the client's clock, not on yours", () => {
    /*
     * Sunday 7pm in New York is two o'clock on Monday morning in Cairo. Work
     * handed in at one in the morning, Cairo time, is therefore still LAST
     * week's and paid on the 2nd — while the same clock-face hour read
     * locally would have called it next week's and said the 9th.
     *
     * This is the half of the feature that earns its keep. An hour typed
     * without a zone is wrong by the distance between two countries.
     */
    const oneAmCairo = new Date("2026-09-28T01:00+03:00").getTime();
    const threeAmCairo = new Date("2026-09-28T03:00+03:00").getTime();
    expect(dateIn(nextPayout(stated, oneAmCairo), "America/New_York")).toBe("2026-10-02");
    expect(dateIn(nextPayout(stated, threeAmCairo), "America/New_York")).toBe("2026-10-09");
  });

  it("follows the clock through a daylight-saving change", () => {
    /*
     * The same wall time in UTC, five weeks apart, landing on opposite sides
     * of the cutoff — because New York moved and the rule did not.
     *
     * 25 Oct 23:30 UTC is 19:30 EDT, past the 7pm close, so it is next
     * week's and waits until Friday 6 November. 8 Nov 23:30 UTC is 18:30 EST,
     * half an hour BEFORE the close, so it is that week's and is paid that
     * Friday, the 13th. An offset remembered rather than read would have put
     * both on the same side.
     */
    const lateOctober = new Date("2026-10-25T23:30Z").getTime();
    const lateNovember = new Date("2026-11-08T23:30Z").getTime();
    expect(dateIn(nextPayout(stated, lateOctober), "America/New_York")).toBe("2026-11-06");
    expect(dateIn(nextPayout(stated, lateNovember), "America/New_York")).toBe("2026-11-13");
    // And the payday itself is a date on that clock, not an instant dragged
    // an hour either way by the change.
    expect(new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(nextPayout(stated, est("2026-11-08T18:30")))).toBe("00:00");
  });

  it("still means midnight here when it says nothing", () => {
    // Absent-field-means-what-it-always-meant. A rule written before a cutoff
    // could carry an hour must answer exactly as it did.
    const bare = { kind: PERIOD.WEEKLY, cutoff: 1, payday: 3, after: 0 };
    const spelled = { ...bare, closesAt: 0, zone: null };
    const when = on(2026, 9, 26);
    expect(nextPayout(bare, when)).toBe(nextPayout(spelled, when));
    expect(day(nextPayout(bare, when))).toBe(day(on(2026, 9, 30)));
  });

  it("drops a zone this device has never heard of", () => {
    // An unknown name throws inside Intl on every render. Falling back to the
    // local clock is hours out at worst; the alternative is a blank screen.
    expect(normalisePeriod({ ...stated, zone: "Mars/Olympus_Mons" }).zone).toBeNull();
    expect(normalisePeriod({ ...stated, zone: "  " }).zone).toBeNull();
    expect(normalisePeriod({ ...stated, closesAt: 9_999 }).closesAt).toBe(0);
  });

  it("says the hour and the clock out loud", () => {
    expect(describePeriod(stated))
      .toBe("Work in before Sunday at 19:00 New York time is paid the following Friday.");
    // Silent where there is nothing to say, so an old rule reads unchanged.
    expect(describePeriod(outlier))
      .toBe("Work in before Monday is paid the following Wednesday.");
  });

  it("closes a monthly period at its hour too, and still pays on the day", () => {
    // A period that shuts on the 1st at seven in the evening and pays on the
    // 1st pays that same day — which is what it says, and what it did before
    // a cutoff could carry a time at all.
    const monthly = {
      kind: PERIOD.MONTHLY, cutoff: 1, payday: 1, after: 0,
      closesAt: 19 * 60, zone: "America/New_York",
    };
    expect(dateIn(nextPayout(monthly, edt("2026-10-01T18:00")), "America/New_York"))
      .toBe("2026-10-01");
    expect(dateIn(nextPayout(monthly, edt("2026-10-01T20:00")), "America/New_York"))
      .toBe("2026-11-01");
  });

  it("tells you when the period shuts, so a zone can be checked", () => {
    const closes = nextClose(stated, edt("2026-09-27T12:00"));
    expect(new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/New_York", weekday: "short", hour: "2-digit",
      minute: "2-digit", hour12: false,
    }).format(closes)).toBe("Sun 19:00");
    expect(nextClose(null, 1)).toBeNull();
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

  it("pays an accepted reward on the week the work went in, not the week it was read", () => {
    /*
     * The platforms' own rule: a task straddling two pay periods counts
     * toward the week you SUBMITTED it. So a Saturday submission answered on
     * the Monday is still Saturday's week — and Saturday's week pays
     * Wednesday 7 October, the same day as its own hours.
     *
     * Dating it from the answer instead pushed it a week out, which is how a
     * single task came to show two payments a week apart for work that went
     * in on one afternoon.
     */
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    const answered = on(2026, 10, 5); // the Monday after, well before the payday
    s = answerTasks(s, project, ["t1"], TASK.ACCEPTED, answered);
    const { due, waiting } = upcomingPay(s, answered);
    expect(waiting).toHaveLength(0);
    // One payday, both kinds of money on it: 3h at 80 plus 3h of the 10/hr
    // uplift.
    expect(due).toHaveLength(1);
    expect(day(due[0].at)).toBe(day(on(2026, 10, 7)));
    expect(due[0].cents).toBe(27_000);
  });

  it("still catches the payday when the period has shut but not yet paid", () => {
    /*
     * The case that makes this a payday comparison and not a period one.
     *
     * Outlier's week shuts Monday and pays Wednesday. An answer arriving
     * Monday afternoon is past the cutoff — its own period pays a week later
     * — but Wednesday's money has not gone anywhere yet, so the reward is
     * still on it. Comparing the two periods instead of the two paydays
     * pushed this a week out.
     */
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    s = answerTasks(s, project, ["t1"], TASK.ACCEPTED, on(2026, 10, 5, 16));
    const { due } = upcomingPay(s, on(2026, 10, 5, 16));
    expect(due).toHaveLength(1);
    expect(day(due[0].at)).toBe(day(on(2026, 10, 7)));
  });

  it("waits for the next run when the answer lands on the payday itself", () => {
    // It might just make that day's processing. A forecast that promises
    // money early is worse than one that is pessimistic by a week once.
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    const onPayday = on(2026, 10, 7, 10);
    s = answerTasks(s, project, ["t1"], TASK.ACCEPTED, onPayday);
    const reward = upcomingPay(s, onPayday).due.find((r) => r.cents === 3_000);
    expect(day(reward.at)).toBe(day(on(2026, 10, 14)));
  });

  it("carries the reward forward when that payday has already gone", () => {
    /*
     * The one exception, and the reason this is not simply "use the
     * submission date". The hours went in Saturday 3 Oct and were paid
     * Wednesday 7 Oct. An answer arriving on the 20th cannot have been on
     * that payment — it had already gone out — so the reward rides the next
     * run that can still carry it: Wednesday 28 Oct.
     */
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    const answered = on(2026, 10, 20);
    s = answerTasks(s, project, ["t1"], TASK.ACCEPTED, answered);
    const { due } = upcomingPay(s, answered);
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

  it("forecasts nothing at all for work that was rejected", () => {
    // Payment is per accepted task, so a rejection leaves no money to date:
    // not the reward, and not the hours either. The hours stay on the record
    // and in every time figure; they simply have no payday.
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    s = answerTasks(s, project, ["t1"], TASK.CANCELLED, T);
    expect(upcomingPay(s, T)).toEqual({ due: [], waiting: [] });
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
