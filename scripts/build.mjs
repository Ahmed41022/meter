/**
 * Bundles React + the app, twice, from one compile.
 *
 *   dist/meter.html   ONE self-contained file. No CDN, no install step, no
 *                     server. This is what you double-click and what the
 *                     Electron build packages, and it stays a single document.
 *
 *   dist/web/         The same app as a small site, for hosting. A phone needs
 *                     a real origin: storage is blocked on file://, and a
 *                     service worker has to be a separate same-origin script,
 *                     so offline use is impossible from a single document. The
 *                     manifest becomes a real file too, which is what lets
 *                     `start_url` work — a relative path inside a data: URI has
 *                     no base to resolve against.
 */
/* eslint-disable no-console -- build output is the point */
import { build } from "esbuild";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** One version, from one place, for all three builds. The app shows it, the
 *  release is tagged with it, and the changelog explains it. */
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const asset = (p) => join(root, "assets", p);
const b64 = async (p) => (await readFile(asset(p))).toString("base64");

const result = await build({
  entryPoints: [join(root, "src/main.jsx")],
  bundle: true,
  minify: true,
  jsx: "automatic",
  format: "iife",
  target: ["chrome100", "firefox100", "safari15"],
  define: {
    "process.env.NODE_ENV": '"production"',
    __METER_VERSION__: JSON.stringify(version),
  },
  write: false,
});
const js = result.outputFiles[0].text;

/** Keyed to the bundle, so a deploy that changes nothing does not churn the
 *  cache and one that changes anything gets a new one. */
const VERSION = createHash("sha256").update(js).digest("hex").slice(0, 12);

const svg = encodeURIComponent(await readFile(asset("icon.svg"), "utf8"));

// start_url is deliberately omitted: a relative path in a data: manifest has
// no base to resolve against and breaks installation. Omitting it makes the
// browser default to the page's own URL, which is what we want.
const manifest = Buffer.from(JSON.stringify({
  name: "Meter", short_name: "Meter", display: "standalone",
  background_color: "#F1F3EF", theme_color: "#F1F3EF",
  icons: [
    { src: `data:image/png;base64,${await b64("icon-192.png")}`, sizes: "192x192", type: "image/png", purpose: "any" },
    { src: `data:image/png;base64,${await b64("maskable-512.png")}`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
})).toString("base64");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#F1F3EF" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0E1210" media="(prefers-color-scheme: dark)">
<title>Meter</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${svg}">
<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,${await b64("icon-32.png")}">
<link rel="apple-touch-icon" sizes="180x180" href="data:image/png;base64,${await b64("icon-180.png")}">
<link rel="manifest" href="data:application/manifest+json;base64,${manifest}">
<style>html,body{margin:0;padding:0;background:#F1F3EF;color-scheme:light;}#root{min-height:100vh;}
@media (prefers-color-scheme: dark){html,body{background:#0E1210;color-scheme:dark;}}</style>
</head>
<body>
<div id="root"></div>
<script>
${js}
</script>
</body>
</html>
`;

await mkdir(join(root, "dist"), { recursive: true });
await writeFile(join(root, "dist/meter.html"), html);
console.log(`dist/meter.html  ${(html.length / 1024).toFixed(0)} KB`);

// ---------------------------------------------------------------- the web copy
const web = join(root, "dist/web");
await mkdir(web, { recursive: true });

const ICONS = ["icon.svg", "icon-32.png", "icon-180.png", "icon-192.png", "maskable-512.png"];
for (const name of ICONS) await copyFile(asset(name), join(web, name));

/** Relative, so the same files work at a domain root or under a repo path like
 *  /meter/ — which is where a project's Pages site lives. */
await writeFile(join(web, "manifest.webmanifest"), JSON.stringify({
  name: "Meter", short_name: "Meter",
  description: "An hourly earnings meter.",
  start_url: "./", scope: "./", display: "standalone",
  background_color: "#F1F3EF", theme_color: "#F1F3EF",
  icons: [
    { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "maskable-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
}, null, 2));

/**
 * Network first, cache only as a fallback.
 *
 * The whole app is one document, so a cache-first worker would pin whichever
 * version a phone happened to install and keep serving it after every deploy —
 * the failure that makes people uninstall a web app. This way an online phone
 * always runs the current build, and an offline one runs the last it saw.
 */
const sw = `const CACHE = "meter-${VERSION}";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(${JSON.stringify(["./", "./manifest.webmanifest", ...ICONS])})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request)
    .then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    })
    .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match("./"))));
});
`;
await writeFile(join(web, "sw.js"), sw);

const webHtml = html
  .replace(
    /<link rel="manifest"[^>]*>/,
    '<link rel="manifest" href="manifest.webmanifest">',
  )
  .replace("</body>", `<script>
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
</script>
</body>`);
if (webHtml === html) throw new Error("web copy: the manifest link was not replaced");
await writeFile(join(web, "index.html"), webHtml);
console.log(`dist/web/         ${(webHtml.length / 1024).toFixed(0)} KB + ${ICONS.length + 2} files`);
