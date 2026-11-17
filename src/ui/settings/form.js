import { PERIOD } from "../../domain/payPeriod.js";
import { companyOf } from "../../domain/projects.js";
import { bonusPerHour, perTask, rewardModel } from "../../domain/earnings.js";
import { currentLimit } from "../../domain/terms.js";

/**
 * The panel's form: how a project and its company's schedule become the strings
 * the inputs hold, and how they are read back. Kept apart from the component so
 * the drafts and the panel itself share one definition of "what the form is".
 */
/**
 * What the form holds, in the shape the inputs want — strings, because that is
 * what was typed. Kept beside what was last saved so the panel can say whether
 * there is anything to save, without having to guess how the ledger normalised
 * the last answer.
 */
/** A minute of the day as `<input type="time">` wants it, and back. */
const timeText = (minutes) => `${String(Math.floor((minutes ?? 0) / 60)).padStart(2, "0")}`
  + `:${String((minutes ?? 0) % 60).padStart(2, "0")}`;
const minutesOf = (text) => {
  const [h, m] = String(text ?? "").split(":");
  const n = Number(h) * 60 + Number(m);
  return Number.isFinite(n) ? n : 0;
};

/** A schedule in the shape the selects want, with both kinds' answers kept
 *  side by side so switching between them to compare loses neither. */
export const periodForm = (rule) => ({
  kind: rule?.kind ?? "none",
  weeklyCutoff: rule?.kind === PERIOD.WEEKLY ? rule.cutoff : 1,
  weeklyPayday: rule?.kind === PERIOD.WEEKLY ? rule.payday : 3,
  monthlyCutoff: rule?.kind === PERIOD.MONTHLY ? String(rule.cutoff) : "1",
  monthlyPayday: rule?.kind === PERIOD.MONTHLY ? String(rule.payday) : "15",
  after: rule?.after ?? 0,
  // Shared by both kinds: when in the day the period closes, and on whose
  // clock. Empty means this device's, which is what an unset rule has always
  // meant.
  closesAt: timeText(rule?.closesAt ?? 0),
  zone: rule?.zone ?? "",
});

/** The selects back into a rule the domain will accept, or null for none. */
export const periodOf = (f) => {
  const when = { closesAt: minutesOf(f.closesAt), zone: f.zone || null };
  if (f.kind === PERIOD.WEEKLY) {
    return {
      kind: PERIOD.WEEKLY, cutoff: f.weeklyCutoff, payday: f.weeklyPayday,
      after: f.after, ...when,
    };
  }
  if (f.kind === PERIOD.MONTHLY) {
    return {
      kind: PERIOD.MONTHLY,
      cutoff: Number(f.monthlyCutoff),
      payday: Number(f.monthlyPayday),
      after: f.after,
      ...when,
    };
  }
  return null;
};

export const HOUR = 3_600_000;

/** A project's time limit in the shape its boxes want: hours, and a percentage. */
const limitForm = (project) => {
  const limit = currentLimit(project);
  return limit
    ? { limit: String(+(limit.ms / HOUR).toFixed(4)), over: String(+(limit.factor * 100).toFixed(2)) }
    : { limit: "", over: "" };
};

export const formOf = (project, payPeriod) => ({
  name: project.name,
  company: companyOf(project) ?? "",
  period: periodForm(payPeriod),
  rate: String(project.currentRate),
  ...limitForm(project),
  /**
   * Which reward system acceptance pays under, with the amount for each kind
   * kept side by side. Two boxes rather than one, so flipping between them to
   * compare does not throw away the figure already typed into the other.
   */
  reward: rewardModel(project) ?? "none",
  each: perTask(project) === null ? "" : String(perTask(project)),
  perHour: bonusPerHour(project) === null ? "" : String(bonusPerHour(project)),
  sessionGoal: project.sessionGoal || { type: "money", target: "" },
  overallGoal: project.overallGoal || { type: "money", target: "", period: "week" },
});
