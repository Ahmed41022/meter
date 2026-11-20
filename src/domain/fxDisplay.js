/**
 * What a total should print, given the owner's display currency and the rates.
 *
 * The decision lives here, away from the screens, so every total makes it the
 * same way: convert only when the owner chose a currency AND there are usable
 * rates AND every currency in the figures has one. In every other case the
 * figures stay as earned, each in its own currency, never added.
 *
 * Pure like the rest of domain/: the rates and the choice come in as
 * arguments. Nothing stored is changed; this only decides what to show.
 */
import { convertFigures, hasCurrency } from "./fx.js";

/**
 * Whether `figures` can be shown in one currency, and if not, why.
 *
 * `why` is "off" (live rates are switched off), "none" (on, but no rates have
 * arrived), or "missing" (rates exist but lack a currency, listed in `codes`:
 * the target when it is not in the feed, otherwise the figures' own). Zero
 * figures need no rate and are ignored, as in `convertFigures`.
 */
export const conversion = (figures, { choice, fxOn, rates }) => {
  if (!fxOn) return { ok: false, why: "off", codes: [] };
  if (!rates) return { ok: false, why: "none", codes: [] };
  if (choice === "earned") return { ok: true, why: null, codes: [] };
  const codes = [];
  if (!hasCurrency(rates, choice)) codes.push(choice);
  for (const [code, cents] of Object.entries(figures ?? {})) {
    if (cents && code !== choice && !hasCurrency(rates, code)) codes.push(code);
  }
  return codes.length
    ? { ok: false, why: "missing", codes: [...new Set(codes)].sort() }
    : { ok: true, why: null, codes: [] };
};

/**
 * The way to rank rows by ONE converted figure, or null when they cannot be.
 *
 * `figuresOf(row)` is a row's `{ CUR: cents }`. Returns a replacement for it
 * that gives `{ [choice]: convertedCents }`, which `orderByMoney` then ranks as
 * a single group. It is all or nothing: if the display currency is "earned",
 * rates are off or absent, or ANY row holds a currency without a rate, the
 * answer is null and the list keeps its own grouping by currency. Converted
 * and unconverted rows are never ranked against each other, because that would
 * put a figure that is an estimate beside one that is not.
 */
export const convertedFigures = (rows, figuresOf, settings) => {
  if (!settings || settings.choice === "earned") return null;
  for (const row of rows) {
    if (!conversion(figuresOf(row), settings).ok) return null;
  }
  if (!conversion({}, settings).ok) return null;
  return (row) => {
    const { cents } = convertFigures(figuresOf(row), settings.choice, settings.rates);
    return cents ? { [settings.choice]: cents } : {};
  };
};

/**
 * The figures as something to print.
 *
 * `{ mode: "separate", entries }`: each currency as it was earned, in the order
 * `order` gives (a function from the figures object to `[code, cents]` pairs;
 * every total keeps the order it has always used). This is also the answer for
 * a choice of "earned", for no usable rates, and for no figures at all.
 *
 * `{ mode: "converted", cents, cur, approx, date }`: one figure in the chosen
 * currency. `approx` is true when anything was actually converted, which is
 * when the screen must mark it "≈" and name the rate `date`.
 *
 * `conv` always says whether converting was possible and why not, for the
 * switcher's note, whichever mode came out.
 */
export const displayMoney = (figures, settings, order = Object.entries) => {
  const conv = conversion(figures, settings);
  const entries = order(figures ?? {});
  if (settings.choice === "earned" || !conv.ok || entries.length === 0) {
    return { mode: "separate", entries, conv };
  }
  const { cents, converted } = convertFigures(figures, settings.choice, settings.rates);
  if (cents === null) return { mode: "separate", entries, conv };
  return {
    mode: "converted", cents, cur: settings.choice, approx: converted,
    date: settings.rates.date, conv,
  };
};
