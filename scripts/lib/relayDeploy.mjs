/**
 * Logic of `npm run relay:deploy`: the whole first deploy of the relay in one
 * command, so the owner types one line instead of six and never handles a
 * secret by hand.
 *
 * Every outside effect is injected (`run` for wrangler, `fetch` for the relay,
 * `log` for the terminal, `sleep`), so a test can drive the whole sequence
 * without a network, a Cloudflare account or wrangler.
 *
 * What it does, in order, and why that order:
 *
 *  1. Secrets: made once by relay:init's `ensureConfig` into the git-ignored
 *     relay/.admin.json, and reused on every later run (new ones would orphan
 *     every vault).
 *  2. Sign-in: `wrangler whoami`, and `wrangler login` only when that says this
 *     machine is not signed in. The login is a browser approval by the owner of
 *     his own account; this only starts it.
 *  3. Deploy, reading the relay's address from what wrangler prints.
 *  4. Both secrets handed to wrangler on standard input, written by this
 *     process with no trailing newline. Not a shell pipe: PowerShell re-encodes
 *     piped text and can add a newline, which would become part of the secret.
 *  5. The address saved for relay:admin, then a stats call, retried for a while
 *     because a secret takes a few seconds to reach the Worker.
 *
 * It never prints a secret, and a step that fails stops the run with what to do
 * next. Running it again is safe: it redeploys and re-sends the same secrets.
 */
import { CONFIG_PATH, ensureConfig } from "./relayInit.mjs";
import { createAdminClient } from "./relayAdmin.mjs";

export const WRANGLER_CONFIG = ["--config", "relay/wrangler.toml"];

/** The workers.dev address in wrangler's deploy output, or null. */
export const relayUrlIn = (text) => {
  const found = String(text ?? "").match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/i);
  return found ? found[0].toLowerCase() : null;
};

/** Whether `wrangler whoami` output says this machine is signed in. */
export const signedIn = (text) => !/not authenticated|not logged in|wrangler login/i.test(String(text ?? ""));

/**
 * @param run   `(args, { input, capture }) => Promise<{ code, output }>` runs
 *              `npx wrangler <args>`; `input` goes to its stdin, `capture` keeps
 *              its output (it is shown to the owner either way).
 * @param fs    as relay:init's.
 */
export async function deployRelay({ run, fs, fetch, log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), random }) {
  const fail = (step, hint) => {
    const e = new Error(`${step} did not succeed. ${hint}`);
    e.step = step;
    throw e;
  };

  log("1/5  Secrets");
  const { created, config } = ensureConfig({ fs, random });
  log(created
    ? `     Made new ones in ${CONFIG_PATH} (git-ignored). Keep a copy of that file in a password manager.`
    : `     Using the ones already in ${CONFIG_PATH}.`);

  log("2/5  Cloudflare sign-in");
  const who = await run(["whoami"], { capture: true });
  if (who.code !== 0 || !signedIn(who.output)) {
    log("     Not signed in on this machine: a browser window will open for you to approve.");
    const login = await run(["login"], {});
    if (login.code !== 0) fail("Signing in", "Run it again and approve the request in the browser.");
  } else {
    log("     Already signed in.");
  }

  log("3/5  Deploying");
  const deployed = await run(["deploy", ...WRANGLER_CONFIG], { capture: true });
  if (deployed.code !== 0) {
    fail("Deploying", "Read wrangler's message above. If it mentions the compatibility date or new_sqlite_classes, send it over.");
  }
  const url = relayUrlIn(deployed.output) ?? config.url;
  if (!url) fail("Finding the relay's address", "Wrangler printed no workers.dev address; check the Workers & Pages dashboard and run `npm run relay:admin -- set-url <address>`.");
  log(`     Live at ${url}`);

  log("4/5  Handing the secrets to Cloudflare");
  for (const [name, key] of [["ROUTE_KEY", "routeKey"], ["ADMIN_TOKEN", "adminToken"]]) {
    const put = await run(["secret", "put", name, ...WRANGLER_CONFIG], { input: config[key] });
    if (put.code !== 0) fail(`Setting ${name}`, "Run `npm run relay:deploy` again; it re-sends the same secrets.");
    log(`     ${name} set.`);
  }

  log("5/5  Checking");
  ensureConfig({ fs, url });
  const admin = createAdminClient({ fetch, url, token: config.adminToken });
  let last = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const stats = await admin.stats();
      log(`     The relay answers, and admin access works. Accounts: ${stats.vaults.count} of ${stats.vaults.max}.`);
      return { url, created };
    } catch (e) {
      last = e;
      await sleep(4000);
    }
  }
  return fail("Checking the relay", `It did not answer admin requests (${last?.message ?? "no answer"}). Wait a minute and run \`npm run relay:admin -- stats\`.`);
}
