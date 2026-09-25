/**
 * Captures the README's screenshots and GIF from the built app.
 *
 * Screenshots rot. Every one in a README is a claim about what the app looks
 * like today, and the only way that claim stays true is if regenerating them
 * costs one command. So this drives the real built file in a real Chrome over
 * the DevTools protocol, rather than leaving a folder of images somebody once
 * took by hand and will never take again.
 *
 * Two things it deliberately does not do:
 *
 * - It never touches your ledger. Chrome runs against a throwaway profile in a
 *   temp directory, so the storage it seeds belongs to a different profile as
 *   well as a different origin from the one you actually work in.
 * - It never uses your data. The fixture is `docs/demo-seed.json`, which is
 *   invented: no real client, no real rate.
 *
 * No dependencies — Node's global WebSocket speaks CDP, and Windows ships a
 * Chrome. `--probe` dumps what is on screen instead of capturing, which is how
 * you fix a selector after the UI moves.
 */
/* eslint-disable no-console -- capture progress is the point */
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "docs", "images");
const SERVE = join(ROOT, "dist", "web");
const PROBE = process.argv.includes("--probe");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7);

const PORT = 47931;
const DEBUG_PORT = 47932;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".json": "application/json",
  ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml",
};

const CHROMES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── the app, on an origin ────────────────────────────────────────────────── */

const serve = () => new Promise((resolve) => {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const file = join(SERVE, path === "/" ? "index.html" : path);
    try {
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404).end("no");
    }
  });
  server.listen(PORT, "127.0.0.1", () => resolve(server));
});

/* ── a browser, talking CDP ───────────────────────────────────────────────── */

async function attach() {
  const exe = CHROMES.find((path) => {
    try { readFileSync(path, { flag: "r" }); return true; } catch { return false; }
  });
  if (!exe) throw new Error("No Chrome or Edge found in the usual places.");

  const profile = mkdtempSync(join(tmpdir(), "meter-shots-"));
  const chrome = spawn(exe, [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--hide-scrollbars", "--force-color-profile=srgb",
    "about:blank",
  ], { stdio: "ignore" });

  let target = null;
  for (let tries = 0; tries < 100 && !target; tries++) {
    await sleep(100);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find((t) => t.type === "page");
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error("Chrome never opened a debuggable page.");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => {
    ws.onopen = ok;
    ws.onerror = () => no(new Error("CDP socket failed"));
  });

  let id = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    const seat = waiting.get(msg.id);
    if (!seat) return;
    waiting.delete(msg.id);
    if (msg.error) seat.no(new Error(msg.error.message));
    else seat.ok(msg.result);
  };
  const send = (method, params = {}) => new Promise((ok, no) => {
    const mine = ++id;
    waiting.set(mine, { ok, no });
    ws.send(JSON.stringify({ id: mine, method, params }));
  });

  const close = () => {
    ws.close();
    chrome.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* it's a temp dir */ }
  };

  return { send, close };
}

/* ── driving the page ─────────────────────────────────────────────────────── */

const page = (cdp) => {
  const evaluate = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? "the page threw");
    }
    return r.result.value;
  };

  /** Polls rather than listening, because "the app has finished rendering" is
   *  not an event Chrome can report — only the app knows, by what is on screen. */
  const until = async (expression, what, ms = 8000) => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await sleep(100);
    }
    throw new Error(`Gave up waiting for ${what}`);
  };

  /** Clicks by what a control says rather than where it sits: the words are the
   *  part of the UI a screenshot recipe should be allowed to depend on. */
  const click = async (selector, text = null) => {
    const found = await evaluate(`(() => {
      const all = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const want = ${JSON.stringify(text)};
      const hit = want === null
        ? all[0]
        : all.find((e) => e.textContent.trim() === want) ?? all.find((e) => e.textContent.includes(want));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    if (!found) throw new Error(`Nothing matching ${selector}${text ? ` saying "${text}"` : ""}`);
    await sleep(350);
  };

  const viewport = (width, height, scale = 2, mobile = false) =>
    cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile });

  const shot = async (file, clip = null) => {
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png", optimizeForSpeed: false, ...(clip ? { clip: { ...clip, scale: 2 } } : {}),
    });
    const bytes = Buffer.from(data, "base64");
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, file), bytes);
    console.log(`  ${file}  ${Math.round(bytes.length / 1024)} KB`);
  };

  const rect = (selector) => evaluate(`(() => {
    const e = document.querySelector(${JSON.stringify(selector)});
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  })()`);

  /** Brings a section heading to the top of the shot. The interesting part of a
   *  long screen is rarely the part that happens to be above the fold. */
  const scrollToText = async (text, above = 24) => {
    // Reports what it did find, because the failure that matters here is a
    // heading the UI has since reworded, and the new wording is the fix.
    const headings = await evaluate(`(() => {
      const want = ${JSON.stringify(text)}.toLowerCase();
      const all = [...document.querySelectorAll(".eyebrow, .sec-head, h2, h3")];
      const head = all.find((e) => e.textContent.trim().toLowerCase().startsWith(want));
      if (head) {
        const box = head.getBoundingClientRect();
        window.scrollTo({ top: window.scrollY + box.top - ${above}, behavior: "instant" });
        return null;
      }
      return all.map((e) => e.textContent.trim().slice(0, 40));
    })()`);
    if (headings) {
      throw new Error(`No heading starts "${text}". On screen: ${headings.join(" | ")}`);
    }
    await sleep(400);
  };

  return { evaluate, until, click, viewport, shot, rect, scrollToText, cdp };
};

/* ── the fixture ──────────────────────────────────────────────────────────── */

/** Every timestamp in the seed, rewritten by `edit`. */
const walkStamps = (node, edit) => {
  if (Array.isArray(node)) return node.forEach((n) => walkStamps(n, edit));
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "number" && value > 1e12) edit(node, key, value);
      else walkStamps(value, edit);
    }
  }
};

/**
 * Slides the invented ledger forward so its last day is today.
 *
 * The seed was written on a fixed date. Left alone, every window the Overview
 * can show would be empty by now, and the screenshots would advertise an app
 * with no data in it.
 */
function rebased({ running = null } = {}) {
  const seed = JSON.parse(readFileSync(join(ROOT, "docs", "demo-seed.json"), "utf8"));
  const stamps = [];
  walkStamps(seed, (_node, _key, value) => stamps.push(value));

  // Land the last recorded moment at lunchtime today: late enough that Today
  // has hours in it, early enough that it does not read as happening right now.
  const lunch = new Date();
  lunch.setHours(13, 20, 0, 0);
  const shift = lunch.getTime() - Math.max(...stamps);
  walkStamps(seed, (node, key, value) => { node[key] = value + shift; });

  // Staging, not faking: the nudge is telling the truth about a fixture nobody
  // has ever exported, and it is the first thing in every shot. A real user who
  // has taken one backup does not see it, so neither should the README.
  seed.lastBackupAt = Date.now();

  if (running) seed.sessions.push(liveSession(seed, running));
  return seed;
}

/**
 * A session that is running right now, as the stored shape rather than as a
 * sequence of clicks.
 *
 * Clicking Start and waiting is the honest way to get a live meter, and it
 * yields `$0.01` — which says nothing about what the app is for. Writing the
 * session that the click would have produced, with its start pushed back, is
 * the same record the app would have made, minus the wait.
 */
function liveSession(seed, { project: name, minutes, taskId = null }) {
  const project = seed.projects.find((p) => p.name === name);
  if (!project) throw new Error(`No project called ${name} in the seed`);
  const now = Date.now();
  const startedAt = now - minutes * 60_000;
  return {
    id: "live", projectId: project.id, kind: "billed", taskId,
    rate: project.currentRate, currency: project.currency,
    createdAt: startedAt, closedAt: null, deletedAt: null,
    // `lastTick` is the proof-of-life the crash guard looks for. Without a
    // fresh one the app would greet the shot with a recovery prompt.
    segments: [{ startedAt, endedAt: null, lastTick: now }],
  };
}

const seedInto = async (p, { theme = "light", period = "week", running = null } = {}) => {
  await p.cdp.send("Page.navigate", { url: ORIGIN });
  await sleep(500);
  await p.evaluate(`(() => {
    localStorage.setItem("meter:v1", ${JSON.stringify(JSON.stringify(rebased({ running })))});
    localStorage.setItem("meter:theme", ${JSON.stringify(theme)});
    localStorage.setItem("meter:period", ${JSON.stringify(period)});
    return true;
  })()`);
  await p.cdp.send("Page.navigate", { url: ORIGIN });
  await p.until(`document.querySelector(".wrap")`, "the app to render");
  await sleep(900); // webfonts, and the first chart paint

  // Finding a meter already running at boot always raises a banner — a stale
  // heartbeat means a crash, a fresh one means a second tab — and there is no
  // seed that avoids both. So answer it the way the person sitting there would,
  // and photograph the screen they actually work on.
  if (running && await p.evaluate(`Boolean([...document.querySelectorAll("button")]
        .find((b) => b.textContent.trim() === "This tab only"))`)) {
    await p.click("button", "This tab only");
    await sleep(300);
  }
};

/** Work tab, then into a named project, stopping on its meter face. */
async function openProject(p, name) {
  await p.click("nav.tabs button.tab", "Work");
  await p.until(`document.querySelector("button.card")`, "the project list");
  await p.click("button.card", name);
  await p.until(`document.querySelector(".face")`, "the meter face");
}

/* ── what to capture ──────────────────────────────────────────────────────── */

/** The meter that every shot but the Overview is taken against. */
const RUNNING = { project: "search-ranking", minutes: 47, taskId: "t3" };

const SHOTS = {
  async overview(p) {
    await p.viewport(900, 1100);
    await seedInto(p, { period: "month" });
    await p.shot("overview.png");
  },

  /**
   * A project that is not paid by the hour.
   *
   * `annotation-queue` bills nothing per hour and $42 an accepted item, with
   * one task priced at $9 instead. The frame runs from its header — which
   * quotes a price, not a rate — into the first accepted items, because that
   * pairing is the whole model. Scrolling further only finds more rows saying
   * the same thing.
   */
  async project(p) {
    await p.viewport(900, 940);
    await seedInto(p);
    await openProject(p, "annotation-queue");
    await p.shot("project.png");
  },

  /** Every project at once: rate, hours, what each has made. */
  async projects(p) {
    await p.viewport(900, 820);
    await seedInto(p, { running: RUNNING });
    await p.click("nav.tabs button.tab", "Work");
    await p.until(`document.querySelector("button.card")`, "the project list");
    await p.shot("projects.png");
  },

  async phone(p) {
    await p.viewport(414, 860, 3, true);
    await seedInto(p, { running: RUNNING });
    await p.shot("phone.png");
  },
};

/** The one thing a still cannot show: that the money moves. */
async function gif(p) {
  await p.viewport(900, 1200);
  await seedInto(p, { running: RUNNING });
  await openProject(p, "search-ranking");

  const face = await p.rect(".face");
  const bar = await p.rect(".runbar");
  const top = Math.min(face.y, bar.y);
  const clip = {
    x: Math.min(face.x, bar.x) - 8,
    y: top - 8,
    width: Math.max(face.width, bar.width) + 16,
    height: (face.y + face.height) - top + 16,
  };

  const frames = mkdtempSync(join(tmpdir(), "meter-gif-"));
  console.log("  capturing 20 frames…");
  for (let i = 0; i < 20; i++) {
    const { data } = await p.cdp.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 1 } });
    writeFileSync(join(frames, `f${String(i).padStart(3, "0")}.png`), Buffer.from(data, "base64"));
    await sleep(500);
  }

  mkdirSync(OUT, { recursive: true });
  const out = join(OUT, "running.gif");
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-framerate", "4", "-i", join(frames, "f%03d.png"),
    "-vf", "split[a][b];[a]palettegen=max_colors=48[p];[b][p]paletteuse=dither=none", out,
  ], { stdio: "inherit" });
  rmSync(frames, { recursive: true, force: true });
  console.log(`  running.gif  ${Math.round(readFileSync(out).length / 1024)} KB`);
}

/* ── or just tell me what is on screen ────────────────────────────────────── */

async function probe(p) {
  await p.viewport(900, 1180);
  await seedInto(p);
  const look = async (label) => {
    const info = await p.evaluate(`(() => ({
      tabs: [...document.querySelectorAll("nav.tabs button")].map((b) => b.textContent.trim()),
      cards: [...document.querySelectorAll("button.card")].map((b) => b.textContent.trim().slice(0, 44)),
      buttons: [...document.querySelectorAll("button.btn")].map((b) => b.textContent.trim()),
      prompt: document.querySelector(".prompt")?.textContent.trim().slice(0, 200) ?? null,
      runbar: document.querySelector(".runbar")?.textContent.trim() ?? null,
      face: document.querySelector(".face")?.textContent.trim().slice(0, 140) ?? null,
      height: document.querySelector(".wrap")?.scrollHeight ?? null,
    }))()`);
    console.log(`\n── ${label} ──`);
    console.log(JSON.stringify(info, null, 1));
  };
  await look("overview");
  await p.click("nav.tabs button.tab", "Work");
  await look("work");
  await p.click("button.card", "search-ranking");
  await look("a project");
  await p.click(".btn.primary", "Start the meter");
  await look("after Start");
}

/* ── run ──────────────────────────────────────────────────────────────────── */

const server = await serve();
const cdp = await attach();
const p = page(cdp);
try {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Africa/Cairo" });

  if (PROBE) {
    await probe(p);
  } else {
    for (const [name, take] of Object.entries(SHOTS)) {
      if (ONLY && ONLY !== name) continue;
      console.log(`${name}:`);
      await take(p);
    }
    if (!ONLY || ONLY === "gif") {
      console.log("gif:");
      await gif(p);
    }
  }
} finally {
  cdp.close();
  server.close();
}
console.log("\nDone.");
process.exit(0);
