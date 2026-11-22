/**
 * `npm run relay:init`: makes the relay's secrets and prints the steps to deploy
 * it. The logic is in lib/relayInit.mjs; this file only talks to the terminal
 * and the disk. It never runs wrangler.
 *
 *   node scripts/relay-init.mjs [--url https://...] [--force]
 *   node scripts/relay-init.mjs --emit ROUTE_KEY|ADMIN_TOKEN     (for a pipe)
 */
/* eslint-disable no-console -- the output is the point */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, emitSecret, ensureConfig, renderSteps } from "./lib/relayInit.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const abs = (p) => join(root, p);
const fs = {
  exists: (p) => existsSync(abs(p)),
  read: (p) => readFileSync(abs(p), "utf8"),
  write: (p, text) => {
    mkdirSync(dirname(abs(p)), { recursive: true });
    // 0600 where the platform has it; Windows ignores the mode.
    writeFileSync(abs(p), text, { mode: 0o600 });
  },
};

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

try {
  if (flag("--emit")) {
    process.stdout.write(emitSecret({ fs, name: value("--emit") }));
  } else {
    const { created, config } = ensureConfig({
      fs, url: value("--url"), force: flag("--force"),
    });
    console.log(renderSteps({ created, path: CONFIG_PATH, url: config.url }).join("\n"));
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
