/**
 * Integration tests against the BUILT artifact, not the source. These catch
 * things unit tests structurally cannot: bundling mistakes, event wiring,
 * and CSS that silently fails (an inline element ignoring margin-top, say).
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { JSDOM, DIST, wait, until, settle, appReady, boot, btn, toProjects, setValue, guardBuiltApp } from "./app.integration.helpers.js";

guardBuiltApp();

describe("fixes: data, export and layout", () => {
  const stored = (dom) => dom.window.localStorage.getItem("meter:v1");
  const keysOf = (dom) => Array.from(
    { length: dom.window.localStorage.length }, (_, i) => dom.window.localStorage.key(i));
  const bannerSaying = (d, re) => [...d.querySelectorAll(".banner")].find((b) => re.test(b.textContent));

  /** jsdom makes no blob URLs and will not read a Blob back, so a download is
   *  caught on its way in: the text handed to the Blob IS the file. */
  const grab = async (dom, click) => {
    const written = [];
    const RealBlob = dom.window.Blob;
    dom.window.Blob = function Caught(parts, opts) {
      written.push(parts.map(String).join(""));
      return new RealBlob(parts, opts);
    };
    dom.window.URL.createObjectURL = () => "blob:x";
    dom.window.URL.revokeObjectURL = () => {};
    click();
    await settle();
    dom.window.Blob = RealBlob;
    return written[0];
  };

  const addProject = async (dom, name) => {
    const d = dom.window.document;
    await toProjects(d, "Work");
    btn(d, /New project/i).click();
    await settle();
    const [nameBox, rateBox] = d.querySelectorAll(".panel input");
    setValue(dom.window, nameBox, name);
    setValue(dom.window, rateBox, "50");
    btn(d, /Add project/i).click();
    await settle();
  };

  describe("a saved ledger that cannot be read", () => {
    // Most of a real ledger, cut off part-way through its sessions.
    const CUT = JSON.stringify({
      projects: [{ id: "a", name: "Orion", currentRate: 40, currency: "USD", createdAt: 1 }],
      sessions: [{ id: "s1", projectId: "a", kind: "billed", rate: 40, currency: "USD",
                   createdAt: 1, closedAt: 2, deletedAt: null,
                   segments: [{ startedAt: 1, endedAt: 2 }] }],
    }).slice(0, -30);
    const aside = (dom) => keysOf(dom).find((k) => k.startsWith("meter:v1:unreadable:"));
    const unreadableBanner = (d) => bannerSaying(d, /couldn.t be read/i);

    /** Storage with no room for a second copy of the ledger. */
    const bootFull = async (raw) => {
      const full = `<script>
        localStorage.setItem('meter:v1', ${JSON.stringify(raw)});
        const real = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          if (String(k).startsWith('meter:v1:unreadable:')) throw new Error('QuotaExceededError');
          return real.call(this, k, v);
        };
      </script>`;
      const html = readFileSync(DIST, "utf8")
        .replace('<div id="root"></div>', `<div id="root"></div>${full}`);
      const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/" });
      await appReady(dom);
      return dom;
    };

    it("is kept aside and said so, instead of opening empty in silence", async () => {
      const dom = await boot(null, { "meter:v1": CUT });
      const d = dom.window.document;
      expect(unreadableBanner(d)).toBeTruthy();
      expect(dom.window.localStorage.getItem(aside(dom))).toBe(CUT);
      // The banner names where it went, so it can be found again.
      expect(unreadableBanner(d).textContent).toContain(aside(dom));
      expect(stored(dom)).toBe(CUT);
    }, 25_000);

    it("is still there after the first change, which used to replace it for good", async () => {
      // The reported case: adding one project saved a 221-byte ledger over the
      // whole of the original.
      const dom = await boot(null, { "meter:v1": CUT });
      const key = aside(dom);
      await addProject(dom, "Fresh start");
      expect(JSON.parse(stored(dom)).projects.map((p) => p.name)).toEqual(["Fresh start"]);
      expect(dom.window.localStorage.getItem(key)).toBe(CUT);
    }, 25_000);

    it("can be downloaded exactly as it was stored", async () => {
      const dom = await boot(null, { "meter:v1": CUT });
      const d = dom.window.document;
      const file = await grab(dom, () => btn(unreadableBanner(d), /^Download it$/).click());
      expect(file).toBe(CUT);
    }, 25_000);

    it("points the way to a backup", async () => {
      const dom = await boot(null, { "meter:v1": CUT });
      const d = dom.window.document;
      btn(unreadableBanner(d), /restore a backup/i).click();
      await settle();
      expect(btn(d, /^Restore$/)).toBeTruthy();
    }, 25_000);

    it("is not saved over at all while there is no room to keep a copy, until it is downloaded", async () => {
      const dom = await bootFull(CUT);
      const d = dom.window.document;
      expect(aside(dom)).toBeUndefined();
      expect(unreadableBanner(d).textContent).toMatch(/nothing will be saved over it/i);
      // No way to put the warning away while it is the only thing standing
      // between the original and the next save.
      expect(btn(unreadableBanner(d), /Dismiss/)).toBeUndefined();

      await addProject(dom, "Fresh start");
      expect(stored(dom)).toBe(CUT);
      expect(d.querySelector(".card-name").textContent).toContain("Fresh start");

      expect(await grab(dom, () => btn(unreadableBanner(d), /^Download it$/).click())).toBe(CUT);
      await settle();
      // The user holds the original now, so what is on screen is saved.
      expect(JSON.parse(stored(dom)).projects.map((p) => p.name)).toEqual(["Fresh start"]);
      expect(unreadableBanner(d).textContent).toMatch(/saving has started again/i);
    }, 30_000);

    it("says nothing when the ledger reads fine", async () => {
      const dom = await boot({ projects: [], sessions: [] });
      expect(unreadableBanner(dom.window.document)).toBeUndefined();
      expect(aside(dom)).toBeUndefined();
    }, 25_000);
  });

  describe("the backup nudge", () => {
    const HOUR = 3_600_000;
    const ago = (days) => Date.now() - days * 86_400_000;
    const ledger = (count) => ({
      projects: [{ id: "a", name: "Orion", currentRate: 40, currency: "USD", createdAt: ago(30),
                   sessionGoal: null, overallGoal: null, tasks: [] }],
      sessions: Array.from({ length: count }, (_, i) => ({
        id: `s${i}`, projectId: "a", kind: "billed", taskId: null, rate: 40, currency: "USD",
        createdAt: ago(3 + i), closedAt: ago(3 + i) + HOUR, deletedAt: null,
        segments: [{ startedAt: ago(3 + i), endedAt: ago(3 + i) + HOUR }],
      })),
    });
    const nudge = (d) => bannerSaying(d, /backed up/i).textContent;

    it("says one record exists, not exist", async () => {
      const dom = await boot(ledger(1));
      expect(nudge(dom.window.document)).toMatch(/1 record exists only in this browser/);
    }, 25_000);

    it("still says records exist when there are more", async () => {
      const dom = await boot(ledger(2));
      expect(nudge(dom.window.document)).toMatch(/2 records exist only in this browser/);
    }, 25_000);
  });

  describe("the CSV export", () => {
    const HOUR = 3_600_000;
    const back = (days) => Date.now() - days * 86_400_000;
    const exportCsv = async (seed) => {
      const dom = await boot(seed);
      const d = dom.window.document;
      await toProjects(d, "Work");
      return grab(dom, () => btn(d, /Export CSV/i).click());
    };

    it("opens with a byte-order mark, so Excel reads names as UTF-8", async () => {
      // Without it Excel on Windows used the ANSI code page, and Arabic names,
      // emoji and the "·" in notes came out as mojibake.
      const csv = await exportCsv({
        projects: [{ id: "a", name: "مشروع 🚀", currentRate: 20, currency: "USD", createdAt: back(40),
                     sessionGoal: null, overallGoal: null, tasks: [] }],
        sessions: [{ id: "s1", projectId: "a", kind: "billed", taskId: null, rate: 20, currency: "USD",
                     createdAt: back(2), closedAt: back(2) + HOUR, deletedAt: null,
                     segments: [{ startedAt: back(2), endedAt: back(2) + HOUR }] }],
        lastBackupAt: back(1),
      });
      expect(csv.charCodeAt(0)).toBe(0xFEFF);
      expect(csv.slice(1).startsWith('"Date"')).toBe(true);
      expect(csv).toContain('"مشروع 🚀"');
    }, 25_000);
  });

  describe("restoring a backup", () => {
    const HOUR = 3_600_000;
    const at = (y, m, d, h = 9) => new Date(y, m, d, h).getTime();
    const project = (id, name) => ({
      id, name, currentRate: 40, currency: "USD", createdAt: at(2024, 0, 1),
      sessionGoal: null, overallGoal: null, tasks: [],
    });
    const session = (id, projectId, start) => ({
      id, projectId, kind: "billed", taskId: null, rate: 40, currency: "USD",
      createdAt: start, closedAt: start + HOUR, deletedAt: null,
      segments: [{ startedAt: start, endedAt: start + HOUR }],
    });
    const mine = {
      projects: [project("a", "Orion"), project("b", "Lumen")],
      sessions: [
        session("s1", "a", at(2025, 2, 4)), session("s2", "b", at(2025, 5, 9)),
        session("s3", "a", at(2025, 8, 1)),
        // Deleted: it is in storage, and in no count a person would recognise.
        { ...session("s4", "a", at(2025, 8, 2)), deletedAt: at(2025, 8, 3) },
      ],
      lastBackupAt: at(2025, 8, 2),
    };
    const file = {
      projects: [project("x", "Gateway")],
      sessions: [session("f1", "x", at(2024, 0, 15))],
      earnings: [{
        id: "e1", projectId: "x", kind: "piece", cents: 5_000, currency: "USD",
        at: at(2024, 1, 2, 12), createdAt: at(2024, 1, 2), deletedAt: null,
      }],
    };
    const names = (dom) => JSON.parse(stored(dom)).projects.map((p) => p.name);
    const panel = (d) => d.querySelector(".restore");

    /** What the file picker hands over when a file is chosen. Polled rather
     *  than slept on: the file is read asynchronously, and the first read in
     *  a cold run can take longer than any fixed wait worth writing down. */
    const pick = async (dom, content, name = "meter-2024-02-03.json") => {
      const d = dom.window.document;
      await toProjects(d, "Work");
      const input = d.querySelector("input[type=file]");
      const chosen = new dom.window.File([content], name, { type: "application/json" });
      Object.defineProperty(input, "files", { value: [chosen], configurable: true });
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      for (let waited = 0; waited < 5000 && !d.querySelector(".restore, .toast"); waited += 50) {
        await wait(50);
      }
      await settle();
    };

    it("asks first, setting what would be replaced beside what the file holds", async () => {
      const dom = await boot(mine);
      await pick(dom, JSON.stringify(file));
      const d = dom.window.document;
      expect(panel(d).textContent).toMatch(/replaces everything here/i);
      expect(panel(d).textContent).toContain("meter-2024-02-03.json");
      const [here, there] = [...panel(d).querySelectorAll("dd")].map((x) => x.textContent);
      expect(here).toMatch(/^2 projects and 3 sessions, from .*2025.* to .*2025/);
      expect(there).toMatch(/^1 project, 1 session and 1 payment, from .*2024.* to .*2024/);
      // Picking the file changed nothing.
      expect(names(dom)).toEqual(["Orion", "Lumen"]);
    }, 25_000);

    it("replaces the ledger only on Replace my ledger, and can still be undone", async () => {
      const dom = await boot(mine);
      await pick(dom, JSON.stringify(file));
      const d = dom.window.document;
      btn(d, /^Replace my ledger$/).click();
      await settle();
      expect(names(dom)).toEqual(["Gateway"]);
      expect(panel(d)).toBeNull();
      expect(d.querySelector(".toast").textContent).toMatch(/Backup restored/);
      btn(d.querySelector(".toast"), /^Undo$/).click();
      await settle();
      expect(names(dom)).toEqual(["Orion", "Lumen"]);
    }, 25_000);

    it("takes the example ledger in docs/payments-seed.json, companies and payments with it", async () => {
      const seed = readFileSync(new URL("../docs/payments-seed.json", import.meta.url), "utf8");
      const dom = await boot(mine);
      await pick(dom, seed, "payments-seed.json");
      const d = dom.window.document;
      expect(panel(d).textContent).toContain("payments-seed.json");
      btn(d, /^Replace my ledger$/).click();
      await settle();
      const now = JSON.parse(stored(dom));
      expect(names(dom)).toEqual(["label-sprint", "intent-review", "translation-review"]);
      expect(now.earnings).toHaveLength(JSON.parse(seed).earnings.length);
      expect(now.companies.map((c) => c.name)).toEqual(["Larkspur Data", "Meridian Lingua"]);
    }, 25_000);

    it("leaves everything as it was on Cancel", async () => {
      const dom = await boot(mine);
      const before = stored(dom);
      await pick(dom, JSON.stringify(file));
      const d = dom.window.document;
      btn(panel(d), /^Cancel$/).click();
      await settle();
      expect(panel(d)).toBeNull();
      expect(stored(dom)).toBe(before);
      expect(btn(d, /^Restore$/)).toBeTruthy();
    }, 25_000);

    it("is the way back from a ledger that could not be read", async () => {
      const dom = await boot(null, { "meter:v1": "{not json" });
      const d = dom.window.document;
      btn(bannerSaying(d, /couldn.t be read/i), /restore a backup/i).click();
      await settle();
      await pick(dom, JSON.stringify(file));
      expect(panel(d).querySelector("dd").textContent).toBe("nothing at all");
      btn(panel(d), /^Replace my ledger$/).click();
      await settle();
      expect(names(dom)).toEqual(["Gateway"]);
    }, 25_000);

    it("turns away a file that is not a backup without asking anything", async () => {
      const dom = await boot(mine);
      await pick(dom, '{"nope":1}', "notes.json");
      const d = dom.window.document;
      expect(panel(d)).toBeNull();
      expect(d.querySelector(".toast").textContent).toMatch(/isn.t a Meter backup/);
      expect(names(dom)).toEqual(["Orion", "Lumen"]);
    }, 25_000);
  });

  describe("the top bar on a narrow phone", () => {
    it("narrows the tabs with the screen, so 320px does not scroll sideways", () => {
      // Only a real browser can measure this, so it was measured in one: at
      // 320px the tab bar stuck out 39px before and fits now, on all four main
      // screens in both themes, and from 390px up every tab is exactly as wide
      // as it was. What is pinned here are the two declarations that do it.
      const css = readFileSync(DIST, "utf8");
      const tab = css.match(/\.tab\{([^}]*)/)?.[1];
      expect(tab).toContain("padding:8px clamp(5px,calc((100vw - 300px) / 6),15px)");
      expect(tab).not.toContain("padding:8px 15px");
      // And if the tabs still cannot fit beside the name, they wrap below it
      // rather than push the page wider than the screen.
      expect(css.match(/\.topbar\{([^}]*)/)?.[1]).toContain("flex-wrap:wrap");
    });
  });
});

describe("fixes: clock, Today and Overview", () => {
  /** A named wall-clock instant in the zone the suite runs in. Every test in
   *  this block pins the page's clock to one of these, so none of them
   *  depends on the day, the weekday or the hour it happens to run at. Early
   *  October 2026: Sunday the 4th, Monday the 5th, Wednesday the 7th. */
  const at = (m, d, h = 0, min = 0) => new Date(2026, m - 1, d, h, min).getTime();

  /**
   * Boots with the page's clock set to `instant` rather than the real one.
   *
   * `Date.now` in the page reads the real clock plus a shift, so time still
   * passes while a test runs, and `window.__setNow` moves it on. `lapse` runs
   * the page's long timers (ten seconds and over) every 200ms instead, so a
   * thirty-second tick can be watched without waiting thirty seconds.
   */
  const bootAt = async (seed, instant, { settings = null, lapse = false } = {}) => {
    let html = readFileSync(DIST, "utf8");
    const clock = `<script>(() => {
      const real = Date.now.bind(Date);
      let shift = ${instant} - real();
      Date.now = () => real() + shift;
      window.__setNow = (t) => { shift = t - real(); };
      ${lapse ? "const every = window.setInterval.bind(window);"
        + " window.setInterval = (fn, ms, ...rest) => every(fn, ms >= 10000 ? 200 : ms, ...rest);" : ""}
    })();</script>`;
    const sets = [
      seed && `localStorage.setItem('meter:v1', ${JSON.stringify(JSON.stringify(seed))});`,
      ...Object.entries(settings ?? {}).map(
        ([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`),
    ].filter(Boolean);
    html = html.replace('<div id="root"></div>',
      `<div id="root"></div>${clock}<script>${sets.join("")}</script>`);
    const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url: "http://localhost/" });
    await appReady(dom);
    return dom;
  };

  const project = (id, name, extra = {}) => ({
    id, name, currentRate: 60, currency: "USD", createdAt: at(8, 1),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  const sitting = (id, projectId, from, to, extra = {}) => ({
    id, projectId, kind: "billed", taskId: null, rate: 60, currency: "USD",
    createdAt: from, closedAt: to, deletedAt: null,
    segments: [{ startedAt: from, endedAt: to }], ...extra,
  });
  /** The Today tab's section for the day, found by its heading. */
  const todaySec = (d) => [...d.querySelectorAll(".sec")]
    .find((s) => /^Today/.test(s.querySelector(".sec-head")?.textContent ?? ""));
  /** What that section's heading says the day came to. */
  const todayHead = (d) => todaySec(d).querySelectorAll(".sec-head .eyebrow")[1].textContent;
  const short = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });

  describe("the clock moves with no meter running", () => {
    const seed = () => ({
      projects: [project("a", "Acme")],
      sessions: [sitting("s1", "a", at(10, 4, 20), at(10, 4, 21))],
    });

    it("turns Today over to the new day on its own", async () => {
      // Opened on Sunday night and still open on Monday morning. Nothing is
      // running, so only the idle tick can carry the app across midnight.
      const dom = await bootAt(seed(), at(10, 4, 23), { lapse: true });
      const d = dom.window.document;
      expect(todayHead(d)).toBe("$60.00 · 1h 00m");

      dom.window.__setNow(at(10, 5, 10));
      await until(() => todayHead(d) === "nothing yet", { what: "Today to turn over to the new day" });
      expect(todayHead(d)).toBe("nothing yet");
      expect(d.querySelector(".panel .empty").textContent).toMatch(/Nothing recorded today/);
    }, 20_000);

    it("catches up as soon as the app is looked at again", async () => {
      // A tab in the background, or a laptop asleep overnight, has its timers
      // held back: coming back to it must not show the week it was left on.
      const dom = await bootAt(seed(), at(10, 4, 23));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      const span = () => d.querySelector(".dash-sub").textContent;
      expect(span()).toContain(short(at(9, 28)));
      expect(d.querySelector(".grand-amt").textContent).toBe("$60.00");

      dom.window.__setNow(at(10, 5, 10));
      d.dispatchEvent(new dom.window.Event("visibilitychange"));
      await settle();
      expect(span()).toContain(short(at(10, 5)));
      expect(d.querySelector(".grand-amt").textContent).toBe("—");

      dom.window.__setNow(at(10, 12, 10));
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      await settle();
      expect(span()).toContain(short(at(10, 12)));
    }, 20_000);
  });

  describe("Today counts work, not sleep", () => {
    // An hour and a half of paid work, and a night's sleep tracked at a rate
    // that ran from 23:00 into this morning: seven of its hours are today's.
    const seed = () => ({
      projects: [
        project("a", "Acme", { currentRate: 40 }),
        project("z", "Sleep", { currentRate: 10, offClock: true }),
      ],
      sessions: [
        sitting("s1", "a", at(10, 5, 9), at(10, 5, 10, 30), { rate: 40 }),
        sitting("s2", "z", at(10, 4, 23), at(10, 5, 7), { rate: 10 }),
      ],
    });

    it("keeps off-the-clock time out of the day's heading", async () => {
      const dom = await bootAt(seed(), at(10, 5, 12));
      const d = dom.window.document;
      expect(todayHead(d)).toBe("$60.00 · 1h 30m");
      // and out of the same day's heading under Recent
      expect(d.querySelector(".day .day-sum").textContent).toBe("$60.00 · 1h 30m");
    }, 20_000);

    it("still lists the sleep with its hours, below the work and marked", async () => {
      const dom = await bootAt(seed(), at(10, 5, 12));
      const d = dom.window.document;
      const rows = [...todaySec(d).querySelectorAll(".trow")];
      expect(rows.map((r) => r.querySelector(".trow-label").textContent)).toEqual(["Acme", "Sleep"]);
      expect(rows[1].querySelector(".trow-sub").textContent).toMatch(/off the clock/);
      expect(rows[1].querySelector(".trow-time").textContent).toBe("7h 00m");
      expect(rows[1].querySelector(".trow-amt")).toBeNull();
    }, 20_000);
  });

  describe("a sitting across midnight in the Recent list", () => {
    /** The figure in a row or heading, as a number of dollars. */
    const dollars = (text) => Number(text.replace(/[^0-9.]/g, ""));
    // An hour before midnight and two after, then an hour on Monday morning.
    const seed = () => ({
      projects: [project("a", "Acme")],
      sessions: [
        sitting("s1", "a", at(10, 4, 23), at(10, 5, 2)),
        sitting("s2", "a", at(10, 5, 9), at(10, 5, 10)),
      ],
    });

    it("is listed under each day with that day's share of the hours and the money", async () => {
      const dom = await bootAt(seed(), at(10, 5, 12));
      const d = dom.window.document;
      const [monday, sunday] = [...d.querySelectorAll(".day")];
      expect(monday.querySelector(".day-sum").textContent).toBe("$180.00 · 3h 00m");
      expect(sunday.querySelector(".day-sum").textContent).toBe("$60.00 · 1h 00m");

      const carried = [...monday.querySelectorAll(".row")]
        .find((r) => /of 3h 00m/.test(r.querySelector(".row-meta").textContent));
      expect(carried.querySelector(".row-meta").textContent).toBe("2h 00m of 3h 00m");
      expect(carried.querySelector(".row-amt").textContent).toBe("$120.00");
      // it says which day it started on, since Monday's list holds no start
      expect(carried.querySelector(".row-when").textContent).toContain(short(at(10, 4)));

      const started = sunday.querySelector(".row");
      expect(started.querySelector(".row-meta").textContent)
        .toBe("1h 00m of 3h 00m · ran past midnight");
      expect(started.querySelector(".row-amt").textContent).toBe("$60.00");
    }, 20_000);

    it("leaves every day's rows adding up to its heading", async () => {
      const dom = await bootAt(seed(), at(10, 5, 12));
      for (const day of dom.window.document.querySelectorAll(".day")) {
        const rows = [...day.querySelectorAll(".row-amt")]
          .reduce((sum, r) => sum + dollars(r.textContent), 0);
        expect(rows).toBeCloseTo(dollars(day.querySelector(".day-sum").textContent.split(" · ")[0]), 2);
      }
    }, 20_000);
  });

  describe("rows whose money has not landed", () => {
    // Three hours on Monday: one paid, one waiting on an answer, one rejected.
    const seed = () => ({
      projects: [project("a", "Acme")],
      sessions: [
        sitting("s1", "a", at(10, 5, 9), at(10, 5, 10)),
        sitting("s2", "a", at(10, 5, 10), at(10, 5, 11), { status: "pending" }),
        sitting("s3", "a", at(10, 5, 11), at(10, 5, 12), { status: "cancelled" }),
      ],
    });
    const rowOf = (d, id) => {
      // newest first: the rejected hour, the pending one, then the paid one
      const order = ["s3", "s2", "s1"];
      return d.querySelectorAll(".day .row")[order.indexOf(id)];
    };
    const tags = (row) => [...row.querySelectorAll(".tag")].map((t) => t.textContent);

    it("marks a rejected sitting and strikes its money, as the ledger does", async () => {
      const dom = await bootAt(seed(), at(10, 5, 13));
      const row = rowOf(dom.window.document, "s3");
      expect(tags(row)).toEqual(["cancelled"]);
      expect(row.className).toMatch(/\bis-void\b/);
    }, 20_000);

    it("marks a sitting still waiting on an answer as pending", async () => {
      const dom = await bootAt(seed(), at(10, 5, 13));
      const d = dom.window.document;
      expect(tags(rowOf(d, "s2"))).toEqual(["pending"]);
      expect(rowOf(d, "s2").className).not.toMatch(/is-void/);
      expect(tags(rowOf(d, "s1"))).toEqual([]);
    }, 20_000);

    it("says in the heading what is pending, apart from what was earned", async () => {
      // Every row's figure is then in the heading or visibly struck out of it.
      const dom = await bootAt(seed(), at(10, 5, 13));
      const d = dom.window.document;
      expect(d.querySelector(".day .day-sum").textContent).toBe("$60.00 · 3h 00m · $60.00 pending");
      expect(todayHead(d)).toBe("$60.00 · 3h 00m · $60.00 pending");
    }, 20_000);
  });

  describe("comparing with the period before", () => {
    // Read on Wednesday at noon. This week: two hours on Monday. Last week:
    // an hour on Monday, then eight on Thursday, which this week has not
    // reached yet. The week before that: three hours.
    const seed = () => ({
      projects: [project("a", "Acme", { currentRate: 100 })],
      sessions: [
        sitting("s1", "a", at(10, 5, 9), at(10, 5, 11), { rate: 100 }),
        sitting("s2", "a", at(9, 28, 9), at(9, 28, 10), { rate: 100 }),
        sitting("s3", "a", at(10, 1, 9), at(10, 1, 17), { rate: 100 }),
        sitting("s4", "a", at(9, 21, 9), at(9, 21, 12), { rate: 100 }),
      ],
    });
    const deltas = (d) => [...d.querySelectorAll(".delta")].map((x) => x.textContent);

    it("sets the week so far against last week up to the same point", async () => {
      // $200 by Wednesday noon against $100 by last Wednesday noon. Against
      // all of last week, $900, the same week read as 78% down.
      const dom = await bootAt(seed(), at(10, 7, 12));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      expect(d.querySelector(".grand-amt").textContent).toBe("$200.00");
      expect(d.querySelector(".dash-sub .delta").textContent).toBe("+100% vs this point last week");
      expect(deltas(d)).toContain("+100% vs this point last week"); // the Billed tile, in hours
      expect(deltas(d).some((t) => /78%/.test(t))).toBe(false);
    }, 20_000);

    it("sets a week that is over against the whole week before it, and says so", async () => {
      const dom = await bootAt(seed(), at(10, 7, 12));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      d.querySelectorAll(".step")[0].click();
      await settle();
      expect(d.querySelector(".grand-amt").textContent).toBe("$900.00");
      expect(d.querySelector(".dash-sub .delta").textContent).toBe("+200% vs the week before");
    }, 20_000);
  });

  describe("two currencies in one week", () => {
    const fmt = (cents, currency) => new Intl.NumberFormat(undefined, {
      style: "currency", currency, minimumFractionDigits: 2,
    }).format(cents / 100);
    // $40 and EGP 300 on Tuesday, $30 on Wednesday: three dollar hours and
    // one pound hour. And a night's sleep at $10 an hour, which is no money.
    const seed = () => ({
      projects: [
        project("u", "USD work", { currentRate: 20 }),
        project("e", "EGP work", { currentRate: 300, currency: "EGP" }),
        project("u2", "USD work 2", { currentRate: 30 }),
        project("z", "Sleep", { currentRate: 10, offClock: true }),
      ],
      sessions: [
        sitting("s1", "u", at(10, 6, 9), at(10, 6, 11), { rate: 20 }),
        sitting("s2", "e", at(10, 6, 12), at(10, 6, 13), { rate: 300, currency: "EGP" }),
        sitting("s3", "u2", at(10, 7, 9), at(10, 7, 10), { rate: 30 }),
        sitting("s4", "z", at(10, 6, 23), at(10, 7, 7), { rate: 10 }),
      ],
    });
    const open = async () => {
      const dom = await bootAt(seed(), at(10, 7, 18));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      return d;
    };

    it("leads with the currency the hours were in, not the bigger number", async () => {
      const d = await open();
      expect(d.querySelector(".grand-amt").textContent).toBe("$70.00");
      expect(d.querySelector(".grand-alt").textContent).toBe(fmt(30_000, "EGP"));
    }, 20_000);

    it("quotes an hour in each currency over that currency's own hours", async () => {
      // EGP 300 over all four hours read "EGP 75.00/hr", a rate nobody paid.
      const d = await open();
      const hours = [...d.querySelectorAll(".tile")]
        .filter((t) => /An hour came to/.test(t.textContent))
        .map((t) => t.querySelector(".tile-val").textContent);
      expect(hours).toEqual([`${fmt(2_333, "USD")}/hr`, `${fmt(30_000, "EGP")}/hr`]);
    }, 20_000);

    it("lists each currency in a day's tooltip rather than adding them", async () => {
      const d = await open();
      const tip = (i) => [...d.querySelectorAll(".tcol")[i].querySelectorAll(".ttip span")]
        .map((s) => s.textContent);
      // Monday first: Tuesday is the second column, Wednesday the third.
      expect(tip(1)).toEqual(["3h 00m billed", fmt(4_000, "USD"), fmt(30_000, "EGP")]);
      expect(tip(2)).toEqual(["1h 00m billed", fmt(3_000, "USD")]);
    }, 20_000);

    it("draws no share of a total that would add pounds to dollars", async () => {
      // "EGP work is 100% of it" left $70 of dollar work out of "it".
      const d = await open();
      expect(d.querySelector(".concentration")).toBeNull();
    }, 20_000);

    it("compares each currency with itself, and says against what once", async () => {
      const d = await open();
      const deltas = [...d.querySelectorAll(".dash-sub .delta")].map((x) => x.textContent);
      expect(deltas).toEqual(["USD —", "EGP — vs this point last week"]);
    }, 20_000);
  });

  describe("one client typed two ways", () => {
    it("is one company in By company, under the spelling met first", async () => {
      // The payday rule already reads these as one client. By company listed
      // them as two, each with half of the money.
      const dom = await bootAt({
        projects: [
          project("a", "Pref", { currentRate: 100, company: "Northwind" }),
          project("b", "Reviews", { currentRate: 100, company: "northwind" }),
        ],
        sessions: [
          sitting("s1", "a", at(10, 5, 9), at(10, 5, 11), { rate: 100 }),
          sitting("s2", "b", at(10, 6, 9), at(10, 6, 12), { rate: 100 }),
        ],
      }, at(10, 7, 12));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      const rows = [...d.querySelectorAll(".crow")];
      expect(rows).toHaveLength(1);
      expect(rows[0].querySelector(".crow-name").textContent).toBe("Northwind");
      expect(rows[0].querySelector(".crow-amt").textContent).toBe("$500.00");
      expect(rows[0].textContent).toMatch(/2 projects/);
      expect([...d.querySelectorAll(".sec-head")].some((h) => /By company1 company$/.test(h.textContent)))
        .toBe(true);
    }, 20_000);
  });

  describe("the activity legend with few days on it", () => {
    it("states each boundary once", async () => {
      // Two days of two hours: every quantile is the same day, and the legend
      // read "to 2h 00m" three times before "over 2h 00m".
      const dom = await bootAt({
        projects: [project("a", "Acme")],
        sessions: [
          sitting("s1", "a", at(10, 2, 9), at(10, 2, 11)),
          sitting("s2", "a", at(10, 5, 9), at(10, 5, 11)),
        ],
      }, at(10, 7, 12));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      const legend = [...d.querySelectorAll(".hm-legend .legend-item")].map((e) => e.textContent);
      expect(legend).toEqual(["to 2h 00m", "over 2h 00m"]);
      expect(d.querySelector(`.hm-cell[data-at="${at(10, 5)}"]`).dataset.level).toBe("1");
    }, 25_000);
  });

  describe("money targets and the money no clock measured", () => {
    const weekly = (target) => ({ overallGoal: { type: "money", target, period: "week" } });
    const earning = (id, projectId, cents, when, extra = {}) => ({
      id, projectId, kind: "bonus", cents, currency: "USD", at: when, note: "",
      createdAt: when, deletedAt: null, ...extra,
    });
    // Alpha: two hours at $60 and a $60 bonus this week, $100 more still
    // waiting on an answer, which a goal counts, and $30 rejected, which it
    // does not. Beta is paid per accepted item, never by the clock.
    const seed = () => ({
      projects: [
        project("a", "Alpha", weekly(500)),
        project("b", "Beta", { currentRate: 0, perTask: 50, ...weekly(300) }),
      ],
      sessions: [sitting("s1", "a", at(10, 5, 9), at(10, 5, 11))],
      earnings: [
        earning("e1", "a", 6_000, at(10, 6, 12)),
        earning("e2", "a", 10_000, at(10, 6, 13), { status: "pending" }),
        earning("e4", "a", 3_000, at(10, 6, 14), { status: "cancelled" }),
        earning("e3", "b", 15_000, at(10, 6, 12), { kind: "piece", units: 3 }),
      ],
    });
    const target = (d, name) => [...d.querySelectorAll(".trg")]
      .find((t) => t.querySelector(".trg-name").textContent === name)
      .querySelector(".goal-val").textContent;

    it("counts a bonus, settled or waiting, toward the week's target on the Overview", async () => {
      const dom = await bootAt(seed(), at(10, 7, 12));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      expect(target(d, "Alpha")).toBe("$280.00 / $500.00");
    }, 20_000);

    it("lets a target move on a project paid per accepted item", async () => {
      const dom = await bootAt(seed(), at(10, 7, 12));
      const d = dom.window.document;
      await toProjects(d, "Overview");
      expect(target(d, "Beta")).toBe("$150.00 / $300.00");
    }, 20_000);

    it("reads the same on the project's own page", async () => {
      const dom = await bootAt(seed(), at(10, 7, 12));
      const d = dom.window.document;
      await toProjects(d, "Work");
      [...d.querySelectorAll(".card")].find((c) => /Alpha/.test(c.textContent)).click();
      await settle();
      expect(d.querySelector(".goal .goal-val").textContent).toBe("$280.00 / $500.00");
    }, 20_000);
  });
});
