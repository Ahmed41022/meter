/* eslint-disable no-console -- packaging output is the point */
/**
 * Optional Windows build. Ships its own Chromium (~220 MB) to run a 280 KB
 * HTML file — only worth it if the target machine might not have a browser.
 * Prefer the shortcut in tools/ for everyday use.
 */
import { packager } from "@electron/packager";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

await mkdir(join(here, "out"), { recursive: true });
await copyFile(join(root, "dist/meter.html"), join(here, "meter.html"));
await copyFile(join(root, "assets/meter.ico"), join(here, "meter.ico"));

const [appPath] = await packager({
  dir: here,
  out: join(here, "out"),
  platform: "win32",
  arch: "x64",
  electronVersion: "32.2.7",
  icon: join(here, "meter.ico"),
  overwrite: true,
  appVersion: "1.0.0",
  ignore: [/package\.mjs$/, /^\/out/],
  prune: true,
  win32metadata: { FileDescription: "Meter", ProductName: "Meter" },
});

console.log(`built: ${appPath}`);
