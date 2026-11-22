/**
 * `relay:init` and `relay:admin` (scripts/lib), run against the real Worker in
 * process: the admin client's `fetch` is the Worker's, so nothing touches a
 * network, and the disk is an in-memory map.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { admin, request, world } from "./relayWorld.js";
import { RELAY_URL } from "./relayShim.js";
import { createLocalVault, withVaultId } from "../src/sync/vault.js";
import { registerVault } from "../src/sync/relay.js";
import { parseInvite } from "../src/sync/codes.js";
import {
  CONFIG_PATH, emitSecret, ensureConfig, isStrongSecret, randomSecret, renderSteps,
} from "../scripts/lib/relayInit.mjs";
import {
  AdminError, createAdminClient, fmtBytes, parseArgs, parseConfigPairs, runAdmin, table,
} from "../scripts/lib/relayAdmin.mjs";

const memoryFs = (files = {}) => {
  const map = new Map(Object.entries(files));
  return {
    exists: (p) => map.has(p), read: (p) => map.get(p), write: (p, t) => { map.set(p, t); }, map,
  };
};

// ======================================================================== init
describe("relay:init", () => {
  it("makes secrets the Worker accepts: base64url and 32 or more characters", () => {
    for (let i = 0; i < 20; i += 1) {
      const s = randomSecret();
      expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isStrongSecret(s)).toBe(true);
    }
    expect(randomSecret()).not.toBe(randomSecret());
    expect(isStrongSecret("short")).toBe(false);
    expect(isStrongSecret("a b".repeat(20))).toBe(false);
  });

  it("makes a relay that really runs on exactly those secrets", async () => {
    const fs = memoryFs();
    const { config } = ensureConfig({ fs });
    const w = world({ ROUTE_KEY: config.routeKey, ADMIN_TOKEN: config.adminToken });
    const client = createAdminClient({ fetch: w.fetch, url: RELAY_URL, token: config.adminToken });
    const made = await client.invite({ label: "first" });
    const local = await createLocalVault({ relay: RELAY_URL, invite: made.code });
    const reg = await registerVault({ fetch: w.fetch, vault: local });
    expect(withVaultId(local, reg.vaultId).vaultId).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{16}$/);
    await expect(createAdminClient({ fetch: w.fetch, url: RELAY_URL, token: randomSecret() }).stats()).rejects.toMatchObject({ status: 401 });
  });

  it("saves both secrets once, to a file git ignores, and prints neither", () => {
    const fs = memoryFs();
    const { created, config } = ensureConfig({ fs, url: null });
    expect(created).toBe(true);
    const text = renderSteps({ created, url: config.url }).join("\n");
    expect(text).not.toContain(config.adminToken);
    expect(text).not.toContain(config.routeKey);
    expect(JSON.parse(fs.read(CONFIG_PATH))).toMatchObject({ adminToken: config.adminToken, routeKey: config.routeKey });
    const ignore = readFileSync(join(import.meta.dirname, "..", ".gitignore"), "utf8").split(/\r?\n/);
    expect(ignore).toContain(CONFIG_PATH);
  });

  it("does not make new secrets the second time, which would orphan every vault", () => {
    const fs = memoryFs();
    const first = ensureConfig({ fs });
    const second = ensureConfig({ fs });
    expect(second.created).toBe(false);
    expect(second.config).toEqual(first.config);
    expect(renderSteps({ created: false }).join("\n")).toContain("nothing new was made");
    // Only an explicit --force does, and a damaged file is reported, not silently replaced.
    expect(ensureConfig({ fs, force: true }).config.adminToken).not.toBe(first.config.adminToken);
    const broken = memoryFs({ [CONFIG_PATH]: JSON.stringify({ adminToken: "short" }) });
    expect(() => ensureConfig({ fs: broken })).toThrow(/too weak|missing/);
  });

  it("remembers the address once the owner has it", () => {
    const fs = memoryFs();
    ensureConfig({ fs });
    ensureConfig({ fs, url: "https://meter-sync.me.workers.dev" });
    expect(JSON.parse(fs.read(CONFIG_PATH)).url).toBe("https://meter-sync.me.workers.dev");
  });

  it("prints the deploy steps in the order they must be run, each with the config path", () => {
    const steps = renderSteps({ created: true }).join("\n");
    const at = (s) => steps.indexOf(s);
    expect(at("npx wrangler login")).toBeGreaterThan(-1);
    expect(at("npx wrangler login")).toBeLessThan(at("npx wrangler deploy --config relay/wrangler.toml"));
    expect(at("npx wrangler deploy")).toBeLessThan(at("secret put ROUTE_KEY"));
    expect(at("secret put ROUTE_KEY")).toBeLessThan(at("secret put ADMIN_TOKEN"));
    expect(at("secret put ADMIN_TOKEN")).toBeLessThan(at("relay:admin -- set-url"));
    for (const name of ["ROUTE_KEY", "ADMIN_TOKEN"]) {
      expect(steps).toContain(`--emit ${name} | npx wrangler secret put ${name} --config relay/wrangler.toml`);
    }
    expect(steps).toContain("UNVERIFIED");
  });

  it("hands a secret to a pipe as the bare value, without a newline", () => {
    const fs = memoryFs();
    const { config } = ensureConfig({ fs });
    expect(emitSecret({ fs, name: "ROUTE_KEY" })).toBe(config.routeKey);
    expect(emitSecret({ fs, name: "ADMIN_TOKEN" })).toBe(config.adminToken);
    expect(() => emitSecret({ fs, name: "OTHER" })).toThrow(/ROUTE_KEY or ADMIN_TOKEN/);
    expect(() => emitSecret({ fs: memoryFs(), name: "ROUTE_KEY" })).toThrow(/relay:init/);
  });
});

// ===================================================================== admin
/** The admin tool, with the Worker as its relay and a list for its output. */
function tool(over = {}) {
  const w = over.w ?? world();
  const out = [];
  const err = [];
  const saved = [];
  const run = (argv, extra = {}) => runAdmin(argv, {
    makeClient: () => createAdminClient({ fetch: w.fetch, url: RELAY_URL, token: over.token ?? w.env.ADMIN_TOKEN }),
    out: (l) => out.push(l), err: (l) => err.push(l), confirm: null, saveUrl: (u) => saved.push(u), ...extra,
  });
  return { w, run, out, err, saved, text: () => out.join("\n") };
}

const makeVault = async (w, label = "Sara") => {
  const inv = await admin(w, "/invite", { method: "POST", body: { label } });
  const local = await createLocalVault({ relay: RELAY_URL, invite: inv.body.code });
  const reg = await registerVault({ fetch: w.fetch, vault: local });
  return withVaultId(local, reg.vaultId);
};

describe("relay:admin invite", () => {
  it("makes an invite and prints the code and a link the app can read", async () => {
    const t = tool();
    expect(await t.run(["invite", "--label", "Sara", "--days", "3"])).toBe(0);
    const code = /code\s+(MTR-[0-9A-Z]{20})/.exec(t.text())[1];
    const link = /link\s+(\S+)/.exec(t.text())[1];
    expect(parseInvite(link)).toEqual({ code, relay: RELAY_URL });
    expect(link.startsWith("https://ahmed41022.github.io/meter/#invite=")).toBe(true);
    expect(t.text()).toContain('for "Sara"');
    const listed = await admin(t.w, "/invites");
    expect(listed.body.invites[0]).toMatchObject({ label: "Sara", status: "active" });
    expect(listed.body.invites[0].expiresAt - listed.body.invites[0].createdAt).toBe(3 * 86_400_000);
  });

  it("works for the person it was made for", async () => {
    const t = tool();
    await t.run(["invite"]);
    const code = /code\s+(MTR-[0-9A-Z]{20})/.exec(t.text())[1];
    const local = await createLocalVault({ relay: RELAY_URL, invite: code });
    expect((await registerVault({ fetch: t.w.fetch, vault: local })).vaultId).toBeTruthy();
  });

  it("takes --app for a self-hosted copy, and refuses a bad number of days with a usage error", async () => {
    const t = tool();
    await t.run(["invite", "--app=https://me.example/meter/"]);
    expect(t.text()).toContain("https://me.example/meter/#invite=");
    expect(await t.run(["invite", "--days", "many"])).toBe(2);
    expect(await t.run(["invite", "--days", "0"])).toBe(1); // the relay's own rule
    expect(t.err.join("\n")).toMatch(/did not accept/);
  });
});

describe("relay:admin invites and revoke-invite", () => {
  it("lists them with their state, and revokes one", async () => {
    const t = tool();
    expect(await t.run(["invites"])).toBe(0);
    expect(t.text()).toContain("No invites yet");
    await t.run(["invite", "--label", "Sara"]);
    t.out.length = 0;
    await t.run(["invites"]);
    expect(t.text()).toMatch(/id\s+label\s+status/);
    expect(t.text()).toMatch(/Sara\s+active/);
    const id = (await admin(t.w, "/invites")).body.invites[0].id;
    t.out.length = 0;
    expect(await t.run(["revoke-invite", id])).toBe(0);
    await t.run(["invites"]);
    expect(t.text()).toMatch(/Sara\s+revoked/);
  });

  it("explains an unknown id and a used one", async () => {
    const t = tool();
    expect(await t.run(["revoke-invite", "abcdefabcdef"])).toBe(1);
    expect(t.err.join("\n")).toContain("No invite has that id");
    const inv = await admin(t.w, "/invite", { method: "POST", body: {} });
    const local = await createLocalVault({ relay: RELAY_URL, invite: inv.body.code });
    await registerVault({ fetch: t.w.fetch, vault: local });
    t.err.length = 0;
    expect(await t.run(["revoke-invite", inv.body.id])).toBe(1);
    expect(t.err.join("\n")).toContain("already used");
    expect(await t.run(["revoke-invite"])).toBe(2);
  });
});

describe("relay:admin stats", () => {
  it("is a readable table of counts and sizes, and never anything of the contents", async () => {
    const t = tool();
    expect(await t.run(["stats"])).toBe(0);
    expect(t.text()).toContain("No vaults yet.");
    const A = await makeVault(t.w);
    await request(t.w, `/v1/v/${A.vaultId}/log`, { method: "POST", token: A.token, body: { epoch: 1, expect: 0, bid: "bid-stats-0001", blob: "ciphertext-text" } });
    t.out.length = 0;
    expect(await t.run(["stats"])).toBe(0);
    const text = t.text();
    expect(text).toMatch(/Vaults: 1 of 25\s+Open signup: off/);
    expect(text).toMatch(/vault\s+status\s+created\s+last seen\s+devices\s+size\s+writes today/);
    expect(text).toContain(A.vaultId);
    expect(text).toMatch(/active\s+2026-01-05 12:00Z\s+2026-01-05 12:00Z\s+1\s+\d+ B\s+1/);
    expect(text).toContain("Contents are encrypted");
    for (const secret of [A.token, A.K, "ciphertext-text"]) expect(text).not.toContain(secret);
  });
});

describe("relay:admin delete-vault", () => {
  it("asks first, and does nothing on a no", async () => {
    const t = tool();
    const A = await makeVault(t.w);
    const confirm = vi.fn(async () => false);
    expect(await t.run(["delete-vault", A.vaultId], { confirm })).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toContain(A.vaultId);
    expect(t.text()).toContain("Nothing was deleted");
    expect((await admin(t.w, "/stats")).body.perVault[0].status).toBe("active");
  });

  it("deletes on a yes, or with --yes, and refuses to guess with no one to ask", async () => {
    const t = tool();
    const A = await makeVault(t.w);
    expect(await t.run(["delete-vault", A.vaultId])).toBe(2); // no terminal, no --yes
    expect(t.err.join("\n")).toContain("--yes");
    expect((await admin(t.w, "/stats")).body.perVault[0].status).toBe("active");
    expect(await t.run(["delete-vault", A.vaultId, "--yes"])).toBe(0);
    expect((await admin(t.w, "/stats")).body.perVault[0].status).toBe("deleted");

    const B = await makeVault(t.w);
    expect(await t.run(["delete-vault", B.vaultId], { confirm: async () => true })).toBe(0);
  });

  it("says so for a vault the relay does not know", async () => {
    const t = tool();
    expect(await t.run(["delete-vault", `${"0".repeat(32)}.${"0".repeat(16)}`, "--yes"])).toBe(1);
    expect(t.err.join("\n")).toContain("no vault with that id");
  });
});

describe("relay:admin config, open and caps", () => {
  it("shows the settings and changes them, with sizes as people write them", async () => {
    const t = tool();
    expect(await t.run(["config"])).toBe(0);
    expect(t.text()).toMatch(/maxVaults\s+25/);
    expect(t.text()).toMatch(/vaultBytesCap\s+52428800 \(50\.0 MB\)/);
    expect(t.text()).toMatch(/openSignup\s+off/);
    t.out.length = 0;
    expect(await t.run(["config", "set", "maxVaults=40", "vaultBytesCap=100MB", "openSignup=on", "ipDailyCap=2"])).toBe(0);
    expect((await admin(t.w, "/config")).body).toMatchObject({ maxVaults: 40, vaultBytesCap: 100 * 1024 * 1024, openSignup: true, ipDailyCap: 2 });
    expect(t.text()).toContain("Saved.");
  });

  it("refuses a typo, a missing value and a bad number before asking the relay", async () => {
    const t = tool();
    const before = t.w.env.REGISTRY.calls.length;
    expect(await t.run(["config", "set", "maxVault=3"])).toBe(2);
    expect(t.err.join("\n")).toMatch(/Unknown setting "maxVault"/);
    expect(await t.run(["config", "set", "maxVaults"])).toBe(2);
    expect(await t.run(["config", "set", "maxVaults=lots"])).toBe(2);
    expect(await t.run(["config", "set", "openSignup=maybe"])).toBe(2);
    expect(await t.run(["config", "set"])).toBe(2);
    expect(t.w.env.REGISTRY.calls.length).toBe(before);
  });

  it("opens and closes signup, and says what that means", async () => {
    const t = tool();
    expect(await t.run(["open", "on"])).toBe(0);
    expect(t.text()).toMatch(/Open signup is ON.*3 per address and 50 in all/);
    expect((await request(t.w, "/v1/info").then((r) => r.json())).open).toBe(true);
    expect(await t.run(["open", "off"])).toBe(0);
    expect((await request(t.w, "/v1/info").then((r) => r.json())).open).toBe(false);
    expect(await t.run(["open", "sideways"])).toBe(2);
    expect(await t.run(["open"])).toBe(2);
  });

  it("shows the caps and how to change them", async () => {
    const t = tool();
    expect(await t.run(["caps"])).toBe(0);
    expect(t.text()).toMatch(/Vaults held at once\s+25/);
    expect(t.text()).toMatch(/Stored bytes per vault\s+50\.0 MB/);
    expect(t.text()).toContain("config set maxVaults=");
  });
});

describe("relay:admin errors", () => {
  it("maps the relay's answers to something a person can act on", async () => {
    const wrong = tool({ token: randomSecret() });
    expect(await wrong.run(["stats"])).toBe(1);
    expect(wrong.err.join("\n")).toMatch(/refused the admin token.*relay\/\.admin\.json/);

    const off = tool({ w: world({ ADMIN_TOKEN: "" }), token: randomSecret() });
    expect(await off.run(["stats"])).toBe(1);
    expect(off.err.join("\n")).toContain("Admin is switched off");

    const t = tool();
    let rate = 0;
    for (let i = 0; i < 21; i += 1) {
      const lock = tool({ w: t.w, token: randomSecret() });
      rate = await lock.run(["stats"]);
      if (lock.err.join("").includes("Too many wrong tokens")) { rate = -1; expect(lock.err.join("\n")).toMatch(/about \d+ minutes/); break; }
    }
    expect(rate).toBe(-1);
  });

  it("says when the relay cannot be reached or is not a relay", async () => {
    const down = tool();
    const bad = await runAdmin(["stats"], {
      makeClient: () => createAdminClient({ fetch: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }, url: RELAY_URL, token: "t".repeat(43) }),
      out: () => {}, err: (l) => down.err.push(l),
    });
    expect(bad).toBe(1);
    expect(down.err.join("\n")).toMatch(/Could not reach https:\/\/relay\.example\.workers\.dev: ENOTFOUND/);

    const html = await runAdmin(["stats"], {
      makeClient: () => createAdminClient({ fetch: async () => new Response("<html>hi</html>", { status: 200 }), url: RELAY_URL, token: "t".repeat(43) }),
      out: () => {}, err: (l) => down.err.push(l),
    });
    expect(html).toBe(1);
    expect(down.err.join("\n")).toContain("did not answer like a Meter relay");

    const missing = await runAdmin(["stats"], {
      makeClient: () => createAdminClient({ fetch: async () => new Response(JSON.stringify({ code: "not_found" }), { status: 404 }), url: RELAY_URL, token: "t".repeat(43) }),
      out: () => {}, err: (l) => down.err.push(l),
    });
    expect(missing).toBe(1);
    expect(down.err.join("\n")).toContain("does not know that address");
  });

  it("sends Authorization: Bearer and a JSON content type, and nothing else secret", async () => {
    const seen = [];
    const w = world();
    const client = createAdminClient({
      fetch: (url, init) => { seen.push({ url, init }); return w.fetch(url, init); }, url: RELAY_URL, token: w.env.ADMIN_TOKEN,
    });
    await client.invite({ label: "x" });
    await client.stats();
    expect(seen[0].init.headers).toEqual({ authorization: `Bearer ${w.env.ADMIN_TOKEN}`, "content-type": "application/json" });
    expect(seen[1].init.headers).toEqual({ authorization: `Bearer ${w.env.ADMIN_TOKEN}` });
    expect(seen.every((s) => !s.url.includes(w.env.ADMIN_TOKEN))).toBe(true);
  });

  it("refuses an address that is not an origin, and unknown commands and options", async () => {
    expect(() => createAdminClient({ fetch, url: "http://example.com", token: "t" })).toThrow(/https/);
    const t = tool();
    expect(await t.run(["frobnicate"])).toBe(2);
    expect(await t.run(["stats", "--verbose"])).toBe(2);
    expect(await t.run([])).toBe(2);
    expect(await t.run(["help"])).toBe(0);
    expect(t.text()).toContain("invite [--label NAME]");
  });
});

describe("relay:admin set-url", () => {
  it("remembers a valid address and works with no token yet", async () => {
    const out = [];
    const saved = [];
    const code = await runAdmin(["set-url", "https://meter-sync.me.workers.dev/"], {
      makeClient: () => { throw new Error("must not be needed"); }, out: (l) => out.push(l), err: () => {}, saveUrl: (u) => saved.push(u),
    });
    expect(code).toBe(0);
    expect(saved).toEqual(["https://meter-sync.me.workers.dev"]);
    const bad = await runAdmin(["set-url", "meter-sync.me.workers.dev"], { makeClient: () => null, out: () => {}, err: (l) => out.push(l), saveUrl: (u) => saved.push(u) });
    expect(bad).toBe(2);
    expect(saved).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("parse arguments strictly", () => {
    expect(parseArgs(["invite", "--label", "Sara Jones", "--days=3"])).toEqual({ words: ["invite"], flags: { label: "Sara Jones", days: "3" } });
    expect(() => parseArgs(["--label"])).toThrow(AdminError);
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown option/);
    expect(parseConfigPairs(["vaultBytesCap=2048", "maxVaults=7"])).toEqual({ vaultBytesCap: 2048, maxVaults: 7 });
    expect(() => parseConfigPairs(["maxVaults=7MB"])).toThrow(/whole number/);
  });

  it("format bytes and tables", () => {
    expect([fmtBytes(0), fmtBytes(1536), fmtBytes(5 * 1024 ** 2), fmtBytes(3 * 1024 ** 3), fmtBytes(undefined)]).toEqual(["0 B", "1.5 KB", "5.0 MB", "3.00 GB", "-"]);
    expect(table(["a", "bb"], [["xxx", 1], ["y", null]], { right: [1] })).toEqual(["a    bb", "---  --", "xxx   1", "y     -"]);
  });
});
