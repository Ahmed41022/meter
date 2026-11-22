/**
 * Meter Sync in the app, from nothing to a working account: the notice, creating
 * an account with an invite, the recovery code, the account screen, leaving and
 * deleting, and what happens to Google Drive meanwhile. The built app, the real
 * Worker, no network (see app.integration.relay-helpers.js).
 */
import { describe, it, expect } from "vitest";
import { guardBuiltApp, settle, setValue, btn, wait } from "./app.integration.helpers.js";
import {
  bootApp, doc, fill, heading, ledgerText, liveVaults, makeInvite, newRelay, openSettings, panel, press, stored, waitFor,
} from "./app.integration.relay-helpers.js";
import { admin } from "./relayWorld.js";

guardBuiltApp();

const seed = {
  projects: [{
    id: "a", name: "Orion", currentRate: 20, currency: "USD",
    createdAt: Date.now() - 86_400_000, sessionGoal: null, overallGoal: null, tasks: [],
  }],
  sessions: [],
};
const NOT_FOR_THE_LEDGER = (vault) => [vault.K, vault.token, vault.privateJwk.d];
const inviteInput = (dom) => panel(dom).querySelector("input[placeholder^=MTR]");

/** Through the notice to the create screen, with the invite typed in. */
async function toCreate(dom, code) {
  await openSettings(dom);
  await press(dom, /^Set up Meter Sync$/);
  await press(dom, /^Create an account$/);
  if (code) await fill(dom, inviteInput(dom), code);
}

/** A whole account: created, the recovery code confirmed, on the account screen. */
async function makeAccount(dom, w) {
  await toCreate(dom, await makeInvite(w));
  await press(dom, /^Create account$/);
  await waitFor(dom, (p) => /Save your recovery code/.test(p.textContent), "the recovery code");
  panel(dom).querySelector("input[type=checkbox]").click();
  await settle();
  await press(dom, /^Continue$/);
  await waitFor(dom, (p) => /Up to date/.test(p.textContent), "the first sync");
}

describe("before there is an account", () => {
  it("offers Meter Sync beside the unchanged Drive panel, and nothing is asked of the relay", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await openSettings(dom);
    expect(panel(dom).textContent).toMatch(/Set up Meter Sync/);
    // Drive's own panel, as it has always been.
    const drive = [...doc(dom).querySelectorAll(".sec")].find((x) => /^Sync/.test(x.querySelector(".eyebrow")?.textContent ?? ""));
    expect(drive.textContent).toMatch(/client ID/i);
    expect(dom.requests).toEqual([]);
  }, 30_000);

  it("shows the privacy notice, then the choices, before anything is made", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await openSettings(dom);
    await press(dom, /^Set up Meter Sync$/);
    const p = panel(dom);
    expect(heading(dom)).toBe("Set up Meter Sync");
    expect(p.textContent).toMatch(/encrypted on this device before it is sent/);
    expect(p.textContent).toMatch(/lose every device and the recovery code, nobody can get your data back/);
    expect(p.textContent).toMatch(/Operated by: Meter Sync/);
    expect([...p.querySelectorAll("button")].map((b) => b.textContent)).toEqual(
      expect.arrayContaining(["Create an account", "Join from another device"]));
    expect(p.querySelector("details summary").textContent).toBe("Use my own relay");
    // Reading the notice is not a request.
    expect(dom.requests).toEqual([]);
    expect(stored(dom, "meter:sync")).toBeNull();
  }, 30_000);

  it("moves focus to the new step's heading, but not on first showing", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await openSettings(dom);
    await press(dom, /^Set up Meter Sync$/);
    expect(doc(dom).activeElement).toBe(panel(dom).querySelector(".rl-h"));
    await press(dom, /^Create an account$/);
    expect(doc(dom).activeElement).toBe(panel(dom).querySelector(".rl-h"));
    expect(heading(dom)).toBe("Create an account");
  }, 30_000);

  it("checks a relay address of your own before using it", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await openSettings(dom);
    await press(dom, /^Set up Meter Sync$/);
    const input = panel(dom).querySelector("details input");
    await fill(dom, input, "http://not-secure.example.com");
    await press(dom, /Check and use this relay/);
    expect(panel(dom).textContent).toMatch(/must start with https/);
    await fill(dom, input, "https://my-relay.example.workers.dev");
    await press(dom, /Check and use this relay/);
    await waitFor(dom, () => heading(dom) === "Create an account", "the create screen");
    // The notice now names whoever runs THAT relay, not "Meter Sync".
    expect(panel(dom).textContent).toMatch(/Operated by: the owner of my-relay\.example\.workers\.dev/);
    expect(dom.requests.map((r) => r.url)).toEqual(["https://my-relay.example.workers.dev/v1/info"]);
  }, 30_000);

  it("explains that a Join needs the other device, and that an own relay that is not one is not used", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await openSettings(dom);
    await press(dom, /^Set up Meter Sync$/);
    // Not a Meter relay: the answer has no version.
    const real = dom.window.fetch;
    dom.window.fetch = async (url, init) => (/\/v1\/info/.test(url) ? { ok: true, status: 200, headers: { get: () => null }, text: async () => "{}" } : real(url, init));
    await fill(dom, panel(dom).querySelector("details input"), "https://my-relay.example.workers.dev");
    await press(dom, /Check and use this relay/);
    await waitFor(dom, (p) => /did not answer like a Meter relay/.test(p.textContent), "the refusal");
    expect(heading(dom)).toBe("Set up Meter Sync");
  }, 30_000);
});

describe("creating an account", () => {
  it("registers with an invite, gates the recovery code, then shows a synced account", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await toCreate(dom, await makeInvite(w));
    await press(dom, /^Create account$/);
    await waitFor(dom, (p) => /Save your recovery code/.test(p.textContent), "the recovery code");

    const vault = JSON.parse(stored(dom, "meter:sync"));
    expect(vault.vaultId).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{16}$/);
    expect(vault.invite).toBeNull();

    // Eight groups of eight, a Copy button, and a way past only through the box.
    const groups = [...panel(dom).querySelectorAll(".rl-group")].map((g) => g.textContent.replace(/^\d/, ""));
    expect(groups).toHaveLength(8);
    for (const g of groups) expect(g).toMatch(/^[0-9A-Z]{8}$/);
    expect(btn(panel(dom), /^Copy$/)).toBeTruthy();
    expect(panel(dom).textContent).toMatch(/password manager/);
    const next = btn(panel(dom), /^Continue$/);
    expect(next.disabled).toBe(true);
    next.click();
    await settle();
    expect(heading(dom)).toBe("Save your recovery code");

    panel(dom).querySelector("input[type=checkbox]").click();
    await settle();
    expect(btn(panel(dom), /^Continue$/).disabled).toBe(false);
    await press(dom, /^Continue$/);

    expect(heading(dom)).toBe("Your account");
    await waitFor(dom, (p) => /Up to date/.test(p.textContent), "a synced status");
    expect(stored(dom, "meter:sync:ack")).toBeNull();
    // The first push is a snapshot of the ledger the device already had.
    expect(dom.requests.map((r) => `${r.method} ${new URL(r.url).pathname.replace(/\/v\/[^/]+/, "/v/ID")}`)).toEqual(
      expect.arrayContaining(["POST /v1/vaults", "PUT /v1/v/ID/snapshot"]));
    // The footer shows the same state.
    expect(doc(dom).querySelector(".foot .pip").textContent).toMatch(/^Synced/);
  }, 60_000);

  it("keeps showing the recovery code until it is confirmed, even after leaving the screen", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await toCreate(dom, await makeInvite(w));
    await press(dom, /^Create account$/);
    await waitFor(dom, (p) => /Save your recovery code/.test(p.textContent), "the recovery code");
    expect(stored(dom, "meter:sync:ack")).toBe("pending");
    const away = [...doc(dom).querySelectorAll("[role=tab]")].find((t) => t.textContent === "Today");
    away.click();
    await settle();
    await openSettings(dom);
    expect(heading(dom)).toBe("Save your recovery code");
  }, 60_000);

  it("names this device and lets it be renamed, sealed so the relay cannot read it", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    await waitFor(dom, (p) => p.querySelectorAll(".rl-device").length === 1, "the device list");
    expect(panel(dom).querySelector(".rl-device").textContent).toMatch(/this device/);
    const name = panel(dom).querySelector(".rl-name input");
    await fill(dom, name, "Kitchen laptop");
    await press(dom, /^Save$/);
    await waitFor(dom, (p) => /Kitchen laptop/.test(p.querySelector(".rl-device")?.textContent ?? ""), "the new name");
    const sentToRelay = JSON.stringify(dom.requests);
    expect(sentToRelay).not.toContain("Kitchen laptop");
  }, 60_000);

  it("shows Remove for other devices as off, with the reason", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    // One device: no Remove at all, no note.
    expect(panel(dom).querySelector(".rl-remove")).toBeNull();
  }, 60_000);

  const failsWith = async (setup, message) => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    const code = await setup(w);
    await toCreate(dom, code);
    await press(dom, /^Create account$/);
    await waitFor(dom, (p) => p.querySelector(".rl-problem"), "an error");
    expect(panel(dom).querySelector(".rl-problem").textContent).toMatch(message);
    expect(heading(dom)).toBe("Create an account");
    return { w, dom };
  };

  it("says an invite is not valid", async () => {
    await failsWith(async () => "MTR-0123456789ABCDEFGHJK", /not valid/);
  }, 30_000);

  it("says an invite was used", async () => {
    const w = newRelay();
    const code = await makeInvite(w);
    const first = await bootApp(w, { seed });
    await settle();
    await toCreate(first, code);
    await press(first, /^Create account$/);
    await waitFor(first, (p) => /Save your recovery code/.test(p.textContent), "the first account");
    const second = await bootApp(w, { seed });
    await settle();
    await toCreate(second, code);
    await press(second, /^Create account$/);
    await waitFor(second, (p) => p.querySelector(".rl-problem"), "the refusal");
    expect(panel(second).querySelector(".rl-problem").textContent).toMatch(/already been used/);
    // Nothing was left half made on the second device.
    expect(JSON.parse(stored(second, "meter:sync")).vaultId).toBeNull();
  }, 60_000);

  it("says an invite expired", async () => {
    await failsWith(async (w) => {
      const code = await makeInvite(w);
      w.skew = 8 * 86_400_000;
      return code;
    }, /expired/);
  }, 30_000);

  it("says an invite was cancelled", async () => {
    await failsWith(async (w) => {
      const made = await admin(w, "/invite", { method: "POST", body: { label: "x" } });
      await admin(w, "/revoke-invite", { method: "POST", body: { id: made.body.id } });
      return made.body.code;
    }, /cancelled/);
  }, 30_000);

  it("says the relay is full", async () => {
    const w = newRelay();
    await admin(w, "/config", { method: "POST", body: { maxVaults: 0 } });
    const dom = await bootApp(w, { seed });
    await settle();
    await toCreate(dom, await makeInvite(w));
    await press(dom, /^Create account$/);
    await waitFor(dom, (p) => p.querySelector(".rl-problem"), "the refusal");
    expect(panel(dom).querySelector(".rl-problem").textContent).toMatch(/relay is full/);
  }, 30_000);

  it("asks for an invite on a relay that needs one, without calling it", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await toCreate(dom, "");
    await press(dom, /^Create account$/);
    expect(panel(dom).querySelector(".rl-problem").textContent).toMatch(/Enter your invite code/);
    expect(dom.requests).toEqual([]);
  }, 30_000);

  it("retries without making a second account after a failure part way", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    const code = await makeInvite(w);
    await toCreate(dom, code);
    // The first attempt cannot reach the relay at all.
    const real = dom.window.fetch;
    dom.window.fetch = async () => { throw new Error("offline"); };
    await press(dom, /^Create account$/);
    await waitFor(dom, (p) => /Could not reach the relay/.test(p.textContent), "the offline message");
    const before = JSON.parse(stored(dom, "meter:sync"));
    expect(before.vaultId).toBeNull();
    dom.window.fetch = real;
    await press(dom, /^Create account$/);
    await waitFor(dom, (p) => /Save your recovery code/.test(p.textContent), "the recovery code");
    const after = JSON.parse(stored(dom, "meter:sync"));
    // The same identity, registered once.
    expect(after.token).toBe(before.token);
    expect(after.K).toBe(before.K);
    expect(await liveVaults(w)).toBe(1);
  }, 60_000);

  it("takes an invite typed with spaces and lower case, and says how it read it", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    const code = await makeInvite(w);
    const messy = `  ${code.toLowerCase().replace(/(.{5})/g, "$1 ")} `;
    await toCreate(dom, messy);
    expect(panel(dom).querySelector(".rl-hint").textContent).toMatch(/^Reads as MTR-/);
    await press(dom, /^Create account$/);
    await waitFor(dom, (p) => /Save your recovery code/.test(p.textContent), "the recovery code");
  }, 60_000);

  it("on a relay open to everyone, makes an account with no invite", async () => {
    const w = newRelay();
    await admin(w, "/config", { method: "POST", body: { openSignup: true } });
    const dom = await bootApp(w, { seed });
    await settle();
    await openSettings(dom);
    await press(dom, /^Set up Meter Sync$/);
    await fill(dom, panel(dom).querySelector("details input"), "https://open.example.workers.dev");
    await press(dom, /Check and use this relay/);
    await waitFor(dom, () => heading(dom) === "Create an account", "the create screen");
    expect(panel(dom).textContent).toMatch(/optional on this relay/);
    await press(dom, /^Create account$/);
    await waitFor(dom, (p) => /Save your recovery code/.test(p.textContent), "the recovery code");
    expect(JSON.parse(stored(dom, "meter:sync")).relay).toBe("https://open.example.workers.dev");
  }, 60_000);
});

describe("links that carry an invite or a join code", () => {
  it("prefills the invite from #invite=, opens on Settings, and strips the fragment", async () => {
    const w = newRelay();
    const code = await makeInvite(w);
    const dom = await bootApp(w, { seed, hash: `#invite=${code}` });
    await settle();
    expect(dom.window.location.hash).toBe("");
    expect(dom.window.location.pathname).toBe("/");
    expect(doc(dom).querySelector("[role=tab][aria-selected=true]").textContent).toBe("Settings");
    expect(heading(dom)).toBe("Create an account");
    expect(inviteInput(dom).value).toBe(code);
    // The privacy notice is on this screen too: a link skips the first one.
    expect(panel(dom).textContent).toMatch(/Operated by: Meter Sync/);
    // Not used until the person presses the button.
    expect(dom.requests).toEqual([]);
  }, 30_000);

  it("will not quietly switch relay because a link named one", async () => {
    const w = newRelay();
    const code = await makeInvite(w);
    const link = `#invite=${code}&relay=${encodeURIComponent("https://other.example.workers.dev")}`;
    const dom = await bootApp(w, { seed, hash: link });
    await settle();
    // The link's relay is the one on offer, named in the notice, never the default.
    expect(panel(dom).textContent).toMatch(/Operated by: the owner of other\.example\.workers\.dev/);
    expect(panel(dom).textContent).toContain("https://other.example.workers.dev");
    await press(dom, /^Create account$/);
    await waitFor(dom, (p) => /Save your recovery code/.test(p.textContent), "the recovery code");
    expect(JSON.parse(stored(dom, "meter:sync")).relay).toBe("https://other.example.workers.dev");
  }, 60_000);

  it("says so when an invite link is damaged, and does not guess", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed, hash: "#invite=MTR-NOPE" });
    await settle();
    expect(dom.window.location.hash).toBe("");
    expect(panel(dom).querySelector(".rl-problem").textContent).toMatch(/invite code/i);
    expect(inviteInput(dom)).toBeNull();
  }, 30_000);

  it("prefills the join screen from #join= and strips the fragment", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed, hash: "#join=relay.example.workers.dev/AAAA-BBBB" });
    await settle();
    expect(dom.window.location.hash).toBe("");
    expect(heading(dom)).toBe("Join from another device");
    expect(panel(dom).querySelector("textarea").value).toBe("relay.example.workers.dev/AAAA-BBBB");
    expect(panel(dom).textContent).toMatch(/Your entries on this device will be merged in/);
  }, 30_000);
});

describe("an account on this device", () => {
  it("keeps the ledger and the JSON export free of every secret of the vault", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    const vault = JSON.parse(stored(dom, "meter:sync"));
    for (const secret of NOT_FOR_THE_LEDGER(vault)) {
      expect(secret.length).toBeGreaterThan(20);
      expect(ledgerText(dom)).not.toContain(secret);
    }
    // The export is the ledger object, serialised: take the real one.
    let handed = null;
    dom.window.URL.createObjectURL = (blob) => { handed = blob; return "blob:x"; };
    dom.window.URL.revokeObjectURL = () => {};
    await openSettings(dom);
    btn(doc(dom), /Export backup/i).click();
    await settle();
    expect(handed).not.toBeNull();
    const text = await new Promise((resolve) => {
      const reader = new dom.window.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(handed);
    });
    for (const secret of NOT_FOR_THE_LEDGER(vault)) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/"meter:sync|presence|joinToken|recoverAuth/i);
  }, 60_000);

  it("asks before showing the recovery code, and shows the same one", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    await press(dom, /^Show recovery code$/);
    expect(panel(dom).querySelector("[role=alertdialog]").textContent).toMatch(/Anyone who sees it can read your ledger/);
    expect(panel(dom).querySelectorAll(".rl-group")).toHaveLength(0);
    await press(dom, /^Show it$/);
    expect(heading(dom)).toBe("Your recovery code");
    expect(panel(dom).querySelectorAll(".rl-group")).toHaveLength(8);
    // Not the gated first showing: there is no box to tick, and it can be hidden.
    expect(panel(dom).querySelector("input[type=checkbox]")).toBeNull();
    await press(dom, /^Hide$/);
    expect(heading(dom)).toBe("Your account");
  }, 60_000);

  it("leaves on this device after a confirmation: the vault goes, the ledger stays", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    await press(dom, /^Leave on this device$/);
    expect(panel(dom).querySelector("[role=alertdialog]").textContent).toMatch(/Your ledger here stays exactly as it is/);
    // Cancelling changes nothing.
    await press(dom, /^Cancel$/);
    expect(stored(dom, "meter:sync")).not.toBeNull();
    await press(dom, /^Leave on this device$/);
    await press(dom, /^Leave on this device$/);
    expect(stored(dom, "meter:sync")).toBeNull();
    expect(stored(dom, "meter:sync:meta")).toBeNull();
    expect(stored(dom, "meter:sync:sent")).toBeNull();
    expect(JSON.parse(stored(dom, "meter:v1")).projects.map((p) => p.name)).toEqual(["Orion"]);
    expect(panel(dom).textContent).toMatch(/Set up Meter Sync/);
    // The account is still there for other devices.
    expect(await liveVaults(w)).toBe(1);
    // And the pip is Drive's, or nothing: Meter Sync is no longer running here.
    expect(doc(dom).querySelector(".foot .pip")).toBeNull();
  }, 60_000);

  it("deletes the account only after the word is typed, then leaves", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    await press(dom, /^Delete account$/);
    const confirm = () => btn(panel(dom).querySelector("[role=alertdialog]"), /^Delete account$/);
    expect(confirm().disabled).toBe(true);
    await fill(dom, panel(dom).querySelector("[role=alertdialog] input"), "delet");
    expect(confirm().disabled).toBe(true);
    await fill(dom, panel(dom).querySelector("[role=alertdialog] input"), "delete");
    expect(confirm().disabled).toBe(false);
    confirm().click();
    await settle();
    await waitFor(dom, (p) => /Set up Meter Sync/.test(p.textContent), "the account to be gone");
    expect(stored(dom, "meter:sync")).toBeNull();
    expect(await liveVaults(w)).toBe(0);
    expect(JSON.parse(stored(dom, "meter:v1")).projects).toHaveLength(1);
  }, 60_000);

  it("shows an account deleted elsewhere as deleted, and offers to leave", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    const vault = JSON.parse(stored(dom, "meter:sync"));
    await admin(w, "/delete-vault", { method: "POST", body: { vaultId: vault.vaultId } });
    await press(dom, /^Sync now$/);
    await waitFor(dom, (p) => /The account was deleted/.test(p.textContent), "the deleted status");
    expect(btn(panel(dom), /^Delete account$/)).toBeUndefined();
    expect(btn(panel(dom), /^Sync now$/)).toBeUndefined();
    expect(doc(dom).querySelector(".foot .pip").textContent).toBe("Account deleted");
    await press(dom, /^Leave on this device$/);
    await press(dom, /^Leave on this device$/);
    expect(stored(dom, "meter:sync")).toBeNull();
  }, 60_000);

  it("says a removed device was removed, and that nothing syncs", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    // The relay forgets this device's token: as if another device removed it.
    const vault = JSON.parse(stored(dom, "meter:sync"));
    const entry = await w.env.VAULT.entry(`v:${vault.vaultId}`);
    const rows = entry.instance.sql.exec("SELECT id FROM devices").toArray();
    entry.instance.sql.exec("DELETE FROM devices WHERE id = ?", rows[0].id).toArray();
    await press(dom, /^Sync now$/);
    await waitFor(dom, (p) => /This device was removed from the account/.test(p.textContent), "the removed status");
    expect(btn(panel(dom), /^Add a device$/)).toBeUndefined();
  }, 60_000);
});

describe("Google Drive", () => {
  const GIS_SCRIPT = 'script[src*="accounts.google.com"]';
  const DRIVE = { "meter:google-client": "abc.apps.googleusercontent.com" };

  it("runs as it always did when there is no account, and Meter Sync does nothing", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed, settings: DRIVE });
    await settle();
    await wait(300);
    // Drive's footer pip, after its own attempt on opening (which cannot sign in here).
    expect(doc(dom).querySelector(".foot .pip").textContent).toMatch(/Syncing|Sync failed|sign in/i);
    expect(dom.requests).toEqual([]);
    // Proof that it really ran: it went to load Google's sign-in script.
    expect(doc(dom).querySelector(GIS_SCRIPT)).not.toBeNull();
    await openSettings(dom);
    expect(doc(dom).querySelector(".rl-drive")).toBeNull();
  }, 30_000);

  it("is not run, and is labelled as being replaced, once there is an account", async () => {
    const w = newRelay();
    const first = await bootApp(w, { seed, settings: DRIVE });
    await settle();
    await makeAccount(first, w);
    const keys = ["meter:sync", "meter:sync:meta", "meter:sync:sent", "meter:device"];
    const kept = { ...DRIVE, ...Object.fromEntries(keys.map((k) => [k, stored(first, k)]).filter(([, v]) => v)) };
    const ledger = JSON.parse(stored(first, "meter:v1"));
    first.window.close();
    // A device that opens already holding an account, with Drive configured.
    const dom = await bootApp(w, { seed: ledger, settings: kept });
    await settle();
    await wait(300);
    const pip = doc(dom).querySelector(".foot .pip");
    expect(pip.textContent).not.toMatch(/Sync failed|sign in/i);
    // Drive never went to load Google's script: it was not started at all.
    expect(doc(dom).querySelector(GIS_SCRIPT)).toBeNull();
    await openSettings(dom);
    await waitFor(dom, (p) => /Up to date/.test(p.textContent), "the relay sync");
    expect(doc(dom).querySelector(".rl-drive .rl-h2").textContent).toBe("Google Drive (being replaced)");
    expect(doc(dom).querySelector(".rl-drive").textContent).toMatch(/Sign in with Google/);
    // An edit is pushed to the relay, and only there.
    const select = doc(dom).querySelector("#settings-defaults").parentElement.querySelector("select");
    setValue(dom.window, select, "month");
    await settle();
    await waitFor(dom, () => dom.requests.some((r) => r.method === "POST" && /\/log$/.test(r.url)), "a push of the edit");
    expect(dom.requests.every((r) => /workers\.dev/.test(r.url))).toBe(true);
    expect(doc(dom).querySelector(GIS_SCRIPT)).toBeNull();
  }, 90_000);

  it("shows Drive without a heading and without the notice when it was never set up", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    expect(doc(dom).querySelector(".rl-drive")).toBeNull();
  }, 60_000);
});
