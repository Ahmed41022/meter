import { describe, expect, it } from "vitest";
import { zoneOffset } from "../src/domain/payPeriod.js";

/** The zone's own clock, asked directly every time: what the kept offsets must
 *  always agree with. */
const formats = new Map();
const asked = (t, zone) => {
  if (!formats.has(zone)) {
    formats.set(zone, new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }));
  }
  const w = {};
  for (const p of formats.get(zone).formatToParts(t)) if (p.type !== "literal") w[p.type] = Number(p.value);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(t / 1000) * 1000;
};

const ZONES = [
  "UTC", "Africa/Cairo", "America/New_York", "America/Los_Angeles", "America/St_Johns", "Europe/London",
  "Asia/Kolkata", "Asia/Kathmandu", "Australia/Lord_Howe", "Pacific/Auckland", "Pacific/Apia",
  "Africa/Casablanca", "America/Sao_Paulo", "Asia/Tehran",
];
const MIN = 60_000;

describe("the kept zone offsets", () => {
  it.each(ZONES)("%s agrees with the zone's own clock, changes of the clock included", (zone) => {
    const wrong = [];
    // Every 97 minutes over two years: an odd step, so it lands all over the day.
    for (let t = Date.UTC(2022, 11, 25); t < Date.UTC(2025, 0, 5); t += 97 * MIN) {
      if (zoneOffset(t, zone) !== asked(t, zone)) wrong.push(new Date(t).toISOString());
    }
    expect(wrong).toEqual([]);
  });

  it.each([
    ["Egypt springing forward at midnight", "Africa/Cairo", Date.UTC(2023, 3, 27, 22)],
    ["New York springing forward", "America/New_York", Date.UTC(2024, 2, 10, 7)],
    ["New York falling back", "America/New_York", Date.UTC(2024, 10, 3, 6)],
    ["St John's, which changed at a minute past midnight", "America/St_Johns", Date.UTC(2010, 2, 14, 3, 31)],
    ["Lord Howe, by half an hour", "Australia/Lord_Howe", Date.UTC(2024, 9, 5, 15, 30)],
    ["Samoa, which skipped a whole day", "Pacific/Apia", Date.UTC(2011, 11, 30, 10)],
  ])("is exact to the second around %s", (_, zone, change) => {
    for (const off of [-3_600_000, -MIN, -1000, -1, 0, 1, 1000, MIN, 3_600_000]) {
      expect(zoneOffset(change + off, zone)).toBe(asked(change + off, zone));
    }
    expect(zoneOffset(change - 1, zone)).not.toBe(zoneOffset(change, zone));
  });
});
