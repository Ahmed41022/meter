import { describe, it, expect } from "vitest";
import {
  BY_COMPANY_ORDERS, BY_PROJECT_ORDERS, CARD_ORDERS, EARNINGS_ORDERS, LIFE_ORDERS,
  biggestFigure, currenciesOf, groupOrder, keysOf, opensDescending, orderByMoney,
  orderByName, orderByNumber, orderCompanyRows, orderProjectRows,
} from "../src/domain/order.js";

const row = (id, figures) => ({ id, figures });
const figuresOf = (r) => r.figures;
const ids = (rows) => rows.map((r) => r.id);

describe("biggestFigure", () => {
  it("is the biggest single-currency figure with its currency", () => {
    expect(biggestFigure({ EGP: 500_000, USD: 20_000 })).toEqual({ currency: "EGP", cents: 500_000 });
    expect(biggestFigure({ USD: 20_000 })).toEqual({ currency: "USD", cents: 20_000 });
  });

  it("is null for no money: nothing, empty, zero or not a number", () => {
    expect(biggestFigure(undefined)).toBeNull();
    expect(biggestFigure({})).toBeNull();
    expect(biggestFigure({ USD: 0 })).toBeNull();
    expect(biggestFigure({ USD: NaN, EGP: undefined })).toBeNull();
  });

  it("breaks a tie by currency code, whatever the key order", () => {
    expect(biggestFigure({ USD: 5, EGP: 5 }).currency).toBe("EGP");
    expect(biggestFigure({ EGP: 5, USD: 5 }).currency).toBe("EGP");
  });
});

describe("groupOrder", () => {
  it("puts the currency with most hours first", () => {
    expect(groupOrder(["EGP", "USD"], { EGP: 1_000, USD: 9_000 })).toEqual(["USD", "EGP"]);
  });

  it("follows currencies nothing was timed in, by code", () => {
    expect(groupOrder(["SAR", "EUR", "USD"], { USD: 1 })).toEqual(["USD", "EUR", "SAR"]);
  });

  it("is plain code order with no hours at all, and lists each currency once", () => {
    expect(groupOrder(["USD", "EGP", "USD"])).toEqual(["EGP", "USD"]);
  });
});

describe("currenciesOf", () => {
  it("lists the currencies that hold money, ignoring zeros", () => {
    const rows = [row("a", { EGP: 1, USD: 0 }), row("b", { EUR: 2 })];
    expect(currenciesOf(rows, figuresOf)).toEqual(["EGP", "EUR"]);
  });
});

describe("orderByMoney, one currency", () => {
  const rows = [row("a", { USD: 100 }), row("b", { USD: 300 }), row("c", { USD: 200 })];

  it("puts the biggest first", () => {
    expect(ids(orderByMoney(rows, figuresOf))).toEqual(["b", "c", "a"]);
  });

  it("turns round for ascending", () => {
    expect(ids(orderByMoney(rows, figuresOf, { desc: false }))).toEqual(["a", "c", "b"]);
  });

  it("keeps the input order for ties, both ways", () => {
    const tied = [row("x", { USD: 5 }), row("y", { USD: 5 }), row("z", { USD: 5 })];
    expect(ids(orderByMoney(tied, figuresOf))).toEqual(["x", "y", "z"]);
    expect(ids(orderByMoney(tied, figuresOf, { desc: false }))).toEqual(["x", "y", "z"]);
  });

  it("does not change the array it was given", () => {
    const copy = [...rows];
    orderByMoney(rows, figuresOf);
    expect(rows).toEqual(copy);
  });
});

describe("orderByMoney, rows with no money", () => {
  const rows = [
    row("none", {}), row("a", { USD: 100 }), row("zero", { USD: 0 }),
    row("b", { USD: 300 }), row("missing", undefined),
  ];

  it("sink to the bottom, descending, in their input order", () => {
    expect(ids(orderByMoney(rows, figuresOf))).toEqual(["b", "a", "none", "zero", "missing"]);
  });

  it("sink to the bottom just the same ascending", () => {
    expect(ids(orderByMoney(rows, figuresOf, { desc: false })))
      .toEqual(["a", "b", "none", "zero", "missing"]);
  });
});

describe("orderByMoney, mixed currencies", () => {
  const rows = [
    row("egp-small", { EGP: 100_000 }),
    row("usd-big", { USD: 90_000 }),
    row("egp-big", { EGP: 500_000 }),
    row("usd-small", { USD: 20_000 }),
  ];

  it("groups by currency, biggest first inside each, groups in the order given", () => {
    expect(ids(orderByMoney(rows, figuresOf, { groups: ["EGP", "USD"] })))
      .toEqual(["egp-big", "egp-small", "usd-big", "usd-small"]);
    expect(ids(orderByMoney(rows, figuresOf, { groups: ["USD", "EGP"] })))
      .toEqual(["usd-big", "usd-small", "egp-big", "egp-small"]);
  });

  it("never lets one currency's amount outrank another's, whichever is bigger as a bare number", () => {
    // 5,000 EGP against 200 USD, then the sizes reversed: the groups must not
    // interleave either way, and only the group order decides who is first.
    const a = [row("usd", { USD: 20_000 }), row("egp", { EGP: 500_000 })];
    const b = [row("usd", { USD: 2_000_000 }), row("egp", { EGP: 5_000 })];
    expect(ids(orderByMoney(a, figuresOf, { groups: ["EGP", "USD"] }))).toEqual(["egp", "usd"]);
    expect(ids(orderByMoney(b, figuresOf, { groups: ["EGP", "USD"] }))).toEqual(["egp", "usd"]);
    expect(ids(orderByMoney(b, figuresOf, { groups: ["USD", "EGP"] }))).toEqual(["usd", "egp"]);
  });

  it("keeps the groups where they are when the direction turns, flipping only inside them", () => {
    expect(ids(orderByMoney(rows, figuresOf, { desc: false, groups: ["EGP", "USD"] })))
      .toEqual(["egp-small", "egp-big", "usd-small", "usd-big"]);
  });

  it("puts a currency missing from the groups after the listed ones, by code", () => {
    const more = [...rows, row("sar", { SAR: 1 }), row("aed", { AED: 9 })];
    expect(ids(orderByMoney(more, figuresOf, { groups: ["USD"] })))
      .toEqual(["usd-big", "usd-small", "aed", "egp-big", "egp-small", "sar"]);
  });

  it("with no groups at all falls back to currency code", () => {
    expect(ids(orderByMoney(rows, figuresOf)))
      .toEqual(["egp-big", "egp-small", "usd-big", "usd-small"]);
  });

  it("places a multi-currency row by its biggest single figure, never by a sum", () => {
    const multi = [
      row("company", { EGP: 400_000, USD: 900_000 }), // its biggest is the USD one
      row("egp-only", { EGP: 450_000 }),
      row("usd-only", { USD: 100_000 }),
    ];
    expect(ids(orderByMoney(multi, figuresOf, { groups: ["EGP", "USD"] })))
      .toEqual(["egp-only", "company", "usd-only"]);
  });

  it("works for groups made from hours, end to end", () => {
    const list = [row("e", { EGP: 1 }), row("u", { USD: 1 })];
    const groups = groupOrder(currenciesOf(list, figuresOf), { USD: 7_200_000, EGP: 3_600_000 });
    expect(ids(orderByMoney(list, figuresOf, { groups }))).toEqual(["u", "e"]);
  });
});

describe("orderByNumber", () => {
  const rows = [{ id: "a", n: 2 }, { id: "b", n: null }, { id: "c", n: 9 }, { id: "d" }, { id: "e", n: 0 }];
  const n = (r) => r.n;

  it("sorts descending with the absent ones last", () => {
    expect(ids(orderByNumber(rows, n))).toEqual(["c", "a", "e", "b", "d"]);
  });

  it("sorts ascending with the absent ones still last", () => {
    expect(ids(orderByNumber(rows, n, false))).toEqual(["e", "a", "c", "b", "d"]);
  });

  it("treats NaN and Infinity as absent", () => {
    const odd = [{ id: "x", n: NaN }, { id: "y", n: 1 }, { id: "z", n: Infinity }];
    expect(ids(orderByNumber(odd, n))).toEqual(["y", "x", "z"]);
  });

  it("keeps the input order for ties", () => {
    const tied = [{ id: "1", n: 5 }, { id: "2", n: 5 }, { id: "3", n: 5 }];
    expect(ids(orderByNumber(tied, n))).toEqual(["1", "2", "3"]);
    expect(ids(orderByNumber(tied, n, false))).toEqual(["1", "2", "3"]);
  });
});

describe("orderByName", () => {
  const rows = [{ id: "1", name: "beta" }, { id: "2", name: "Alpha" }, { id: "3", name: "Task 10" },
    { id: "4", name: "Task 2" }];

  it("reads A to Z ignoring case, and digits as numbers", () => {
    expect(ids(orderByName(rows, (r) => r.name))).toEqual(["2", "1", "4", "3"]);
  });

  it("reverses for Z to A", () => {
    expect(ids(orderByName(rows, (r) => r.name, true))).toEqual(["3", "4", "1", "2"]);
  });

  it("copes with a missing name", () => {
    expect(ids(orderByName([{ id: "x" }, { id: "y", name: "A" }], (r) => r.name))).toEqual(["x", "y"]);
  });
});

describe("the order sets", () => {
  it("offers Earned on Work and not on Life", () => {
    expect(keysOf(CARD_ORDERS)).toEqual(["added", "earned", "recent", "name", "time"]);
    expect(keysOf(LIFE_ORDERS)).toEqual(["added", "recent", "name", "time"]);
  });

  it("keeps the Overview's existing keys, with Earned added", () => {
    expect(keysOf(BY_PROJECT_ORDERS)).toEqual(["time", "rate", "earned"]);
    expect(keysOf(BY_COMPANY_ORDERS)).toEqual(["time", "rate", "earned"]);
    expect(keysOf(EARNINGS_ORDERS)).toEqual(["newest", "amount"]);
  });

  it("opens names A to Z and everything else biggest or latest first", () => {
    expect(opensDescending("name")).toBe(false);
    expect(["added", "earned", "recent", "time", "rate", "newest", "amount"].every(opensDescending))
      .toBe(true);
  });
});

describe("orderProjectRows", () => {
  const p = (id, billedCents, billedMsByCurrency = {}) => ({ id, billedCents, billedMsByCurrency });

  it("leaves the arriving order for time", () => {
    const rows = [p("a", { USD: 1 }), p("b", { USD: 9 })];
    expect(orderProjectRows(rows, "time")).toBe(rows);
  });

  it("ranks earned by currency, most hours first, never across currencies", () => {
    const rows = [
      p("usd-big", { USD: 9_000_000 }, { USD: 1 }), p("none", {}),
      p("egp", { EGP: 100 }, { EGP: 5 }), p("usd-small", { USD: 5 }, { USD: 1 }),
    ];
    expect(orderProjectRows(rows, "earned").map((r) => r.id))
      .toEqual(["egp", "usd-big", "usd-small", "none"]);
  });
});

describe("orderCompanyRows", () => {
  const c = (company, billedCents, billedMs, extra = {}) =>
    ({ company, billedCents, billedMs, billedMsByCurrency: {}, rateCents: null, currency: null, ...extra });

  it("keeps the unassigned row last whatever the order", () => {
    const rows = [
      c("A", { USD: 1 }, 1, { currency: "USD", rateCents: 5 }), c(null, { USD: 999 }, 999,
        { currency: "USD", rateCents: 999 }),
    ];
    for (const key of ["time", "rate", "earned"]) {
      expect(orderCompanyRows(rows, key).map((r) => r.company)).toEqual(["A", null]);
    }
  });

  it("earned with one currency keeps the arriving order, which is money then time", () => {
    const rows = [c("X", { USD: 300 }, 5), c("Y", { USD: 200 }, 9), c("Z", { USD: 200 }, 2), c("W", {}, 1)];
    expect(orderCompanyRows(rows, "earned").map((r) => r.company)).toEqual(["X", "Y", "Z", "W"]);
  });

  it("does not let money at or below zero rank", () => {
    const rows = [c("Neg", { USD: -50 }, 9), c("Pos", { USD: 10 }, 1)];
    expect(orderCompanyRows(rows, "earned").map((r) => r.company)).toEqual(["Pos", "Neg"]);
  });

  it("ranks the hourly rate inside one currency and sinks rows with no rate", () => {
    const rows = [
      c("Multi", { USD: 1, EGP: 1 }, 5), c("Usd", { USD: 1 }, 1, { currency: "USD", rateCents: 20 }),
      c("Egp", { EGP: 1 }, 1, { currency: "EGP", rateCents: 9_000, billedMsByCurrency: { EGP: 9 } }),
    ];
    expect(orderCompanyRows(rows, "rate").map((r) => r.company)).toEqual(["Egp", "Usd", "Multi"]);
  });

  it("time sinks a row with no billed time", () => {
    const rows = [c("None", { USD: 5 }, 0), c("Some", {}, 3)];
    expect(orderCompanyRows(rows, "time").map((r) => r.company)).toEqual(["Some", "None"]);
  });
});
