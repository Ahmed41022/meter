/**
 * The hosted copy of the app.
 *
 * A phone cannot run the single-file build: storage is blocked on file://, and a
 * service worker has to be a separate same-origin script, so offline use is
 * impossible from one document. These assertions guard the things that silently
 * stop a web app being installable or updatable — a manifest that cannot
 * resolve its own start_url, a worker that pins one build forever.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = (p) => join(root, "dist/web", p);
const read = (p) => readFileSync(web(p), "utf8");

beforeAll(() => {
  if (!existsSync(web("index.html"))) {
    throw new Error("dist/web is missing — run `npm run build` first");
  }
  const src = statSync(join(root, "src/ui/App.jsx")).mtimeMs;
  if (statSync(web("index.html")).mtimeMs < src) {
    throw new Error("dist/web is older than src — run `npm run build`");
  }
});

describe("what gets published", () => {
  it("ships every file the page and the manifest reference", () => {
    for (const f of ["index.html", "manifest.webmanifest", "sw.js",
      "icon.svg", "icon-32.png", "icon-180.png", "icon-192.png", "maskable-512.png"]) {
      expect(existsSync(web(f)), `${f} is missing`).toBe(true);
    }
  });

  it("links a real manifest file rather than a data: URI", () => {
    // A relative start_url inside a data: URI has no base to resolve against,
    // which is why the single-file build has to omit start_url entirely.
    expect(read("index.html")).toContain('<link rel="manifest" href="manifest.webmanifest">');
    expect(read("index.html")).not.toMatch(/rel="manifest"[^>]*data:/);
  });

  it("keeps every path relative, so it works under a repo subdirectory", () => {
    // A project's Pages site lives at /<repo>/, not at the domain root. One
    // leading slash and every icon 404s.
    const m = JSON.parse(read("manifest.webmanifest"));
    expect(m.start_url).toBe("./");
    expect(m.scope).toBe("./");
    for (const icon of m.icons) expect(icon.src.startsWith("/")).toBe(false);
    expect(read("index.html")).not.toMatch(/(href|src)="\/[^/]/);
  });

  it("offers the two icon sizes and the maskable shape an install needs", () => {
    const m = JSON.parse(read("manifest.webmanifest"));
    expect(m.icons.map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    expect(m.icons.some((i) => i.purpose.includes("maskable"))).toBe(true);
    expect(m.display).toBe("standalone");
    expect(m.name).toBe("Meter");
  });

  it("leaves the single-file build alone", () => {
    // It is still what you double-click and what Electron packages.
    const single = readFileSync(join(root, "dist/meter.html"), "utf8");
    expect(single).toMatch(/rel="manifest" href="data:application\/manifest\+json/);
    expect(single).not.toContain("serviceWorker");
  });
});

describe("the service worker", () => {
  const sw = () => read("sw.js");

  it("goes to the network first, so a deploy is never pinned", () => {
    // Cache-first would serve whichever build a phone happened to install and
    // keep serving it after every deploy. That is what makes people uninstall.
    expect(sw()).toMatch(/respondWith\(\s*fetch\(/);
  });

  it("falls back to the cache, so an offline phone still opens", () => {
    expect(sw()).toMatch(/\.catch\(\(\) => caches\.match/);
  });

  it("precaches the shell and the icons", () => {
    expect(sw()).toContain('"./"');
    expect(sw()).toContain("manifest.webmanifest");
    expect(sw()).toContain("maskable-512.png");
  });

  it("takes over at once and sweeps older caches", () => {
    expect(sw()).toContain("skipWaiting");
    expect(sw()).toContain("clients.claim");
    expect(sw()).toMatch(/caches\.delete/);
  });

  it("is keyed to the build, so the cache turns over when the app changes", () => {
    const version = sw().match(/const CACHE = "meter-([0-9a-f]+)"/);
    expect(version).not.toBeNull();
    expect(version[1]).toHaveLength(12);
  });

  it("never tries to cache a write", () => {
    expect(sw()).toMatch(/method !== "GET"/);
  });

  it("is valid JavaScript", () => {
    // It is served as-is and never bundled, so nothing else would catch a typo.
    expect(() => new Function(sw())).not.toThrow();
  });
});

describe("the published page actually runs", () => {
  it("boots and renders the app", async () => {
    const dom = new JSDOM(read("index.html"), {
      runScripts: "dangerously", pretendToBeVisual: true, url: "https://example.github.io/meter/",
    });
    await new Promise((r) => setTimeout(r, 400));
    const d = dom.window.document;
    expect(d.getElementById("root").children.length).toBeGreaterThan(0);
    expect([...d.querySelectorAll(".dash-head .segmented .seg")].map((b) => b.textContent))
      .toEqual(["Day", "Week", "Month", "Year", "All"]);
  }, 25_000);

  it("registers the worker without breaking a browser that has none", async () => {
    // jsdom implements no serviceWorker, so this page boots through the guard.
    const dom = new JSDOM(read("index.html"), {
      runScripts: "dangerously", pretendToBeVisual: true, url: "https://example.github.io/meter/",
    });
    expect(dom.window.navigator.serviceWorker).toBeUndefined();
    await new Promise((r) => setTimeout(r, 400));
    expect(dom.window.document.getElementById("root").children.length).toBeGreaterThan(0);
  }, 25_000);

  it("pays back the safe-area insets it opts into", async () => {
    // viewport-fit=cover puts the notch and the gesture bar over the content
    // unless the padding accounts for them.
    const html = read("index.html");
    expect(html).toContain("viewport-fit=cover");
    expect(html).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(html).toMatch(/env\(safe-area-inset-top\)/);
  });
});
