/**
 * How a project page prints a clock time and a day. Shared by the headline
 * meter, the closing summary and the ledger, which would otherwise each keep a
 * copy that could drift apart.
 */
export const time = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
export const date = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
