/**
 * `npm run relay:admin -- <command>`: the owner's tool for the relay. The logic
 * is in lib/relayAdmin.mjs; this file reads the address and token, asks the one
 * question a terminal can ask, and calls the real `fetch`.
 *
 * The address and token come from relay/.admin.json (made by relay:init, ignored
 * by git) and are overridden by METER_RELAY_URL and METER_ADMIN_TOKEN.
 */
/* eslint-disable no-console -- the output is the point */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { AdminError, createAdminClient, runAdmin } from "./lib/relayAdmin.mjs";
import { CONFIG_PATH } from "./lib/relayInit.mjs";

const file = join(dirname(fileURLToPath(import.meta.url)), "..", CONFIG_PATH);
const readFile = () => {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { throw new AdminError("usage", `${CONFIG_PATH} is not valid JSON.`); }
};

const makeClient = () => {
  const saved = readFile();
  const url = process.env.METER_RELAY_URL || saved.url;
  const token = process.env.METER_ADMIN_TOKEN || saved.adminToken;
  if (!url) throw new AdminError("usage", "No relay address yet. Run: npm run relay:admin -- set-url https://your-relay.workers.dev (or set METER_RELAY_URL).");
  if (!token) throw new AdminError("usage", `No admin token. Run npm run relay:init first (it makes ${CONFIG_PATH}), or set METER_ADMIN_TOKEN.`);
  return createAdminClient({ fetch: globalThis.fetch, url, token });
};

const saveUrl = (url) => {
  const saved = readFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, ...saved, url }, null, 2)}\n`, { mode: 0o600 });
};

const confirm = process.stdin.isTTY
  ? async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
  }
  : null;

process.exitCode = await runAdmin(process.argv.slice(2), {
  makeClient, out: (l) => console.log(l), err: (l) => console.error(l), confirm, saveUrl,
  appUrl: process.env.METER_APP_URL || undefined,
});
