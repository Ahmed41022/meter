/**
 * Bundles React + the app into ONE self-contained HTML file. No CDN, no
 * install step, no server required — the whole deliverable is one document.
 */
/* eslint-disable no-console -- build output is the point */
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const asset = (p) => join(root, "assets", p);
const b64 = async (p) => (await readFile(asset(p))).toString("base64");

const result = await build({
  entryPoints: [join(root, "src/main.jsx")],
  bundle: true,
  minify: true,
  jsx: "automatic",
  format: "iife",
  target: ["chrome100", "firefox100", "safari15"],
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
});
const js = result.outputFiles[0].text;

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
<meta name="theme-color" content="#F1F3EF">
<title>Meter</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${svg}">
<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,${await b64("icon-32.png")}">
<link rel="apple-touch-icon" sizes="180x180" href="data:image/png;base64,${await b64("icon-180.png")}">
<link rel="manifest" href="data:application/manifest+json;base64,${manifest}">
<style>html,body{margin:0;padding:0;background:#F1F3EF;}#root{min-height:100vh;}</style>
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
