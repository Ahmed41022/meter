import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RELEASES, isLater, newsFor } from "../src/whatsNew.js";

const r = (version, at = "2026-01-10") => ({ version, at, news: [["A", "b"]] });
const LIST = [r("1.10.0"), r("1.9.0"), r("1.8.2")];
const old = Date.UTC(2025, 0, 1);
const told = (over) => newsFor({ version: "1.10.0", seen: "", began: old, ...over }, LIST).map((x) => x.version);

describe("who is told about a release", () => {
  it("compares versions as numbers", () => {
    expect([isLater("1.10.0", "1.9.9"), isLater("1.9.0", "1.10.0"), isLater("1.9.0", "1.9.0"), isLater("2.0.0", "1.99.0")])
      .toEqual([true, false, false, true]);
  });

  it("tells the running version alone to somebody who has read none", () => {
    expect(told()).toEqual(["1.10.0"]);
  });

  it("tells everything since the last one read, and nothing twice", () => {
    expect(told({ seen: "1.8.2" })).toEqual(["1.10.0", "1.9.0"]);
    expect(told({ seen: "1.10.0" })).toEqual([]);
  });

  it("never tells of a release this build is not", () => {
    expect(told({ version: "1.9.0" })).toEqual(["1.9.0"]);
    expect(told({ version: "1.9.5", seen: "1.9.0" })).toEqual([]);
    expect(told({ version: "dev" })).toEqual([]);
  });

  it("tells nobody who started after it, and nobody with an empty ledger", () => {
    expect(told({ began: Date.UTC(2026, 0, 10, 9) })).toEqual([]);
    expect(told({ began: null })).toEqual([]);
  });
});

describe("the releases themselves", () => {
  it("are newest first, each in the changelog, each with something to say", () => {
    const log = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    RELEASES.forEach((x, i) => {
      if (i) expect(isLater(RELEASES[i - 1].version, x.version)).toBe(true);
      // Written ahead of its release, it is not in the changelog yet.
      if (!isLater(x.version, version)) expect(log).toContain(`## [${x.version}] — ${x.at}`);
      expect(x.news.length).toBeGreaterThan(0);
      expect(x.news.every(([title, text]) => title && text)).toBe(true);
    });
  });
});
