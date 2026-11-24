/** How a goal is spoken of, in one place, for Today, the Overview and the notice. */
export const PERIOD_WORD = { day: "today", week: "this week", month: "this month" };
export const EVERY_WORD = { day: "Daily", week: "Weekly", month: "Monthly" };
export const A_WORD = { day: "a day", week: "a week", month: "a month" };
const MANY = { day: "days", week: "weeks", month: "months" };

/** "Met 4 of the last 5 weeks", or nothing before there is one to speak of. */
export const resultWords = (results, period) => {
  if (results.length === 0) return "";
  const met = results.filter((r) => r.met).length;
  const one = { day: "day", week: "week", month: "month" }[period];
  return results.length === 1
    ? `${met ? "Met" : "Missed"} the ${one} before`
    : `Met ${met} of the last ${results.length} ${MANY[period]}`;
};
