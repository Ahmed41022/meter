/**
 * The clocks a cutoff can be offered on, and this device's own. Split from the
 * form because it is browser lookup, not settings logic, and the payday boxes
 * are its only reader.
 */
/**
 * The clocks a cutoff can be read on.
 *
 * The device's own comes first, because that is what a rule with no zone
 * means and what most people want. Then the handful the platforms actually
 * quote their cutoffs in, then everything the browser knows — four hundred
 * entries nobody scrolls through, but the one zone somebody needs is always
 * among them, and a select types ahead.
 */
export const QUOTED_ZONES = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "UTC", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Singapore",
  "Australia/Sydney",
];
const localZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
};
const allZones = () => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return QUOTED_ZONES;
  }
};
export const ZONES = allZones();
export const HERE = localZone();
