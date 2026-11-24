/**
 * Goals for work on Today, and the message about a new release. Drives the
 * built artifact.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { RELEASES } from "../src/whatsNew.js";
import { boot, btn, guardBuiltApp, setValue, settle, toProjects, until } from "./app.integration.helpers.js";

guardBuiltApp();

const H = 3_600_000;
const DAY = 24 * H;
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
/** Work in the first minutes of today, so it is today's whatever the hour. */
const seed = (extra = {}) => {
  const M = 60_000;
  const day = new Date().setHours(0, 0, 0, 0);
  const p = (id, name, rate, x = {}) => ({
    id, name, currentRate: rate, currency: "USD", createdAt: 1, sessionGoal: null, overallGoal: null, ...x,
  });
  const s = (id, projectId, rate, x = {}) => ({
    id, projectId, taskId: null, kind: "billed", rate, currency: "USD", createdAt: day,
    segments: [{ startedAt: day, endedAt: day + M }], closedAt: day + M, deletedAt: null, ...x,
  });
  return {
    projects: [p("a", "Alpha", 60, { company: "Alignerr" }), p("b", "Beta", 120), p("l", "Garden", 0, { offClock: true })],
    sessions: [s("1", "a", 60), s("2", "b", 120, { status: "pending" }), s("3", "a", 60, { kind: "idle" }), s("4", "l", 0)],
    ...extra,
  };
};
const goal = (id, extra = {}) => ({
  id, type: "time", period: "day", scope: { kind: "all" }, terms: [{ from: Date.now() - 40 * DAY, target: 60, days: [1, 2, 3, 4, 5, 6, 7] }],
  order: 0, pauses: [], createdAt: 1, deletedAt: null, ...extra,
});
const stored = (dom) => JSON.parse(dom.window.localStorage.getItem("meter:v1"));
const section = (d) => [...d.querySelectorAll(".sec")].find((x) => x.querySelector(".sec-head")?.textContent.startsWith("Goals"));
const press = async (d, re, root = section(d)) => {
  [...root.querySelectorAll("button")].find((b) => re.test(b.textContent.trim())).click();
  await settle();
};
const field = (d, label) => [...section(d).querySelectorAll("label.field")]
  .find((l) => l.querySelector(".eyebrow").textContent.startsWith(label)).querySelector("input, select");
const rows = (d) => [...section(d).querySelectorAll(".wgoal")];

describe("setting goals", () => {
  it("sets a daily, a weekly and a monthly one, over all work, a company and a project", async () => {
    const dom = await boot(seed());
    const d = dom.window.document;
    const set = async (period, target, covers, money = false) => {
      await press(d, /Set goal$/);
      await press(d, new RegExp(`^${period}$`));
      if (money) await press(d, /^Money earned$/);
      setValue(dom.window, field(d, money ? "Amount" : "Hours"), target);
      setValue(dom.window, field(d, "Covers"), covers);
      await settle();
      await press(d, /^Set goal$/);
    };
    await set("Daily", "0,1", "all");
    await set("Weekly", "10", "c:Alignerr");
    await set("Monthly", "5", "p:b", true);
    expect(stored(dom).goals.map((g) => [g.period, g.type, g.scope.kind, g.terms[0].target, g.currency ?? null])).toEqual([
      ["day", "time", "all", 6, null], ["week", "time", "company", 600, null], ["month", "money", "project", 5, "USD"],
    ]);
    const text = rows(d).map((r) => r.textContent);
    // Two minutes of work, one of them Alignerr's; $2.00 waiting on an answer. Idle and life count for nothing.
    expect(text[0]).toMatch(/All worktoday2m \/ 6m/);
    expect(text[0]).toMatch(/4m to go/);
    expect(text[1]).toMatch(/Alignerrthis week1m \/ 10h 00m/);
    expect(text[1]).toMatch(/needs .*\/day/);
    expect(text[2]).toMatch(/Betathis month\$2\.00 \/ \$5\.00/);
  }, 40_000);

  it("refuses a target it cannot read, and no working day at all", async () => {
    const dom = await boot(seed());
    const d = dom.window.document;
    await press(d, /Set goal$/);
    const save = () => [...section(d).querySelectorAll(".btn.primary")][0];
    expect(save().disabled).toBe(true);
    setValue(dom.window, field(d, "Hours"), "lots");
    await settle();
    expect(section(d).textContent).toMatch(/A target is a number above zero/);
    setValue(dom.window, field(d, "Hours"), "6");
    await settle();
    expect(save().disabled).toBe(false);
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) await press(d, new RegExp(`^${day}$`));
    expect(section(d).textContent).toMatch(/Pick at least one day/);
    expect(save().disabled).toBe(true);
    await press(d, /^Fri$/);
    await press(d, /^Set goal$/);
    expect(stored(dom).goals[0].terms[0].days).toEqual([5]);
  }, 40_000);

  it("shows the first three, and the rest when asked", async () => {
    const dom = await boot(seed({ goals: [1, 2, 3, 4, 5].map((n) => goal(`g${n}`, { order: n })) }));
    const d = dom.window.document;
    expect(rows(d)).toHaveLength(3);
    await press(d, /^Show all 5$/);
    expect(rows(d)).toHaveLength(5);
    await press(d, /^Show fewer$/);
    expect(rows(d)).toHaveLength(3);
  }, 30_000);

  it("is edited, paused, moved and deleted, and what is undone comes back", async () => {
    const dom = await boot(seed({ goals: [goal("g1"), goal("g2", { order: 1, period: "week", scope: { kind: "company", company: "Alignerr" } })] }));
    const d = dom.window.document;
    await press(d, /^Manage$/);
    await press(d, /^Move up$/, rows(d)[1]);
    expect(rows(d)[0].textContent).toMatch(/Alignerr/);
    await press(d, /^Edit$/, rows(d)[1]);
    expect(field(d, "Hours").value).toBe("1");
    setValue(dom.window, field(d, "Hours"), "2");
    await settle();
    await press(d, /^Save goal$/);
    expect(stored(dom).goals.find((g) => g.id === "g1").terms.map((t) => t.target)).toEqual([60, 120]);

    await press(d, /^Pause$/, rows(d)[0]);
    expect(section(d).textContent).toMatch(/weekly, paused/);
    btn(d, /^Undo$/).click();
    await settle();
    expect(stored(dom).goals.find((g) => g.id === "g2").pauses).toEqual([]);

    await press(d, /^Delete$/, rows(d)[0]);
    expect(rows(d)).toHaveLength(1);
    btn(d, /^Undo$/).click();
    await settle();
    expect(rows(d)).toHaveLength(2);
  }, 40_000);

  it("says how the last periods went", async () => {
    const day = new Date().setHours(0, 0, 0, 0);
    const worked = [1, 2, 4].map((n) => {
      const from = new Date(new Date(day).setDate(new Date(day).getDate() - n)).setHours(9, 0, 0, 0);
      return {
        id: `w${n}`, projectId: "a", taskId: null, kind: "billed", rate: 60, currency: "USD", createdAt: from,
        segments: [{ startedAt: from, endedAt: from + 2 * H }], closedAt: from + 2 * H, deletedAt: null,
      };
    });
    const base = seed({ goals: [goal("g1")] });
    const dom = await boot({ ...base, sessions: [...base.sessions, ...worked] });
    expect(rows(dom.window.document)[0].textContent).toMatch(/Met 3 of the last 5 days/);
  }, 30_000);

  it("keeps the daily goal that was set before there were others", async () => {
    const dom = await boot(seed({ prefs: [{ id: "dayGoal", value: { type: "money", target: 2, currency: "USD" }, createdAt: 5, deletedAt: null }] }));
    expect(rows(dom.window.document)[0].textContent).toMatch(/All worktoday\$3\.00 \/ \$2\.00/);
    expect(rows(dom.window.document)[0].textContent).toMatch(/Met · \$1\.00 over/);
  }, 30_000);

  it("shows beside the projects' own in the Overview's Targets", async () => {
    const dom = await boot(seed({ goals: [goal("g1", { period: "week", scope: { kind: "project", projectId: "a" } })] }));
    const d = dom.window.document;
    await toProjects(d, "Overview");
    const targets = [...d.querySelectorAll(".sec")].find((x) => x.querySelector(".sec-head")?.textContent.startsWith("Targets"));
    expect(targets.textContent).toMatch(/Alphathis week/);
  }, 30_000);

  it("says once that one is met, as it is met, and nothing about one already met", async () => {
    const now = Date.now();
    const running = {
      id: "r", projectId: "a", taskId: null, kind: "billed", rate: 60, currency: "USD", createdAt: now,
      segments: [{ startedAt: now - 1_000, endedAt: null, lastTick: now }], closedAt: null, deletedAt: null,
    };
    // All work passes three seconds of it in a moment; Beta's was met long ago.
    const base = seed();
    const dom = await boot({
      ...base, sessions: [running, ...base.sessions.filter((s) => s.id === "2")],
      goals: [
        goal("g1", { scope: { kind: "project", projectId: "a" }, terms: [{ from: 0, target: 0.07, days: [1, 2, 3, 4, 5, 6, 7] }] }),
        goal("g2", { scope: { kind: "project", projectId: "b" }, terms: [{ from: 0, target: 0.5, days: [1, 2, 3, 4, 5, 6, 7] }] }),
      ],
    });
    await until(() => /Alpha.*Goal met/.test(dom.window.document.querySelector(".toast")?.textContent ?? ""),
      { what: "the notice", timeout: 12_000 });
  }, 30_000);
});

describe("what's new", () => {
  const card = (d) => d.querySelector(".whatsnew");
  const entry = RELEASES.find((r) => r.version === VERSION);

  it.runIf(entry)("is told once after an update, and can be read again from the version", async () => {
    const dom = await boot(seed());
    const d = dom.window.document;
    expect(card(d).textContent).toContain(`Meter ${VERSION}`);
    expect(card(d).textContent).toContain(entry.news[0][0]);
    await press(d, /^Got it$/, card(d));
    expect(card(d)).toBeNull();
    expect(stored(dom).prefs.find((p) => p.id === "newsSeen").value).toBe(VERSION);
    d.querySelector(".version button").click();
    await settle();
    expect(card(d)).not.toBeNull();
    await press(d, /^Got it$/, card(d));
    expect(card(d)).toBeNull();
  }, 30_000);

  it("is not told to somebody just starting", async () => {
    const dom = await boot({ projects: [], sessions: [] });
    expect(card(dom.window.document)).toBeNull();
  }, 30_000);
});
