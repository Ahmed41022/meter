/**
 * `npm run relay:deploy`: the first deploy of the relay, and any later
 * redeploy, in one command. The sequence lives in lib/relayDeploy.mjs; this
 * file only starts wrangler, talks to the terminal and touches the disk.
 *
 * Wrangler is started through npx with a shell, because on Windows `npx` is a
 * .cmd file that cannot be spawned directly. Only fixed arguments are passed to
 * it, never anything typed or read from the network. A secret travels on
 * wrangler's standard input, written here without a newline, and never appears
 * in an argument, the screen or the shell history.
 */
/* eslint-disable no-console -- the output is the point */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deployRelay } from "./lib/relayDeploy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const abs = (p) => join(root, p);
const fs = {
  exists: (p) => existsSync(abs(p)),
  read: (p) => readFileSync(abs(p), "utf8"),
  write: (p, text) => {
    mkdirSync(dirname(abs(p)), { recursive: true });
    writeFileSync(abs(p), text, { mode: 0o600 });
  },
};

/** `npx wrangler <args>`: output is shown live, and kept when asked for. */
const run = (args, { input, capture } = {}) => new Promise((resolve) => {
  const child = spawn("npx", ["--yes", "wrangler@4", ...args], {
    cwd: root,
    shell: true,
    stdio: [input === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  let output = "";
  if (capture) {
    child.stdout.on("data", (d) => { output += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { output += d; process.stderr.write(d); });
  }
  if (input !== undefined) {
    child.stdin.write(input);
    child.stdin.end();
  }
  child.on("error", (e) => resolve({ code: 1, output: `${output}\n${e.message}` }));
  child.on("close", (code) => resolve({ code: code ?? 1, output }));
});

// It takes no arguments. Anything given (a `--help`, a typo) prints what it
// does and stops, because a command that deploys should never run by accident.
if (process.argv.length > 2) {
  console.log([
    "npm run relay:deploy  (no arguments)",
    "",
    "Deploys Meter's sync relay to your Cloudflare account and sets it up:",
    "  1. makes the relay's secrets once, in relay/.admin.json (git-ignored), or reuses them",
    "  2. signs you in to Cloudflare in the browser, only if this machine is not signed in",
    "  3. deploys relay/ with wrangler",
    "  4. hands both secrets to Cloudflare (never shown, never in an argument)",
    "  5. points relay:admin at the relay and checks that admin access works",
    "Safe to run again: it redeploys with the same secrets.",
  ].join("\n"));
  process.exit(0);
}

try {
  const { url } = await deployRelay({ run, fs, fetch: globalThis.fetch, log: (l) => console.log(l) });
  console.log("");
  console.log(`Done. Your relay: ${url}`);
  console.log("Make yourself an invite with:  npm run relay:admin -- invite --label \"me\"");
} catch (e) {
  console.error("");
  console.error(e.message);
  process.exitCode = 1;
}
