/**
 * Telling builds apart, and the note an update reload leaves for the page that
 * comes up after it.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  RELOADED_KEY, buildIn, cameFromUpdate, isNewer, markUpdateReload, stampOf,
} from "../src/ui/app/autoUpdate.js";
import { buildOf } from "../src/sync/changes.js";

describe("build stamps", () => {
  it("reads the stamp out of a page", () => {
    expect(buildIn('<head><meta name="meter-build" content="1795353000000"></head>')).toBe(1_795_353_000_000);
    expect(buildIn("<head></head>")).toBeNull();
    expect(buildIn(null)).toBeNull();
  });

  it("calls a build newer only when both stamps are real and it is later", () => {
    expect(isNewer(2_000, 1_000)).toBe(true);
    expect(isNewer(1_000, 1_000)).toBe(false);
    expect(isNewer(500, 1_000)).toBe(false);
    expect(isNewer(null, 1_000)).toBe(false);
    expect(isNewer("2000", 1_000)).toBe(false);
    // A page that does not know its own build never chases another.
    expect(isNewer(2_000, 0)).toBe(false);
    expect(stampOf(-1)).toBeNull();
  });

  it("reads a batch's build, and nothing from one written before builds were sent", () => {
    expect(buildOf({ v: 1, changes: [], meta: { build: 5 } })).toBe(5);
    expect(buildOf({ v: 1, changes: [], meta: {} })).toBeNull();
    expect(buildOf({ v: 1, changes: [], meta: { build: "5" } })).toBeNull();
  });
});

describe("the reload into an update", () => {
  beforeEach(() => sessionStorage.clear());

  it("is recognised once, by the page that comes up just after it", () => {
    markUpdateReload(10_000);
    expect(cameFromUpdate(12_000)).toBe(true);
    expect(cameFromUpdate(12_000)).toBe(false);
  });

  it("is not claimed by a page that opens long after", () => {
    markUpdateReload(10_000);
    expect(cameFromUpdate(10_000 + 120_000)).toBe(false);
    expect(sessionStorage.getItem(RELOADED_KEY)).toBeNull();
  });
});
