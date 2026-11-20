/**
 * Integration tests against the BUILT artifact, not the source. These catch
 * things unit tests structurally cannot: bundling mistakes, event wiring,
 * and CSS that silently fails (an inline element ignoring margin-top, say).
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { settle, boot, btn, bootDash, toProjects, setValue, startMeter, guardBuiltApp } from "./app.integration.helpers.js";

guardBuiltApp();

describe("nudging the user to keep a copy they hold", () => {
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const daysAgo = (n) => Date.now() - n * DAY;
  const project = (id, extra = {}) => ({
    id, name: id, currentRate: 100, currency: "USD", createdAt: daysAgo(400),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  const block = (id, back, extra = {}) => ({
    id, projectId: "a", kind: "billed", taskId: null, rate: 100, currency: "USD",
    createdAt: daysAgo(back), closedAt: daysAgo(back) + HOUR, deletedAt: null,
    segments: [{ startedAt: daysAgo(back), endedAt: daysAgo(back) + HOUR }],
    ...extra,
  });
  const open = async (seed) => {
    const dom = await boot(seed);
    await settle();
    return { dom, d: dom.window.document };
  };
  const banner = (d) => [...d.querySelectorAll(".banner")]
    .find((b) => /backed up/i.test(b.textContent));

  it("asks for a backup once work exists and no file was ever made", async () => {
    const { d } = await open({ projects: [project("a")], sessions: [block("s1", 3)] });
    expect(banner(d)).toBeTruthy();
    expect(banner(d).textContent).toMatch(/Never backed up/i);
    expect(banner(d).textContent).toMatch(/1 record/);
  }, 25_000);

  it("says nothing at all on an empty ledger", async () => {
    // A banner that cries wolf is one people learn to look past.
    const { d } = await open({ projects: [project("a")], sessions: [] });
    expect(banner(d)).toBeUndefined();
  }, 25_000);

  it("stays quiet while the existing file still holds everything", async () => {
    const { d } = await open({
      projects: [project("a")],
      sessions: [block("s1", 40)],
      lastBackupAt: daysAgo(30), // long ago, but nothing recorded since
    });
    expect(banner(d)).toBeUndefined();
  }, 25_000);

  it("asks again once new work has piled up on an old backup", async () => {
    const { d } = await open({
      projects: [project("a")],
      sessions: [block("s1", 40), block("s2", 1)],
      lastBackupAt: daysAgo(30),
    });
    expect(banner(d).textContent).toMatch(/Last backed up 30 days ago/i);
  }, 25_000);

  it("records the backup and drops the nudge once a file is produced", async () => {
    const { dom, d } = await open({ projects: [project("a")], sessions: [block("s1", 3)] });
    expect(banner(d)).toBeTruthy();
    await toProjects(d, "Settings");
    // jsdom implements no blob URLs, so the download throws and the stamp never
    // lands — which is the RIGHT behaviour (no file handed over, no backup
    // recorded) but leaves the happy path untestable without this.
    let handed = null;
    dom.window.URL.createObjectURL = (blob) => { handed = blob; return "blob:x"; };
    dom.window.URL.revokeObjectURL = () => {};
    btn(d, /Export backup/i).click();
    await settle();
    expect(handed).not.toBeNull();

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(typeof saved.lastBackupAt).toBe("number");
    // and the file itself does NOT claim to have been backed up already
    expect(banner(d)).toBeUndefined();
    expect(d.querySelector(".backup-note").textContent).toMatch(/Last backup today/i);
  }, 30_000);

  it("states the position even when nothing is overdue", async () => {
    const { d } = await open({
      projects: [project("a")], sessions: [block("s1", 40)], lastBackupAt: daysAgo(2),
    });
    await toProjects(d, "Settings");
    expect(d.querySelector(".backup-note").textContent).toMatch(/Last backup 2 days ago/i);
  }, 25_000);
});

describe("finding one project among forty", () => {
  const HOUR = 3_600_000;
  const p = (name, extra = {}) => ({
    id: name, name, currentRate: 100, currency: "USD", createdAt: Date.now() - 400 * 86_400_000,
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  /** Enough projects that the box appears at all, shaped like the real ledger:
   *  a handful live, the rest filed away under one client. */
  const many = {
    projects: [
      p("Lumen"), p("Delta Human Pref"), p("Gateway"),
      p("orion_env_building", { company: "Northwind", status: "done" }),
      p("pair review", { company: "Northwind", status: "done" }),
      p("extensions-pair-review", { company: "Northwind", status: "done" }),
      p("songbird", { company: "Northwind", status: "done" }),
      p("Weather Widget", { company: "Northwind", status: "done" }),
    ],
    sessions: [],
  };
  const names = (d) => [...d.querySelectorAll(".card-name")].map((e) => e.textContent);
  const find = (d) => d.querySelector(".find");
  const open = async (seed) => {
    const dom = await boot(seed);
    await settle();
    await toProjects(dom.window.document, "Work");
    return { dom, d: dom.window.document };
  };
  const type = async (dom, d, text) => {
    setValue(dom.window, find(d), text);
    await settle();
  };

  it("offers no box on a short list, where nothing can get lost", async () => {
    const { d } = await open({ projects: [p("Lumen"), p("Gateway")], sessions: [] });
    expect(find(d)).toBeNull();
  }, 25_000);

  it("narrows the list as you type", async () => {
    const { dom, d } = await open(many);
    await type(dom, d, "songbird");
    expect(names(d)).toEqual(["songbird"]);
  }, 30_000);

  it("reaches into the filed-away work, which is where most of it is", async () => {
    // A match inside a collapsed group is a match the reader cannot see, so
    // searching opens it.
    const { dom, d } = await open(many);
    expect(names(d)).not.toContain("orion_env_building");
    await type(dom, d, "orion");
    expect(names(d)).toContain("orion_env_building");
  }, 30_000);

  it("ignores whether you typed spaces, underscores or hyphens", async () => {
    const { dom, d } = await open(many);
    await type(dom, d, "env building");
    expect(names(d)).toEqual(["orion_env_building"]);
    await type(dom, d, "pair-review");
    expect(names(d).sort()).toEqual(["extensions-pair-review", "pair review"]);
  }, 30_000);

  it("finds every project belonging to a client", async () => {
    const { dom, d } = await open(many);
    await type(dom, d, "northwind");
    expect(names(d)).toHaveLength(5);
  }, 30_000);

  it("says so plainly when nothing matches", async () => {
    const { dom, d } = await open(many);
    await type(dom, d, "zzzz");
    expect(d.querySelector(".empty").textContent).toMatch(/Nothing matches/i);
    expect(names(d)).toHaveLength(0);
  }, 30_000);

  it("leaves the headline alone, because searching earns you nothing", async () => {
    const { dom, d } = await open({
      ...many,
      sessions: [{
        id: "s1", projectId: "Lumen", kind: "billed", taskId: null, rate: 100,
        currency: "USD", createdAt: Date.now() - HOUR, closedAt: Date.now(), deletedAt: null,
        segments: [{ startedAt: Date.now() - HOUR, endedAt: Date.now() }],
      }],
    });
    const before = d.querySelector(".grand-amt").textContent;
    await type(dom, d, "songbird");
    expect(d.querySelector(".grand-amt").textContent).toBe(before);
  }, 30_000);

  it("brings the whole list back when cleared", async () => {
    const { dom, d } = await open(many);
    await type(dom, d, "songbird");
    expect(names(d)).toHaveLength(1);
    btn(d, /^Clear$/).click();
    await settle();
    expect(names(d).length).toBeGreaterThan(1);
  }, 30_000);
});

describe("handing the numbers to a spreadsheet", () => {
  const HOUR = 3_600_000;
  const back = (n) => Date.now() - n * 86_400_000;
  const seed = {
    projects: [{
      id: "a", name: "orion", currentRate: 20, currency: "USD", company: "Northwind",
      createdAt: back(40), sessionGoal: null, overallGoal: null, tasks: [],
    }],
    sessions: [{
      id: "s1", projectId: "a", kind: "billed", taskId: null, rate: 20, currency: "USD",
      createdAt: back(2), closedAt: back(2) + 2 * HOUR, deletedAt: null,
      segments: [{ startedAt: back(2), endedAt: back(2) + 2 * HOUR }],
    }],
    earnings: [{
      id: "e1", projectId: "a", taskId: null, kind: "piece", cents: 300_000,
      currency: "USD", at: back(1), note: "", units: 6, createdAt: back(1), deletedAt: null,
    }],
    lastBackupAt: back(30),
  };
  /** jsdom implements no blob URLs and will not read a Blob back, so the file
   *  is caught on its way in — the text handed to the Blob constructor IS the
   *  file the browser would have written. */
  const grab = async (dom, d, label) => {
    const written = [];
    const RealBlob = dom.window.Blob;
    dom.window.Blob = function Caught(parts, opts) {
      written.push(String(parts[0]));
      return new RealBlob(parts, opts);
    };
    dom.window.URL.createObjectURL = () => "blob:x";
    dom.window.URL.revokeObjectURL = () => {};
    btn(d, label).click();
    await settle();
    dom.window.Blob = RealBlob;
    return written[0];
  };

  it("writes a CSV a spreadsheet can open, with both kinds of income", async () => {
    const dom = await boot(seed);
    const d = dom.window.document;
    await settle();
    await toProjects(d, "Settings");
    const csv = await grab(dom, d, /Export CSV/i);

    // After the byte-order mark that tells Excel the file is UTF-8.
    const rows = csv.replace(/^\uFEFF/, "").trim().split("\n");
    expect(rows[0]).toMatch(/^"Date","Project","Company"/);
    expect(rows).toHaveLength(3); // header, the session, the piece-rate money
    expect(csv).toContain('"orion"');
    expect(csv).toContain('"Northwind"');
    expect(csv).toContain('"40.00"'); // 2h at $20
    expect(csv).toContain('"3000.00"'); // the money no clock measured
    expect(csv).toMatch(/"6 items"/);
  }, 30_000);

  it("does not count a CSV as a backup", async () => {
    // It drops ids, segments, goals and objectives, so the app cannot read it
    // back. Clearing the nudge would leave the user believing otherwise.
    const dom = await boot({ ...seed, lastBackupAt: undefined });
    const d = dom.window.document;
    await settle();
    await toProjects(d, "Settings");
    await grab(dom, d, /Export CSV/i);

    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.lastBackupAt).toBeUndefined();
    expect([...d.querySelectorAll(".banner")].some((b) => /backed up/i.test(b.textContent)))
      .toBe(true);
  }, 30_000);

  it("offers no CSV on the Life tab, where there is no money", async () => {
    const dom = await boot(seed);
    const d = dom.window.document;
    await settle();
    await toProjects(d, "Life");
    expect(btn(d, /Export CSV/i)).toBeUndefined();
  }, 25_000);
});

describe("telling the user when they work", () => {
  const HOUR = 3_600_000;
  /** A run of days at a fixed hour, `n` weeks back, so the pattern has volume. */
  const runs = (spec) => {
    const out = [];
    let i = 0;
    for (const { day, hour, count, hours = 2, manual } of spec) {
      for (let k = 0; k < count; k += 1) {
        const d = new Date();
        d.setDate(d.getDate() - (d.getDay() + 6) % 7 - 7 * (k + 1)); // a Monday, k weeks back
        d.setDate(d.getDate() + day);
        d.setHours(hour, 0, 0, 0);
        const startedAt = d.getTime();
        out.push({
          id: `s${i += 1}`, projectId: "a", kind: "billed", taskId: null, rate: 10,
          currency: "USD", createdAt: startedAt, closedAt: startedAt + hours * HOUR,
          deletedAt: null, segments: [{ startedAt, endedAt: startedAt + hours * HOUR }],
          ...(manual ? { manual: true } : {}),
        });
      }
    }
    return out;
  };
  const seed = (sessions) => ({
    projects: [{
      id: "a", name: "p", currentRate: 10, currency: "USD",
      createdAt: Date.now() - 400 * 86_400_000,
      sessionGoal: null, overallGoal: null, tasks: [],
    }],
    sessions,
  });
  const panel = (d) => [...d.querySelectorAll(".sec")].find((x) => /When you work/.test(x.textContent));
  const read = (d) => panel(d)?.querySelector(".rhy-read")?.textContent.replace(/\s+/g, " ") ?? "";
  const open = async (s) => {
    const dom = await bootDash(s);
    await settle();
    return dom.window.document;
  };

  it("names the day only when it genuinely stands above the rest", async () => {
    const d = await open(seed(runs([
      { day: 2, hour: 20, count: 10, hours: 6 }, // Wednesdays, heavily
      { day: 0, hour: 20, count: 10, hours: 1 },
      { day: 4, hour: 20, count: 10, hours: 1 },
    ])));
    expect(read(d)).toMatch(/Busiest on Wednesday/);
  }, 30_000);

  it("calls a flat week flat, rather than crowning the tallest bar", async () => {
    // Seven bars within a fifth of each other is not a habit.
    const d = await open(seed(runs(
      [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, hour: 20, count: 8, hours: 2 })))));
    expect(read(d)).toMatch(/spread evenly across the week/i);
    expect(read(d)).not.toMatch(/Busiest on/);
  }, 30_000);

  it("finds a working stretch that runs across midnight", async () => {
    // 23:00 + 3h occupies hours 23, 00 and 01. The best four-hour window over
    // three worked hours has two equal answers, and ties go to the earlier.
    const d = await open(seed(runs([{ day: 1, hour: 23, count: 14, hours: 3 }])));
    expect(read(d)).toMatch(/between 22:00 and 02:00/);
  }, 30_000);

  it("ignores typed-in sessions when reading the clock", async () => {
    // An imported row's hour was chosen by the importer, not observed. Reading
    // it back would report that arithmetic as the user's habit.
    const d = await open(seed([
      ...runs([{ day: 1, hour: 9, count: 30, hours: 4, manual: true }]),
      ...runs([{ day: 1, hour: 22, count: 14, hours: 3 }]),
    ]));
    expect(read(d)).toMatch(/between 21:00 and 01:00/);
    expect(read(d)).not.toMatch(/09:00/);
  }, 30_000);

  it("draws no clock at all on too few measured sessions", async () => {
    const d = await open(seed(runs([{ day: 1, hour: 9, count: 30, hours: 4, manual: true }])));
    expect(panel(d)).toBeTruthy(); // the week still reads
    expect(read(d)).not.toMatch(/between/);
    expect(panel(d).querySelectorAll(".cyc")).toHaveLength(1);
  }, 30_000);

  it("shows nothing at all before there is anything to show", async () => {
    const d = await open(seed([]));
    expect(panel(d)).toBeUndefined();
  }, 25_000);
});

describe("which work was worth the time, and how much rides on one project", () => {
  const HOUR = 3_600_000;
  const back = (n) => Date.now() - n * 86_400_000;
  const project = (id, extra = {}) => ({
    id, name: id, currentRate: 10, currency: "USD", createdAt: back(300),
    sessionGoal: null, overallGoal: null, tasks: [], ...extra,
  });
  /** `hours` at whatever rate makes it come to `dollars`. */
  const work = (id, pid, hours, dollars) => ({
    id, projectId: pid, kind: "billed", taskId: null, rate: dollars / hours,
    currency: "USD", createdAt: back(5), closedAt: back(5) + hours * HOUR, deletedAt: null,
    segments: [{ startedAt: back(5), endedAt: back(5) + hours * HOUR }],
  });
  const seed = {
    projects: [project("big"), project("good"), project("blip")],
    sessions: [
      work("s1", "big", 100, 2_000), // $20/hr, most of the money
      work("s2", "good", 10, 900), // $90/hr, the best hour
      work("s3", "blip", 1, 300), // $300/hr on one hour — too little to rank
    ],
  };
  const sorters = (d) => [...d.querySelectorAll('[aria-label="Order projects by"] .seg')];
  const named = (d) => [...d.querySelectorAll(".prow-name")].map((e) => e.textContent);
  const open = async () => {
    const dom = await bootDash(seed);
    await settle();
    const d = dom.window.document;
    [...d.querySelectorAll(".dash-head .segmented .seg")].find((b) => b.textContent === "All").click();
    await settle();
    return d;
  };

  it("orders by time until asked otherwise", async () => {
    const d = await open();
    expect(named(d)[0]).toBe("big");
    expect(sorters(d).map((b) => b.textContent)).toEqual(["Time", "An hour"]);
  }, 30_000);

  it("reorders by what an hour actually paid, and says the figure", async () => {
    const d = await open();
    sorters(d).find((b) => b.textContent === "An hour").click();
    await settle();
    expect(named(d)[0]).toBe("good");
    const row = [...d.querySelectorAll(".prow")].find((r) => /good/.test(r.textContent));
    expect(row.textContent).toMatch(/\$90\.00\/hr/);
  }, 30_000);

  it("keeps a one-hour fluke out of the ranking entirely", async () => {
    // $300/hr across a single hour would sit at the top, where the eye goes.
    const d = await open();
    sorters(d).find((b) => b.textContent === "An hour").click();
    await settle();
    expect(named(d)).not.toContain("blip");
    // it is still there when ordered by time — only the RANKING excludes it
    sorters(d).find((b) => b.textContent === "Time").click();
    await settle();
    expect(named(d)).toContain("blip");
  }, 30_000);

  it("names the project most of the money rides on", async () => {
    const d = await open();
    expect(d.querySelector(".concentration").textContent).toMatch(/big/);
    expect(d.querySelector(".concentration").textContent).toMatch(/63%/); // 2000 of 3200
  }, 30_000);

  it("says nothing about concentration when the work is spread", async () => {
    const dom = await bootDash({
      projects: [project("a"), project("b"), project("c"), project("d")],
      sessions: [
        work("s1", "a", 10, 250), work("s2", "b", 10, 250),
        work("s3", "c", 10, 250), work("s4", "d", 10, 250),
      ],
    });
    await settle();
    expect(dom.window.document.querySelector(".concentration")).toBeNull();
  }, 30_000);

  it("offers no ordering choice when there is nothing to reorder", async () => {
    const dom = await bootDash({ projects: [project("a")], sessions: [work("s1", "a", 10, 100)] });
    await settle();
    expect(sorters(dom.window.document)).toHaveLength(0);
  }, 25_000);
});

describe("seeing what is running from anywhere", () => {
  const seed = {
    projects: [{
      id: "a", name: "Acme", currentRate: 60, currency: "USD", tasks: [],
      createdAt: Date.now() - 86_400_000, sessionGoal: null, overallGoal: null,
    }],
    sessions: [],
  };
  const bar = (d) => d.querySelector(".runbar");

  const startAndLeave = async () => {
    const dom = await boot(seed);
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    await startMeter(dom);
    // Back out to the list, then over to the Overview.
    btn(d, /All projects/i).click();
    await settle();
    return { dom, d };
  };

  it("shows nothing at all while nothing is running", async () => {
    const dom = await boot(seed);
    await settle();
    // Furniture that says "not tracking" earns nothing, and this sits above
    // every screen in the app.
    expect(bar(dom.window.document)).toBeNull();
  }, 25_000);

  it("follows you from the project onto other tabs", async () => {
    const { d } = await startAndLeave();
    expect(bar(d)).not.toBeNull();
    expect(bar(d).textContent).toMatch(/Acme/);

    [...d.querySelectorAll("[role=tab]")].find((t) => t.textContent === "Overview").click();
    await settle();
    expect(bar(d)).not.toBeNull();
  }, 30_000);

  it("names the money as it accrues", async () => {
    const { d } = await startAndLeave();
    expect(bar(d).querySelector(".runbar-amt")).not.toBeNull();
    expect(bar(d).querySelector(".runbar-time").textContent).toMatch(/\d\d:\d\d:\d\d/);
  }, 30_000);

  it("stops the meter from wherever you are", async () => {
    const { dom, d } = await startAndLeave();
    bar(d).querySelector(".runbar-stop").click();
    await settle();
    expect(bar(d)).toBeNull();
    const saved = JSON.parse(dom.window.localStorage.getItem("meter:v1"));
    expect(saved.sessions[0].closedAt).not.toBeNull();
  }, 30_000);

  it("takes you to the project it belongs to", async () => {
    const { d } = await startAndLeave();
    bar(d).querySelector(".runbar-what").click();
    await settle();
    expect(btn(d, /All projects/i)).toBeTruthy();
  }, 30_000);

  it("quotes no money on idle time, which is not earnings", async () => {
    const dom = await boot(seed);
    await settle();
    const d = dom.window.document;
    await toProjects(d, "Work");
    d.querySelector(".card").click();
    await settle();
    await startMeter(dom, { idle: true });
    btn(d, /All projects/i).click();
    await settle();
    expect(bar(d).querySelector(".runbar-amt")).toBeNull();
    expect(bar(d).textContent).toMatch(/idle/i);
  }, 30_000);
});
