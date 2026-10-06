import { describe, it, expect } from "vitest";
import {
  PERIOD, companyId, dayOnClock, describePeriod, findCompany, knownZone, nextClose, nextPayout,
  normalisePeriod, payPeriodFor, paydayFor, samePeriod, setPayPeriod, storedPeriodFor,
} from "../src/domain/payPeriod.js";
import { upcomingPay } from "../src/domain/payout.js";
import { submitTasks, answerTasks } from "../src/domain/settle.js";
import { TASK, setAnsweredAt, setSubmittedAt } from "../src/domain/taskState.js";
import { EARNING, PAY, addEarning } from "../src/domain/earnings.js";
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

  it("keeps a zone it has never heard of when the rule is saved", () => {
    // Dropped for working dates out, but kept in the ledger: it is still the
    // client's clock, the device that set it may know it, and a save here
    // erased it for every device.
    const s = setPayPeriod({ projects: [], companies: [] }, "Outlier",
                           { ...stated, zone: "Mars/Olympus_Mons" }, 1);
    expect(s.companies[0].payPeriod.zone).toBe("Mars/Olympus_Mons");
    expect(payPeriodFor(s, { company: "Outlier" }).zone).toBeNull();
    expect(storedPeriodFor(s, { company: "Outlier" }).zone).toBe("Mars/Olympus_Mons");
    expect(knownZone("Mars/Olympus_Mons")).toBeNull();
    expect(knownZone(" Asia/Kolkata ")).toBe("Asia/Kolkata");
  });

  it("compares two rules by what they say, unknown zones by name", () => {
    expect(samePeriod(stated, { ...stated, closesAt: 19 * 60, after: 0 })).toBe(true);
    expect(samePeriod({ ...stated, zone: "Mars/A" }, { ...stated, zone: "Mars/B" })).toBe(false);
    expect(samePeriod(null, stated)).toBe(false);
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

describe("a payday on a clock east of this one", () => {
  /*
   * Paid the Wednesday after a week that shuts at midnight on Monday, on the
   * client's clock. Kolkata is 2h30m ahead of Cairo in October and Auckland
   * ten hours ahead, so the client's Wednesday begins on Cairo's Tuesday —
   * and on New York's Tuesday morning. A payday stamped as the client's
   * midnight and then printed on the device's clock showed Tuesday, and
   * dropped off the list at the device's midnight, a day early.
   */
  const kolkata = { kind: PERIOD.WEEKLY, cutoff: 1, payday: 3, after: 0, closesAt: 0, zone: "Asia/Kolkata" };
  const auckland = { ...kolkata, zone: "Pacific/Auckland" };
  /** Instants written as a clock reads them, offset and all, so no test
   *  depends on the zone the suite runs in. */
  const cairo = (text) => new Date(`${text}+03:00`).getTime();
  const newYork = (text) => new Date(`${text}-04:00`).getTime();
  const ist = (text) => new Date(`${text}+05:30`).getTime();
  const nzdt = (text) => new Date(`${text}+13:00`).getTime();
  /** A date as the Overview prints it: from the date itself, through UTC. */
  const weekday = (date) => new Date(`${date}T00:00:00Z`)
    .toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long" });

  /** One task on a client with `rule`, accepted at `answered`. */
  const accepted = (rule, answered) => {
    const T0 = answered - 30 * HOUR;
    let s = {
      projects: [{ id: "p1", name: "Ganges", company: "Client", currentRate: 20, currency: "USD", tasks: [] }],
      sessions: [], earnings: [], companies: [],
    };
    s = setPayPeriod(s, "Client", rule, T0);
    s = addTask(s, "p1", { id: "t1", label: "1234" }, T0);
    s = startSession(s, s.projects[0], { now: T0, id: "s1", taskId: "t1" });
    s = stopSession(s, "s1", T0 + HOUR);
    s = submitTasks(s, s.projects[0], ["t1"], T0 + 2 * HOUR, () => "e1");
    return answerTasks(s, s.projects[0], ["t1"], TASK.ACCEPTED, answered);
  };

  it("names a Kolkata payday by Kolkata's calendar", () => {
    const pay = paydayFor(kolkata, ist("2026-10-03T12:00"));
    expect(pay.date).toBe("2026-10-07");
    expect(weekday(pay.date)).toBe("Wednesday");
    // The instant is that midnight on Kolkata's clock, kept for ordering.
    expect(pay.at).toBe(ist("2026-10-07T00:00"));
  });

  it("lists it on its own Wednesday when seen from Cairo, and only then drops it", () => {
    const s = accepted(kolkata, ist("2026-10-03T12:00"));
    // Wednesday noon in Cairo is Wednesday afternoon in Kolkata: payday. The
    // old check compared Kolkata's midnight (Tuesday 21:30 here) with Cairo's
    // and had already dropped it.
    const noon = upcomingPay(s, cairo("2026-10-07T12:00")).due;
    expect(noon).toHaveLength(1);
    expect(noon[0].date).toBe("2026-10-07");
    // Tuesday evening in Cairo is already Wednesday in Kolkata, and the row
    // still says Wednesday, not the Tuesday this clock is on.
    expect(upcomingPay(s, cairo("2026-10-06T22:30")).due[0].date).toBe("2026-10-07");
    // 22:00 on Wednesday in Cairo is past midnight in Kolkata: it has come.
    expect(upcomingPay(s, cairo("2026-10-07T22:00")).due).toEqual([]);
  });

  it("lists it on its own Wednesday when seen from New York, and only then drops it", () => {
    const s = accepted(kolkata, ist("2026-10-03T12:00"));
    expect(upcomingPay(s, newYork("2026-10-07T09:00")).due[0].date).toBe("2026-10-07");
    // 15:00 in New York is 00:30 on Thursday in Kolkata.
    expect(upcomingPay(s, newYork("2026-10-07T15:00")).due).toEqual([]);
  });

  it("does the same for Auckland, a whole day ahead of New York's morning", () => {
    const s = accepted(auckland, nzdt("2026-10-03T12:00"));
    expect(paydayFor(auckland, nzdt("2026-10-03T12:00")).date).toBe("2026-10-07");
    // Tuesday 09:00 in New York is already Wednesday 02:00 in Auckland, and
    // Tuesday 15:00 in Cairo is Wednesday 01:00 there: payday, both times.
    expect(upcomingPay(s, newYork("2026-10-06T09:00")).due[0].date).toBe("2026-10-07");
    expect(upcomingPay(s, cairo("2026-10-06T15:00")).due[0].date).toBe("2026-10-07");
    // Wednesday 08:00 in New York and 14:00 in Cairo are both Thursday there.
    expect(upcomingPay(s, newYork("2026-10-07T08:00")).due).toEqual([]);
    expect(upcomingPay(s, cairo("2026-10-07T14:00")).due).toEqual([]);
  });

  it("gives work under review a floor named on the client's calendar too", () => {
    // Monday 01:00 in Cairo is 03:30 in Kolkata: the week shut at midnight
    // there, so the soonest is the Wednesday after next.
    let s = accepted(kolkata, ist("2026-10-03T12:00"));
    s = addTask(s, "p1", { id: "t2", label: "1235" }, cairo("2026-10-04T09:00"));
    s = startSession(s, s.projects[0], { now: cairo("2026-10-04T09:00"), id: "s2", taskId: "t2" });
    s = stopSession(s, "s2", cairo("2026-10-04T10:00"));
    s = submitTasks(s, s.projects[0], ["t2"], cairo("2026-10-05T01:00"), () => "e2");
    const { waiting } = upcomingPay(s, cairo("2026-10-05T01:00"));
    expect(waiting).toHaveLength(1);
    expect(waiting[0].date).toBe("2026-10-14");
  });

  it("knows which day it is on the client's clock", () => {
    expect(dayOnClock(kolkata, cairo("2026-10-06T22:30"))).toBe("2026-10-07");
    expect(dayOnClock(auckland, newYork("2026-10-06T09:00"))).toBe("2026-10-07");
    // No zone means this device's own clock, as it always has.
    expect(dayOnClock({ ...kolkata, zone: null }, cairo("2026-10-06T22:30"))).toBe("2026-10-06");
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

  it("gives work still under review a floor, not a date", () => {
    /*
     * The rule turns on where the review falls relative to the payday, so
     * until somebody has reviewed it the date is a fact about the future. It
     * makes Wednesday the 7th if they get to it in time and the week after
     * if they do not, and nothing here can know which.
     */
    const s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    const { due, waiting } = upcomingPay(s, T);
    expect(due).toEqual([]);
    expect(waiting).toHaveLength(1);
    expect(day(waiting[0].at)).toBe(day(on(2026, 10, 7)));
    expect(waiting[0].company).toBe("Outlier");
  });

  it("keeps one task's money together while it waits", () => {
    // The hours and the reward hang on the same answer, so putting half under
    // a confident date and half under none said two things about one task.
    const s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    const { waiting } = upcomingPay(s, T);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].cents).toBe(27_000); // 3h at 80, plus 3h of the 10/hr uplift
    // One task, however many lines its money is recorded on.
    expect(waiting[0].items).toBe(1);
  });

  it("pays an accepted task on the period its ANSWER fell in", () => {
    /*
     * The case Ahmed hit, and the one that settled this rule.
     *
     * Outlier's week shuts Monday and pays Wednesday. Work handed in on
     * Saturday 3 October belongs to the week shutting Monday the 5th, which
     * pays Wednesday the 7th. But the answer came back on the 5th AFTER that
     * week had shut, so the task missed that batch: it rides the next one and
     * pays Wednesday the 14th.
     *
     * Dating it from submission instead put it on the 7th, and once the 7th
     * had been and gone the money vanished off the panel as though it had
     * arrived.
     */
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    const answered = on(2026, 10, 5, 16); // Monday afternoon, past the cutoff
    s = answerTasks(s, project, ["t1"], TASK.ACCEPTED, answered);
    const { due, waiting } = upcomingPay(s, answered);
    expect(waiting).toHaveLength(0);
    expect(due).toHaveLength(1);
    expect(day(due[0].at)).toBe(day(on(2026, 10, 14)));
    // Hours and uplift together: 3h at 80 plus 3h of the 10/hr.
    expect(due[0].cents).toBe(27_000);
  });

  it("pays it on the near payday when the answer beats the cutoff", () => {
    // Answered on the Sunday, before the week shuts on Monday, so it makes
    // that week's batch and pays the Wednesday after it.
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    const answered = on(2026, 10, 4, 10);
    s = answerTasks(s, project, ["t1"], TASK.ACCEPTED, answered);
    const { due } = upcomingPay(s, answered);
    expect(day(due[0].at)).toBe(day(on(2026, 10, 7)));
  });

  it("carries the reward forward when the answer is weeks late", () => {
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    const answered = on(2026, 10, 20);
    s = answerTasks(s, project, ["t1"], TASK.ACCEPTED, answered);
    const { due } = upcomingPay(s, answered);
    expect(due).toHaveLength(1);
    expect(day(due[0].at)).toBe(day(on(2026, 10, 28)));
  });

  it("does not drop an accepted task whose submission payday has passed", () => {
    /*
     * The symptom Ahmed reported. Handed in on Sunday 27 September, accepted
     * on Wednesday the 30th. Its submission week paid Wednesday the 30th; by
     * the time you look, on 3 October, that day has gone. Dating from
     * submission dropped the task as already paid. Dating from the answer
     * puts it where the money actually is: the following Wednesday.
     */
    let s = submitTasks(seeded(), project, ["t1"], on(2026, 9, 27, 18),
                        () => "e1", on(2026, 9, 27, 18));
    s = answerTasks(s, project, ["t1"], TASK.ACCEPTED, on(2026, 9, 30, 12));
    const { due } = upcomingPay(s, on(2026, 10, 3));
    expect(due).toHaveLength(1);
    expect(day(due[0].at)).toBe(day(on(2026, 10, 7)));
  });

  it("records the day work went in, not the day the box was ticked", () => {
    /*
     * Submitting stamps the day chosen rather than the moment of the click.
     *
     * This no longer moves any payday — the money rides the day a task is
     * ANSWERED — but it is still the record of when the work was delivered,
     * which is the thing a bonus window or a query about a late review turns
     * on. Getting it from `Date.now()` made it simply untrue.
     */
    const saturday = on(2026, 9, 26);
    const ticked = on(2026, 9, 30);

    const byTick = submitTasks(seeded(), project, ["t1"], ticked, () => "e1");
    expect(day(byTick.projects[0].tasks[0].submittedAt)).toBe(day(ticked));

    const byDay = submitTasks(seeded(), project, ["t1"], ticked, () => "e1", saturday);
    expect(day(byDay.projects[0].tasks[0].submittedAt)).toBe(day(saturday));
  });

  it("still values the hours by the clock, not by the day chosen", () => {
    // The chosen day decides which period the money falls in and nothing
    // else. It must never reach an amount.
    const ticked = on(2026, 9, 30);
    const byTick = submitTasks(seeded(), project, ["t1"], ticked, () => "e1");
    const byDay = submitTasks(seeded(), project, ["t1"], ticked, () => "e1", on(2026, 9, 26));
    const total = (x) => upcomingPay(x, ticked).waiting.reduce((n, r) => n + r.cents, 0);
    expect(total(byDay)).toBe(total(byTick));
  });

  it("lets a date recorded wrong be put right afterwards", () => {
    const ticked = on(2026, 9, 30);
    let s = submitTasks(seeded(), project, ["t1"], ticked, () => "e1");
    s = setSubmittedAt(s, "p1", "t1", on(2026, 9, 26));
    expect(day(s.projects[0].tasks[0].submittedAt)).toBe(day(on(2026, 9, 26)));
  });

  it("lets the day the answer came back be put right afterwards", () => {
    /*
     * The date that decides the pay run, so the one worth being able to fix.
     * An acceptance read on the Sunday but ticked off on the Monday has
     * crossed Outlier's cutoff: recorded as Monday it pays the 14th, and put
     * back to the Sunday it pays the 7th, which is where the money is.
     */
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    s = answerTasks(s, project, ["t1"], TASK.ACCEPTED, on(2026, 10, 5, 16));
    expect(day(upcomingPay(s, T).due[0].at)).toBe(day(on(2026, 10, 14)));

    s = setAnsweredAt(s, "p1", "t1", on(2026, 10, 4, 12));
    expect(day(upcomingPay(s, T).due[0].at)).toBe(day(on(2026, 10, 7)));
  });

  it("moves the forecast with that date and never an amount", () => {
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    s = answerTasks(s, project, ["t1"], TASK.ACCEPTED, on(2026, 10, 5, 16));
    const before = upcomingPay(s, T).due[0].cents;
    s = setAnsweredAt(s, "p1", "t1", on(2026, 10, 4, 12));
    expect(upcomingPay(s, T).due[0].cents).toBe(before);
  });

  it("will not invent an answered date for a task still being worked", () => {
    // No state, nothing decided, nothing to date. The same guard the
    // handed-in date has, for the same reason.
    const s = setAnsweredAt(seeded(), "p1", "t1", on(2026, 9, 26));
    expect(s.projects[0].tasks[0].stateAt).toBeUndefined();
  });

  it("will not invent a handed-in date for a task still being worked", () => {
    const s = setSubmittedAt(seeded(), "p1", "t1", on(2026, 9, 26));
    expect(s.projects[0].tasks[0].submittedAt).toBeUndefined();
  });

  it("dates the whole task from its answer, hours and reward alike", () => {
    // One payment per accepted task, so there is nothing to split across two
    // days. Whatever period the answer falls in carries all of it.
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    s = answerTasks(s, project, ["t1"], TASK.ACCEPTED, on(2026, 10, 20));
    const { due } = upcomingPay(s, on(2026, 10, 20));
    expect(due).toHaveLength(1);
    expect(due[0].cents).toBe(27_000);
    expect(day(due[0].at)).toBe(day(on(2026, 10, 28)));
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
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    s = answerTasks(s, project, ["t1"], TASK.ACCEPTED, on(2026, 10, 5));
    // Looking back from a month later: that money arrived.
    expect(upcomingPay(s, on(2026, 11, 20))).toEqual({ due: [], waiting: [] });
  });

  it("forecasts nothing for a company with no schedule", () => {
    let s = seeded();
    s = setPayPeriod(s, "Outlier", null, T);
    const after = submitTasks(s, project, ["t1"], T, () => "e1");
    expect(upcomingPay(after, T)).toEqual({ due: [], waiting: [] });
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
    const { waiting } = upcomingPay(s, T);
    expect(waiting).toHaveLength(1);
    expect(waiting[0].items).toBe(2);
    // Two tasks: 3h and 1h at 80, each with the 10/hr uplift beside it.
    expect(waiting[0].cents).toBe(24_000 + 8_000 + 3_000 + 1_000);
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

    const { waiting } = upcomingPay(s, T);
    expect(waiting).toHaveLength(2);
    // Soonest first: Outlier's Wednesday before Alignerr's Friday.
    expect(waiting.map((r) => r.company)).toEqual(["Outlier", "Alignerr"]);
    expect(day(waiting[0].at)).toBe(day(on(2026, 10, 7)));
    expect(day(waiting[1].at)).toBe(day(on(2026, 10, 9)));
  });

  it("keeps one client on one row however its name was typed", () => {
    // The schedule is found by the folded name, so these two share a payday;
    // keyed by spelling, they were two rows for one payment on the same day.
    let s = seeded();
    s.projects = [...s.projects, {
      ...project, id: "p2", name: "Tasks", company: "outlier ", tasks: [],
    }];
    s = addTask(s, "p2", { id: "u1", label: "9000" }, T);
    s = startSession(s, s.projects[1], { now: T - 3 * HOUR, id: "s3", taskId: "u1" });
    s = stopSession(s, "s3", T - 2 * HOUR);
    s = submitTasks(s, s.projects[0], ["t1"], T, () => "e1");
    s = submitTasks(s, s.projects[1], ["u1"], T, () => "e2");

    const { waiting } = upcomingPay(s, T);
    expect(waiting).toHaveLength(1);
    // Shown as it was first written.
    expect(waiting[0]).toMatchObject({ company: "Outlier", items: 2 });
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

    const { waiting } = upcomingPay(s, T);
    expect(waiting).toHaveLength(2);
    expect(new Set(waiting.map((r) => r.currency))).toEqual(new Set(["USD", "EGP"]));
  });

  it("leaves off-clock time out, as every other earnings figure does", () => {
    let s = seeded();
    s.projects = [{ ...proj(s), offClock: true }];
    const after = submitTasks(s, proj(s), ["t1"], T, () => "e1");
    expect(upcomingPay(after, T)).toEqual({ due: [], waiting: [] });
  });

  it("lists a reward shared across many tasks on a line of its own", () => {
    // Fifty tasks covered by one milestone is not this task's money, so it is
    // not added to the task's line; but it is money coming in, so it is not
    // left off the panel either. A task id the project no longer has holds
    // nothing back.
    let s = submitTasks(seeded(), project, ["t1"], T, () => "e1");
    s = {
      ...s,
      earnings: s.earnings.map((e) => ({ ...e, taskIds: ["t1", "other"], status: PAY.PENDING })),
    };
    const { waiting } = upcomingPay(s, T);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ cents: 27_000, items: 1, rewards: 1 });
    const task = waiting[0].tasks.find((line) => line.kind === "task");
    const reward = waiting[0].tasks.find((line) => line.kind === "reward");
    expect(task.cents).toBe(24_000); // 3h at 80, and nothing of the milestone
    expect(reward).toMatchObject({ cents: 3_000, covers: 2 });
  });
});

describe("a reward shared across several tasks", () => {
  /*
   * "Finish six and we pay you X." One payment, paid in the run for the
   * period its LAST task got there: the latest acceptance where the project
   * pays once accepted, the latest hand-in where it pays as worked.
   */
  const T = on(2026, 10, 3); // Saturday
  const base = {
    id: "p1", name: "Orion", company: "Outlier", currentRate: 80, currency: "USD",
    paysOnAcceptance: true, tasks: [],
  };

  /** Three tasks with an hour each, all handed in, and a $60 reward naming
   *  all three. */
  const ledger = (project = base) => {
    let s = { projects: [project], sessions: [], earnings: [], companies: [] };
    s = setPayPeriod(s, "Outlier", outlier, T);
    for (const id of ["t1", "t2", "t3"]) {
      s = addTask(s, "p1", { id, label: id }, T);
      s = startSession(s, s.projects[0], { now: T - 5 * HOUR, id: `s-${id}`, taskId: id });
      s = stopSession(s, `s-${id}`, T - 4 * HOUR);
    }
    s = submitTasks(s, s.projects[0], ["t1", "t2", "t3"], T, () => "unused");
    return addEarning(s, s.projects[0], {
      cents: 6_000, kind: EARNING.BONUS, taskIds: ["t1", "t2", "t3"],
      status: PAY.PENDING, note: "Six-task bonus",
    }, T, "bonus");
  };
  const answer = (s, ids, verdict, at) => answerTasks(s, s.projects[0], ids, verdict, at);
  const rewardRow = (list) => list.find((row) => row.tasks.some((line) => line.kind === "reward"));

  it("is paid with the last of its tasks to be accepted", () => {
    // t1 beat Monday's cutoff and is paid on the 7th; t2 and t3 came back on
    // the Tuesday, after it, so they and the bonus are paid on the 14th.
    let s = answer(ledger(), ["t1"], TASK.ACCEPTED, on(2026, 10, 4, 10));
    s = answer(s, ["t2", "t3"], TASK.ACCEPTED, on(2026, 10, 6, 10));
    const { due, waiting } = upcomingPay(s, on(2026, 10, 6, 12));
    expect(waiting).toEqual([]);
    expect(due.map((row) => row.date)).toEqual(["2026-10-07", "2026-10-14"]);
    expect(rewardRow(due).date).toBe("2026-10-14");
    expect(rewardRow(due)).toMatchObject({ items: 2, rewards: 1, cents: 2 * 8_000 + 6_000 });
    const line = rewardRow(due).tasks.find((l) => l.kind === "reward");
    expect(line).toMatchObject({ label: "Six-task bonus", covers: 3, cents: 6_000, project: "Orion" });
  });

  it("waits with a floor while any of its tasks is unanswered", () => {
    const s = answer(ledger(), ["t1", "t2"], TASK.ACCEPTED, on(2026, 10, 4, 10));
    const { due, waiting } = upcomingPay(s, on(2026, 10, 4, 12));
    expect(rewardRow(due)).toBeUndefined();
    // The same floor as t3, which is under review with it: the period now.
    expect(rewardRow(waiting).date).toBe("2026-10-07");
  });

  it("leaves a rejected task out of the reckoning", () => {
    // t3 will never be accepted, so it cannot hold the bonus back.
    let s = answer(ledger(), ["t1", "t2"], TASK.ACCEPTED, on(2026, 10, 4, 10));
    s = answer(s, ["t3"], TASK.CANCELLED, on(2026, 10, 6, 10));
    expect(rewardRow(upcomingPay(s, on(2026, 10, 6, 12)).due).date).toBe("2026-10-07");
  });

  it("has nothing to date once every one of its tasks is rejected", () => {
    const s = answer(ledger(), ["t1", "t2", "t3"], TASK.CANCELLED, on(2026, 10, 4, 10));
    expect(upcomingPay(s, on(2026, 10, 4, 12))).toEqual({ due: [], waiting: [] });
  });

  it("is dated from the last hand-in where the project pays as worked", () => {
    // Nobody's answer is waited for there: t3 went in on the Tuesday, after
    // Monday's cutoff, so the bonus is paid on the 14th though none of the
    // three has been accepted.
    let s = ledger({ ...base, paysOnAcceptance: false });
    s = setSubmittedAt(s, "p1", "t3", on(2026, 10, 6, 9));
    const { due } = upcomingPay(s, on(2026, 10, 6, 12));
    expect(rewardRow(due).date).toBe("2026-10-14");
  });

  it("never lists one that was cancelled", () => {
    let s = answer(ledger(), ["t1", "t2", "t3"], TASK.ACCEPTED, on(2026, 10, 4, 10));
    s = { ...s, earnings: s.earnings.map((e) => (e.id === "bonus" ? { ...e, status: PAY.CANCELLED } : e)) };
    const { due } = upcomingPay(s, on(2026, 10, 4, 12));
    expect(rewardRow(due)).toBeUndefined();
    expect(due[0].cents).toBe(3 * 8_000);
  });

  it("drops off once its payday has passed, like everything else", () => {
    const s = answer(ledger(), ["t1", "t2", "t3"], TASK.ACCEPTED, on(2026, 10, 4, 10));
    expect(upcomingPay(s, on(2026, 10, 8, 12))).toEqual({ due: [], waiting: [] });
  });
});
