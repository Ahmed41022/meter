import { describe, it, expect } from "vitest";
import { PREFS, SORT_PREFS, prefOf, setPref } from "../src/domain/prefs.js";
import { mergeState, stampChanges } from "../src/domain/merge.js";
import { backupState, unsavedSince } from "../src/domain/backup.js";
import { ledgerWords } from "../src/ui/words.js";

/** What App's commit does: reduce, then stamp whatever the change touched. */
const commit = (state, reduce, now) => stampChanges(state, reduce(state), now);

describe("prefOf", () => {
  it("is the default for a store with no prefs at all", () => {
    expect(prefOf({ projects: [], sessions: [] }, "overviewPeriod")).toBe("last");
    expect(prefOf(null, "overviewPeriod")).toBe("last");
  });

  it("is the default when there is no record for the key", () => {
    expect(prefOf({ prefs: [] }, "overviewPeriod")).toBe("last");
  });

  it("returns a valid stored value", () => {
    const state = { prefs: [{ id: "overviewPeriod", value: "month", deletedAt: null }] };
    expect(prefOf(state, "overviewPeriod")).toBe("month");
  });

  it("falls back to the default for a value this build does not know", () => {
    const state = { prefs: [{ id: "overviewPeriod", value: "fortnight", deletedAt: null }] };
    expect(prefOf(state, "overviewPeriod")).toBe("last");
  });

  it("falls back to the default for a tombstoned record", () => {
    const state = { prefs: [{ id: "overviewPeriod", value: "month", deletedAt: 5 }] };
    expect(prefOf(state, "overviewPeriod")).toBe("last");
  });

  it("knows nothing of a key that is not registered", () => {
    expect(prefOf({ prefs: [{ id: "nope", value: 1 }] }, "nope")).toBeUndefined();
  });
});

describe("setPref", () => {
  it("creates the record, keyed by the preference", () => {
    const out = setPref({ projects: [] }, "overviewPeriod", "week", 100);
    expect(out.prefs).toEqual([{ id: "overviewPeriod", value: "week", createdAt: 100, deletedAt: null }]);
    expect(prefOf(out, "overviewPeriod")).toBe("week");
  });

  it("refuses an unknown key", () => {
    const state = { projects: [] };
    expect(setPref(state, "nope", "x", 1)).toBe(state);
  });

  it("refuses an invalid value", () => {
    const state = { projects: [] };
    expect(setPref(state, "overviewPeriod", "fortnight", 1)).toBe(state);
    expect(setPref(state, "overviewPeriod", undefined, 1)).toBe(state);
  });

  it("returns the very same state when the value is already stored", () => {
    const state = setPref({}, "overviewPeriod", "week", 1);
    expect(setPref(state, "overviewPeriod", "week", 2)).toBe(state);
  });

  it("stamps nothing for a no-op", () => {
    const state = commit({}, (s) => setPref(s, "overviewPeriod", "week", 1), 1);
    const again = commit(state, (s) => setPref(s, "overviewPeriod", "week", 2), 2);
    expect(again).toEqual(state);
    expect(again.prefs[0].updatedAt).toBe(1);
  });

  it("keeps the id and createdAt when changing a value, and is stamped", () => {
    const first = commit({}, (s) => setPref(s, "overviewPeriod", "week", 10), 10);
    const next = commit(first, (s) => setPref(s, "overviewPeriod", "year", 20), 20);
    expect(next.prefs).toHaveLength(1);
    expect(next.prefs[0]).toMatchObject({
      id: "overviewPeriod", value: "year", createdAt: 10, updatedAt: 20, deletedAt: null,
    });
  });

  it("revives a deleted record", () => {
    const state = { prefs: [{ id: "overviewPeriod", value: "week", createdAt: 1, deletedAt: 5 }] };
    const out = setPref(state, "overviewPeriod", "week", 9);
    expect(prefOf(out, "overviewPeriod")).toBe("week");
    expect(out.prefs[0].createdAt).toBe(1);
  });
});

describe("prefs through a merge", () => {
  const base = { projects: [], sessions: [] };

  it("keeps a change to each of two different keys, whichever way round", () => {
    const phone = commit(base, (s) => setPref(s, "overviewPeriod", "month", 1), 100);
    const desk = commit(base, (s) => setPref(s, "cardsSort", "recent", 1), 200);
    for (const [a, b] of [[phone, desk], [desk, phone]]) {
      const merged = mergeState(a, b);
      expect(prefOf(merged, "overviewPeriod")).toBe("month");
      expect(prefOf(merged, "cardsSort")).toBe("recent");
    }
  });

  it("lets the later stamp win on the same key", () => {
    const phone = commit(base, (s) => setPref(s, "overviewPeriod", "month", 1), 100);
    const desk = commit(base, (s) => setPref(s, "overviewPeriod", "year", 1), 200);
    expect(prefOf(mergeState(phone, desk), "overviewPeriod")).toBe("year");
    expect(prefOf(mergeState(desk, phone), "overviewPeriod")).toBe("year");
  });

  it("merges with a ledger that has no prefs array", () => {
    const desk = commit(base, (s) => setPref(s, "overviewPeriod", "week", 1), 200);
    expect(prefOf(mergeState(base, desk), "overviewPeriod")).toBe("week");
    expect(prefOf(mergeState(desk, base), "overviewPeriod")).toBe("week");
  });
});

describe("prefs are settings, not work", () => {
  it("do not count as unsaved records or raise the backup nudge", () => {
    const state = commit(
      { sessions: [], earnings: [], lastBackupAt: 1 },
      (s) => setPref(s, "overviewPeriod", "week", 5_000), 5_000,
    );
    expect(unsavedSince(state, 1)).toBe(0);
    expect(backupState(state, 10 * 86_400_000).stale).toBe(false);
  });

  it("are left out of the words that describe a ledger", () => {
    expect(ledgerWords(setPref({}, "overviewPeriod", "week", 1))).toBe("nothing at all");
  });
});

describe("the list sort preferences", () => {
  const DEFAULTS = {
    cardsSort: "added", lifeSort: "added", byProjectSort: "time",
    byCompanySort: "earned", earningsSort: "newest", sessionsSort: "newest",
  };

  it("registers one key per list, each with the agreed default", () => {
    expect([...SORT_PREFS].sort()).toEqual(Object.keys(DEFAULTS).sort());
    for (const [key, value] of Object.entries(DEFAULTS)) {
      expect(PREFS[key].default).toBe(value);
      expect(prefOf({}, key)).toBe(value);
    }
  });

  it("accepts the options of its own list and nothing else", () => {
    expect(PREFS.cardsSort.valid("earned")).toBe(true);
    expect(PREFS.lifeSort.valid("earned")).toBe(false);
    expect(PREFS.lifeSort.valid("recent")).toBe(true);
    expect(PREFS.byCompanySort.valid("rate")).toBe(true);
    expect(PREFS.byProjectSort.valid("amount")).toBe(false);
    expect(PREFS.earningsSort.valid("amount")).toBe(true);
    expect(PREFS.sessionsSort.valid("name")).toBe(false);
    expect(PREFS.cardsSort.valid("earned-asc")).toBe(false);
    // Each key refuses what only another list offers.
    expect(PREFS.cardsSort.valid("rate")).toBe(false);
    expect(PREFS.cardsSort.valid("newest")).toBe(false);
    expect(PREFS.byCompanySort.valid("name")).toBe(false);
    expect(PREFS.earningsSort.valid("time")).toBe(false);
    expect(setPref({}, "cardsSort", "rate", 1)).toEqual({});
    expect(setPref({}, "byProjectSort", "name", 1)).toEqual({});
    expect(PREFS.cardsSort.valid(undefined)).toBe(false);
  });

  it("stores a choice and falls back to the default for one this build does not know", () => {
    const out = setPref({}, "lifeSort", "name", 5);
    expect(prefOf(out, "lifeSort")).toBe("name");
    expect(setPref({}, "lifeSort", "earned", 5)).toEqual({});
    const odd = { prefs: [{ id: "cardsSort", value: "fastest", deletedAt: null }] };
    expect(prefOf(odd, "cardsSort")).toBe("added");
  });
});

describe("the currency preferences", () => {
  it("default to rates off, USD, and USD as the only favourite", () => {
    expect(prefOf({}, "fxOn")).toBe(false);
    expect(prefOf({}, "displayCurrency")).toBe("USD");
    expect(prefOf({}, "favourites")).toEqual(["USD"]);
  });

  it("hands out a default favourites list that cannot be changed by a caller", () => {
    expect(() => prefOf({}, "favourites").push("EUR")).toThrow();
  });

  it("validates fxOn as a real boolean", () => {
    expect(PREFS.fxOn.valid(true)).toBe(true);
    expect(PREFS.fxOn.valid(false)).toBe(true);
    for (const v of ["true", 1, 0, null, undefined]) expect(PREFS.fxOn.valid(v)).toBe(false);
  });

  it("validates displayCurrency as an upper-case code or earned", () => {
    for (const v of ["USD", "EGP", "earned"]) expect(PREFS.displayCurrency.valid(v)).toBe(true);
    for (const v of ["usd", "US", "USDT", "Earned", "", null, 5, ["USD"]]) {
      expect(PREFS.displayCurrency.valid(v)).toBe(false);
    }
  });

  it("validates favourites as a non-empty list of unique upper-case codes", () => {
    expect(PREFS.favourites.valid(["USD", "EGP"])).toBe(true);
    for (const v of [[], ["USD", "USD"], ["usd"], ["USD", "EU"], ["USD", 5], "USD", null, undefined,
      { 0: "USD", length: 1 }]) {
      expect(PREFS.favourites.valid(v)).toBe(false);
    }
  });

  it("falls back to the default for a stored value that does not validate", () => {
    const state = { prefs: [
      { id: "favourites", value: ["USD", "USD"], deletedAt: null },
      { id: "displayCurrency", value: "usd", deletedAt: null },
      { id: "fxOn", value: "yes", deletedAt: null },
    ] };
    expect(prefOf(state, "favourites")).toEqual(["USD"]);
    expect(prefOf(state, "displayCurrency")).toBe("USD");
    expect(prefOf(state, "fxOn")).toBe(false);
  });

  it("refuses an invalid value", () => {
    const state = { projects: [] };
    expect(setPref(state, "favourites", [], 1)).toBe(state);
    expect(setPref(state, "favourites", ["EUR", "EUR"], 1)).toBe(state);
    expect(setPref(state, "displayCurrency", "euro", 1)).toBe(state);
    expect(setPref(state, "fxOn", "on", 1)).toBe(state);
  });

  it("stores a list and treats the same list, as a new array, as no change", () => {
    const state = setPref({}, "favourites", ["USD", "EGP"], 1);
    expect(prefOf(state, "favourites")).toEqual(["USD", "EGP"]);
    expect(setPref(state, "favourites", ["USD", "EGP"], 2)).toBe(state);
  });

  it("stamps nothing for an unchanged list, but a reordered one is a change", () => {
    const state = commit({}, (s) => setPref(s, "favourites", ["USD", "EGP"], 1), 1);
    const same = commit(state, (s) => setPref(s, "favourites", ["USD", "EGP"], 2), 2);
    expect(same).toEqual(state);
    expect(same.prefs[0].updatedAt).toBe(1);
    const moved = commit(state, (s) => setPref(s, "favourites", ["EGP", "USD"], 3), 3);
    expect(prefOf(moved, "favourites")).toEqual(["EGP", "USD"]);
    expect(moved.prefs[0].updatedAt).toBe(3);
  });

  it("keeps a change to each currency preference through a merge", () => {
    const base = { projects: [], sessions: [] };
    const phone = commit(base, (s) => setPref(s, "fxOn", true, 1), 100);
    const desk = commit(base, (s) => setPref(s, "favourites", ["EGP", "USD"], 1), 200);
    const merged = mergeState(phone, desk);
    expect(prefOf(merged, "fxOn")).toBe(true);
    expect(prefOf(merged, "favourites")).toEqual(["EGP", "USD"]);
  });
});
