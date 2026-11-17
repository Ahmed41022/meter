/**
 * The words and dates the Overview prints: what each period is called, what
 * its comparison is measured against, and how a window is named and dated.
 * Kept apart from the components so the headline, the controls and the rhythm
 * panel all say the same thing.
 */
// "All" rather than "All time" in the control: five tabs have to fit a phone,
// and the heading directly under it says "All time" in full.
export const NAMES = { day: "Day", week: "Week", month: "Month", year: "Year", all: "All" };
// What each comparison figure is measured against, in the words beside it.
// The period still going is set against the same point in the one before it,
// and one that is over against the whole one before it — see
// `comparisonRanges`. All time has neither, and draws no comparison at all.
export const SO_FAR = {
  day: "this time yesterday", week: "this point last week",
  month: "this point last month", year: "this point last year",
};
export const BEFORE = {
  day: "the day before", week: "the week before", month: "the month before", year: "the year before",
};

export const day = (t, opts) => new Date(t).toLocaleDateString(undefined, opts);

/** Monday first, named by the reader's own locale rather than hardcoded. Built
 *  from a known Monday so the list cannot drift with the current date. */
export const DAY_NAMES = Array.from({ length: 7 }, (_, i) =>
  new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: "long" }));

/**
 * What the reader is looking at, in words. Relative names for the periods
 * people actually name — "today", "last week" — and dates beyond that, because
 * "3 periods ago" is not how anyone thinks about their own week.
 */
export const periodLabel = (period, offset, from, to) => {
  if (period === "all") return "All time";
  if (offset === 0) {
    return { day: "Today", week: "This week", month: "This month", year: "This year" }[period];
  }
  if (offset === -1) {
    return { day: "Yesterday", week: "Last week", month: "Last month", year: "Last year" }[period];
  }
  if (period === "day") return day(from, { weekday: "long", day: "numeric", month: "long" });
  if (period === "month") return day(from, { month: "long", year: "numeric" });
  if (period === "year") return String(new Date(from).getFullYear());
  return `${day(from, { day: "numeric", month: "short" })} – ${day(to - 1, { day: "numeric", month: "short" })}`;
};

/** The exact window, always shown under the name — a reader should never have
 *  to guess where a week was cut. */
export const rangeNote = (period, from, to) => {
  if (period === "day") {
    return day(from, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }
  if (period === "year") return `Jan – Dec ${new Date(from).getFullYear()}`;
  // Months, not days: the span of a whole working history reads as "Jun 2024 –
  // Sep 2026", and a reader who sees no years cannot tell what they are looking
  // at. Collapsed when it begins and ends in the same month.
  if (period === "all") {
    const opts = { month: "short", year: "numeric" };
    const first = day(from, opts);
    const last = day(to - 1, opts);
    return first === last ? first : `${first} – ${last}`;
  }
  return `${day(from, { day: "numeric", month: "short" })} – ${day(to - 1, { day: "numeric", month: "short", year: "numeric" })}`;
};
