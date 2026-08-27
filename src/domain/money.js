/**
 * Money is summed as integer minor units (cents/piastres). Floats are used
 * only for display. Accumulating float money drifts; deriving it once from
 * elapsed time does not.
 */

const MS_PER_HOUR = 3_600_000;

/** Earnings for a session in minor units. Rounded once, at the boundary. */
export const earningsCents = (session, elapsedMs) =>
  Math.round((elapsedMs / MS_PER_HOUR) * session.rate * 100);

export const sumCents = (sessions, elapsedFor) =>
  sessions.reduce((total, s) => total + earningsCents(s, elapsedFor(s)), 0);

const formatters = new Map();
const formatter = (currency) => {
  if (!formatters.has(currency)) {
    formatters.set(currency, new Intl.NumberFormat(undefined, {
      style: "currency", currency, minimumFractionDigits: 2,
    }));
  }
  return formatters.get(currency);
};

export const formatMoney = (cents, currency) => {
  try {
    return formatter(currency).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
};

/** Split major from minor units so the meter face can render the fraction
 *  smaller. Uses Intl parts rather than splitting on ".", which breaks in
 *  locales that use a comma as the decimal separator. */
export const moneyParts = (cents, currency) => {
  try {
    const parts = formatter(currency).formatToParts(cents / 100);
    const i = parts.findIndex((p) => p.type === "decimal");
    if (i === -1) return { head: formatMoney(cents, currency), tail: null };
    return {
      head: parts.slice(0, i).map((p) => p.value).join(""),
      tail: parts.slice(i + 1).map((p) => p.value).join(""),
    };
  } catch {
    return {
      head: String(Math.trunc(cents / 100)),
      tail: String(Math.abs(cents % 100)).padStart(2, "0"),
    };
  }
};

const pad = (n) => String(n).padStart(2, "0");

export const formatDuration = (ms) => {
  const t = Math.floor(ms / 1000);
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
};

export const formatShortDuration = (ms) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
};
