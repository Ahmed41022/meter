/**
 * Logic of `npm run relay:init`, apart from the terminal and the disk (both are
 * injected), so a test can run it without touching either.
 *
 * What it does and does not do. It makes the two secrets the Worker needs and
 * writes the exact commands the owner runs. It never runs wrangler: logging in
 * and deploying are the owner's act on the owner's Cloudflare account.
 *
 * Where the secrets go, and why:
 *
 *  - ROUTE_KEY and ADMIN_TOKEN are written ONCE to `relay/.admin.json`, a
 *    git-ignored file, and printed NOWHERE. The commands below read them from it
 *    through a pipe (`--emit`), so a secret is never on the screen, in the shell
 *    history or in the scrollback, which printing it for copy-and-paste would
 *    put it in all three.
 *  - The admin CLI needs the token on every run. Asking the owner to keep it in
 *    a password manager and paste it each time would put it in shell history
 *    (as METER_ADMIN_TOKEN=...) far more often than a local file does, on a
 *    machine whose ledger is already plain text in the browser's storage. The
 *    owner may still copy the file's contents into a password manager as a
 *    backup; nothing here forbids it.
 *  - ROUTE_KEY is kept in the same file for one reason: Cloudflare will not show
 *    a secret again, and a Worker redeployed to a new account needs the SAME
 *    ROUTE_KEY or every vault id the old one signed stops working.
 *  - Nothing is ever written anywhere that is committed (a test pins that the
 *    path is ignored by .gitignore).
 *
 * Running it twice does not make new secrets: new ones would orphan every
 * vault. `--force` is the explicit, scary way.
 */

export const CONFIG_PATH = "relay/.admin.json";
export const SECRET_NAMES = { ROUTE_KEY: "routeKey", ADMIN_TOKEN: "adminToken" };

/** The Worker's own rules (relay/util.js bearerOf, relay/ids.js): the token is
 *  base64url, ROUTE_KEY is any 16+ characters. Both are made here as 32 random
 *  bytes, 43 base64url characters, which satisfies both with room to spare. */
export const isStrongSecret = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{32,200}$/.test(s);

export const randomSecret = (random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) =>
  Buffer.from(random(32)).toString("base64url");

/**
 * @param fs  `{ exists(path), read(path), write(path, text) }`
 * @returns   `{ created, config }`. When a file is already there it is read and
 *            returned unchanged (`created: false`).
 */
export function ensureConfig({ fs, random, url = null, force = false, path = CONFIG_PATH }) {
  if (fs.exists(path) && !force) {
    const config = JSON.parse(fs.read(path));
    if (!isStrongSecret(config.routeKey) || !isStrongSecret(config.adminToken)) {
      throw new Error(`${path} exists but its secrets are missing or too weak. Fix it by hand, or run again with --force to replace it (this orphans vaults already made).`);
    }
    // A URL given now is the one the owner just learnt from wrangler: keep it.
    if (url && config.url !== url) {
      config.url = url;
      fs.write(path, `${JSON.stringify(config, null, 2)}\n`);
    }
    return { created: false, config };
  }
  const config = { version: 1, url, adminToken: randomSecret(random), routeKey: randomSecret(random) };
  fs.write(path, `${JSON.stringify(config, null, 2)}\n`);
  return { created: true, config };
}

/** The raw value of one secret, for a pipe. No newline: a trailing one would
 *  become part of the secret in anything that reads stdin literally. */
export function emitSecret({ fs, name, path = CONFIG_PATH }) {
  const key = SECRET_NAMES[name];
  if (!key) throw new Error(`--emit takes ROUTE_KEY or ADMIN_TOKEN, not "${name}".`);
  if (!fs.exists(path)) throw new Error(`${path} does not exist yet. Run npm run relay:init first.`);
  const value = JSON.parse(fs.read(path))[key];
  if (!isStrongSecret(value)) throw new Error(`${path} has no usable ${name}.`);
  return value;
}

const WRANGLER = "--config relay/wrangler.toml";

/** The text the owner follows. Contains no secret. */
export function renderSteps({ created, path = CONFIG_PATH, url = null }) {
  const lines = [];
  const say = (s = "") => lines.push(s);
  say(created
    ? `Made a ROUTE_KEY and an ADMIN_TOKEN and saved them in ${path}.`
    : `${path} already exists, so nothing new was made (new secrets would orphan every vault).`);
  say("That file is ignored by git. Neither secret is printed here, and the commands below send them straight to Cloudflare.");
  say();
  say("Run these in order, from the repository root. Nothing here needs more than a free Cloudflare account.");
  say();
  say("1. Log in to Cloudflare (opens a browser):");
  say("     npx wrangler login");
  say();
  say("2. Deploy the Worker. It prints your address, https://meter-sync.<your-name>.workers.dev:");
  say(`     npx wrangler deploy ${WRANGLER}`);
  say();
  say("3. Give it the vault-id signing key. The pipe reads the value from the file, so it is never typed or shown:");
  say(`     node scripts/relay-init.mjs --emit ROUTE_KEY | npx wrangler secret put ROUTE_KEY ${WRANGLER}`);
  say();
  say("4. Give it the admin token the same way:");
  say(`     node scripts/relay-init.mjs --emit ADMIN_TOKEN | npx wrangler secret put ADMIN_TOKEN ${WRANGLER}`);
  say();
  say("5. Tell the admin tool where the relay is (use the address step 2 printed):");
  say(`     npm run relay:admin -- set-url ${url ?? "https://meter-sync.<your-name>.workers.dev"}`);
  say();
  say("6. Check it works, then make your first invite:");
  say("     npm run relay:admin -- stats");
  say('     npm run relay:admin -- invite --label "me"');
  say();
  say("Notes:");
  say("  - Piping into `wrangler secret put` is how wrangler's documentation sets secrets in scripts, but this");
  say("    was not run here: UNVERIFIED. If step 3 or 4 asks \"Enter a secret value:\" anyway, open the file,");
  say("    copy the matching value and paste it there (the prompt hides it); it still never reaches shell history.");
  say("  - Between steps 2 and 4 the Worker is live without its secrets and refuses everything: harmless. If you");
  say("    called the relay in that window, run step 2 again after step 4.");
  say("  - Do not run `relay:init --force` on a relay that has vaults: a new ROUTE_KEY makes every existing");
  say("    vault id invalid. Keep a copy of the file (for example in a password manager).");
  return lines;
}
