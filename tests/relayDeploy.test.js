/**
 * `npm run relay:deploy`, driven end to end with wrangler played by a fake: it
 * "deploys" by printing an address, and "puts a secret" by setting it on the
 * in-process Worker, so the final check talks to a relay running on exactly
 * the secrets the deploy handed over. No network, no wrangler, no account.
 */
import { describe, it, expect } from "vitest";
import { deployRelay, relayUrlIn, signedIn } from "../scripts/lib/relayDeploy.mjs";
import { CONFIG_PATH } from "../scripts/lib/relayInit.mjs";
import { world } from "./relayWorld.js";
import { RELAY_URL } from "./relayShim.js";

const memoryFs = (files = {}) => ({
  exists: (p) => p in files,
  read: (p) => files[p],
  write: (p, text) => { files[p] = text; },
  files,
});

/** Wrangler as the deploy sees it. `env` is the Worker's; a secret put lands in it. */
const fakeWrangler = (w, { loggedIn = true, deployOutput = `Deployed meter-sync\n  ${RELAY_URL}\nCurrent Version ID: x`, failOn = null } = {}) => {
  const calls = [];
  const run = async (args, { input } = {}) => {
    calls.push({ args, input });
    const [cmd, , name] = args;
    if (failOn === cmd) return { code: 1, output: "boom" };
    if (cmd === "whoami") return { code: 0, output: loggedIn ? "You are logged in with an OAuth Token" : "You are not authenticated. Please run `wrangler login`." };
    if (cmd === "login") return { code: 0, output: "" };
    if (cmd === "deploy") return { code: 0, output: deployOutput };
    if (cmd === "secret") {
      w.env[name] = input;
      return { code: 0, output: "" };
    }
    return { code: 1, output: "unknown" };
  };
  return { run, calls };
};

const quiet = () => {};
const noSleep = async () => {};

describe("relay:deploy", () => {
  it("makes the secrets, deploys, hands them over unprinted, and checks admin access", async () => {
    const w = world({ ROUTE_KEY: "", ADMIN_TOKEN: "" });
    const { run, calls } = fakeWrangler(w);
    const fs = memoryFs();
    const lines = [];
    const out = await deployRelay({ run, fs, fetch: w.fetch, log: (l) => lines.push(l), sleep: noSleep });

    expect(out.url).toBe(RELAY_URL);
    const saved = JSON.parse(fs.read(CONFIG_PATH));
    expect(saved.url).toBe(RELAY_URL);
    // The Worker runs on exactly the saved secrets, given on stdin, never as arguments.
    expect(w.env.ROUTE_KEY).toBe(saved.routeKey);
    expect(w.env.ADMIN_TOKEN).toBe(saved.adminToken);
    for (const c of calls) expect(c.args.join(" ")).not.toMatch(new RegExp(`${saved.routeKey}|${saved.adminToken}`));
    expect(calls.map((c) => c.args[0])).toEqual(["whoami", "deploy", "secret", "secret"]);
    // Nothing printed carries a secret.
    const text = lines.join("\n");
    expect(text).not.toContain(saved.adminToken);
    expect(text).not.toContain(saved.routeKey);
    expect(text).toMatch(/Accounts: 0 of/);
  });

  it("signs in only when this machine is not signed in", async () => {
    const w = world({ ROUTE_KEY: "", ADMIN_TOKEN: "" });
    const { run, calls } = fakeWrangler(w, { loggedIn: false });
    await deployRelay({ run, fs: memoryFs(), fetch: w.fetch, log: quiet, sleep: noSleep });
    expect(calls.map((c) => c.args[0])).toEqual(["whoami", "login", "deploy", "secret", "secret"]);
  });

  it("reuses the secrets on a second run, so existing vaults keep working", async () => {
    const w = world({ ROUTE_KEY: "", ADMIN_TOKEN: "" });
    const fs = memoryFs();
    await deployRelay({ run: fakeWrangler(w).run, fs, fetch: w.fetch, log: quiet, sleep: noSleep });
    const first = JSON.parse(fs.read(CONFIG_PATH));
    await deployRelay({ run: fakeWrangler(w).run, fs, fetch: w.fetch, log: quiet, sleep: noSleep });
    const second = JSON.parse(fs.read(CONFIG_PATH));
    expect(second.routeKey).toBe(first.routeKey);
    expect(second.adminToken).toBe(first.adminToken);
  });

  it("stops at the step that failed, with what to do next", async () => {
    const w = world({ ROUTE_KEY: "", ADMIN_TOKEN: "" });
    await expect(deployRelay({ run: fakeWrangler(w, { failOn: "deploy" }).run, fs: memoryFs(), fetch: w.fetch, log: quiet, sleep: noSleep }))
      .rejects.toMatchObject({ step: "Deploying" });
    await expect(deployRelay({ run: fakeWrangler(w, { failOn: "secret" }).run, fs: memoryFs(), fetch: w.fetch, log: quiet, sleep: noSleep }))
      .rejects.toMatchObject({ step: "Setting ROUTE_KEY" });
    await expect(deployRelay({ run: fakeWrangler(w, { deployOutput: "Deployed, no address" }).run, fs: memoryFs(), fetch: w.fetch, log: quiet, sleep: noSleep }))
      .rejects.toMatchObject({ step: "Finding the relay's address" });
  });

  it("reports a relay that never answers admin requests instead of claiming success", async () => {
    const w = world({ ROUTE_KEY: "", ADMIN_TOKEN: "" });
    const { run } = fakeWrangler(w);
    // A Worker that kept an old admin token: the check must not pass.
    const stubborn = async (args, opts) => {
      const r = await run(args, opts);
      if (args[0] === "secret" && args[2] === "ADMIN_TOKEN") w.env.ADMIN_TOKEN = "x".repeat(43);
      return r;
    };
    await expect(deployRelay({ run: stubborn, fs: memoryFs(), fetch: w.fetch, log: quiet, sleep: noSleep }))
      .rejects.toMatchObject({ step: "Checking the relay" });
  });

  it("reads the address and the sign-in state from wrangler's words", () => {
    expect(relayUrlIn("Published meter-sync (1.2 sec)\n  https://Meter-Sync.ahmed.workers.dev\n")).toBe("https://meter-sync.ahmed.workers.dev");
    expect(relayUrlIn("no address here")).toBeNull();
    expect(signedIn("You are logged in with an OAuth Token, associated with the email x")).toBe(true);
    expect(signedIn("You are not authenticated. Please run `wrangler login`.")).toBe(false);
  });
});
