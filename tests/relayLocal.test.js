/**
 * The local development relay (scripts/lib/localRelay.mjs): the real Worker over
 * database FILES, so accounts survive a restart; CORS for the dev origins; and a
 * 426 for a WebSocket. Run in-process with a temporary directory: no port is
 * opened and nothing goes over a network.
 */
import { afterEach, describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEV_ORIGINS, createLocalRelay, localSecrets, nodeHandler } from "../scripts/lib/localRelay.mjs";
import { parseInviteCode } from "../src/sync/codes.js";
import { createLocalVault, withVaultId } from "../src/sync/vault.js";
import { listDevices, registerVault } from "../src/sync/relay.js";

const dirs = [];
const open = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "meter-relay-test-"));
  dirs.push(d);
  return d;
};
const relayIn = async (dir) => {
  const local = await createLocalRelay({ dir });
  open.push(local);
  return local;
};
afterEach(() => {
  for (const l of open.splice(0)) l.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

const BASE = "http://127.0.0.1:8788";

/** What `http.createServer` would hand the handler, and what it would send back. */
async function viaNode(local, { method = "GET", url = "/", headers = {}, body = "" }) {
  const req = new EventEmitter();
  Object.assign(req, { method, url, headers, socket: { remoteAddress: "127.0.0.1" } });
  const sent = { status: null, headers: null, body: "" };
  const res = {
    writeHead(status, h) { sent.status = status; sent.headers = h; },
    end(chunk) { sent.body = chunk ? Buffer.from(chunk).toString() : ""; sent.done(); },
  };
  const done = new Promise((resolve) => { sent.done = resolve; });
  const run = nodeHandler(local, { origin: BASE })(req, res);
  if (method !== "GET") req.emit("data", Buffer.from(body));
  req.emit("end");
  await run;
  await done;
  return sent;
}

describe("the local relay", () => {
  it("keeps its secrets, and says whether it just made them", () => {
    const dir = tmp();
    const first = localSecrets(dir);
    expect(first.created).toBe(true);
    expect(first.ADMIN_TOKEN).toHaveLength(48);
    const second = localSecrets(dir);
    expect(second).toMatchObject({ created: false, ROUTE_KEY: first.ROUTE_KEY, ADMIN_TOKEN: first.ADMIN_TOKEN });
  });

  it("makes an invite from the real admin route, and one that the app's parser accepts", async () => {
    const local = await relayIn(tmp());
    const code = await local.invite("label", 2);
    expect(parseInviteCode(code)).toBe(code);
    // Used once, it is spent: the real registry is what counts.
    const vault = await createLocalVault({ relay: BASE, invite: code });
    const reg = await registerVault({ fetch: local.fetch, vault, name: "Dev" });
    expect(reg.vaultId).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{16}$/);
    const again = await createLocalVault({ relay: BASE, invite: code });
    await expect(registerVault({ fetch: local.fetch, vault: again })).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps accounts across a restart, in files", async () => {
    const dir = tmp();
    const first = await relayIn(dir);
    const vault = await createLocalVault({ relay: BASE, invite: await first.invite() });
    const registered = withVaultId(vault, (await registerVault({ fetch: first.fetch, vault, name: "Laptop" })).vaultId);
    first.close();

    const second = await relayIn(dir);
    expect(second.secrets).toMatchObject({ created: false, ROUTE_KEY: first.secrets.ROUTE_KEY });
    const devices = await listDevices({ fetch: second.fetch, vault: registered });
    expect(devices.map((d) => d.name)).toEqual(["Laptop"]);
    expect(readdirSync(dir).some((f) => f.endsWith(".sqlite"))).toBe(true);
  });

  it("allows the browser from the dev origins, answering the preflight", async () => {
    const local = await relayIn(tmp());
    for (const origin of DEV_ORIGINS) {
      const pre = await viaNode(local, {
        method: "OPTIONS", url: "/v1/vaults",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" },
      });
      expect(pre.status).toBe(204);
      expect(pre.headers["access-control-allow-origin"]).toBe("*");
      expect(pre.headers["access-control-allow-headers"]).toMatch(/authorization/);
      const get = await viaNode(local, { url: "/v1/info", headers: { origin } });
      expect(get.status).toBe(200);
      expect(get.headers["access-control-allow-origin"]).toBe("*");
      expect(JSON.parse(get.body)).toEqual({ v: 1, open: false });
    }
  });

  it("refuses a WebSocket with 426, so the app has to do without one", async () => {
    const local = await relayIn(tmp());
    const refused = await viaNode(local, {
      url: "/v1/v/anything/ws", headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-protocol": "meter.v1, token" },
    });
    expect(refused.status).toBe(426);
    expect(JSON.parse(refused.body)).toEqual({ code: "upgrade_required" });
    expect(refused.headers["access-control-allow-origin"]).toBe("*");
  });

  it("passes a body through and reports a failure as JSON, not a crash", async () => {
    const local = await relayIn(tmp());
    const bad = await viaNode(local, { method: "POST", url: "/v1/vaults", headers: { "content-type": "application/json" }, body: "{" });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).code).toBe("bad_json");
    const none = await viaNode(local, { method: "GET", url: "/nope" });
    expect(none.status).toBe(404);
  });
});
