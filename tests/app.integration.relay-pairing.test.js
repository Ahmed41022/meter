/**
 * Two copies of the app, each on a page of its own, paired through the real
 * Worker: the approver's code and QR, the joiner pasting it, the same 6 digits on
 * both screens, approval, and then edits crossing between them. Also the unhappy
 * ends (denied, expired, a code that is not a code) and presence.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { guardBuiltApp, settle, btn, DIST, setValue, until } from "./app.integration.helpers.js";
import {
  bootApp, doc, fill, heading, makeInvite, newRelay, openSettings, panel, press, stored, waitFor,
} from "./app.integration.relay-helpers.js";

guardBuiltApp();

const project = (id, name) => ({
  id, name, currentRate: 20, currency: "USD", createdAt: Date.now() - 86_400_000, sessionGoal: null, overallGoal: null, tasks: [],
});
const ledgerA = { projects: [project("a", "Orion")], sessions: [] };
const ledgerB = { projects: [project("b", "Beta")], sessions: [] };
const names = (dom) => JSON.parse(stored(dom, "meter:v1")).projects.map((p) => p.name).sort();
const digits = (dom) => panel(dom).querySelector(".rl-digits")?.textContent;

/** A new account on `dom`, ending on the account screen. */
async function makeAccount(dom, w) {
  await openSettings(dom);
  await press(dom, /^Set up Meter Sync$/);
  await press(dom, /^Create an account$/);
  await fill(dom, panel(dom).querySelector("input[placeholder^=MTR]"), await makeInvite(w));
  await press(dom, /^Create account$/);
  await waitFor(dom, (p) => /Save your recovery code/.test(p.textContent), "the recovery code");
  panel(dom).querySelector("input[type=checkbox]").click();
  await settle();
  await press(dom, /^Continue$/);
  await waitFor(dom, (p) => /Up to date/.test(p.textContent), "the first sync");
}

/** A shows the add-device screen; returns the typed code. */
async function showCode(dom) {
  await press(dom, /^Add a device$/);
  await waitFor(dom, (p) => p.querySelector(".rl-codebox"), "the join code");
  return panel(dom).querySelector(".rl-codebox").textContent;
}

/** B opens the join screen and pastes the code. */
async function pasteCode(dom, code) {
  await openSettings(dom);
  await press(dom, /^Set up Meter Sync$/);
  await press(dom, /^Join from another device$/);
  await fill(dom, panel(dom).querySelector("textarea"), code);
  await press(dom, /^Continue$/);
}

/** Both devices showing digits, A asked to approve: everything short of the click. */
async function toApproval(A, B, w) {
  await makeAccount(A, w);
  const code = await showCode(A);
  await pasteCode(B, code);
  await waitFor(B, () => digits(B), "digits on the joiner");
  await waitFor(A, () => digits(A), "digits on the approver");
  return code;
}

describe("adding a device", () => {
  it("shows the QR and the typed code on a white code at least 220 px wide, with a countdown", async () => {
    const w = newRelay();
    const A = await bootApp(w, { seed: ledgerA });
    await settle();
    await makeAccount(A, w);
    const code = await showCode(A);
    expect(heading(A)).toBe("Add a device");
    const svg = panel(A).querySelector(".rl-qr svg");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.innerHTML).toContain('fill="#fff"');
    // The typed code names the relay and carries the code in groups of four.
    expect(code).toMatch(/^meter-sync\.ahmedsaad41022\.workers\.dev\/([0-9A-Z]{4}-){21}[0-9A-Z]{4}$/);
    expect(panel(A).textContent).toMatch(/Expires in \d+:\d\d/);
    expect(panel(A).textContent).toMatch(/It works once/);
    // Size and colour are the stylesheet's: a QR is white in both themes and never narrower than 220 px.
    const css = readFileSync(DIST, "utf8");
    expect(css).toMatch(/\.rl-qr\{background:var\(--qr-paper\);[^}]*min-width:220px/);
    // The paper colour is a token that the dark palette never overrides.
    expect(css).toMatch(/--qr-paper:#FFFFFF/);
    expect(css.match(/--qr-paper:/g)).toHaveLength(1);
    expect(css).toMatch(/\.rl-qr svg\{display:block;width:100%/);
    expect(btn(panel(A), /^Copy code$/)).toBeTruthy();
    expect(btn(panel(A), /^Copy link$/)).toBeTruthy();
  }, 60_000);

  it("pairs: the same 6 digits on both screens, approve, then an edit crosses over", async () => {
    const w = newRelay();
    const A = await bootApp(w, { seed: ledgerA });
    const B = await bootApp(w, { seed: ledgerB });
    await settle();
    await toApproval(A, B, w);

    expect(digits(A)).toMatch(/^\d{6}$/);
    expect(digits(B)).toBe(digits(A));
    expect(panel(A).textContent).toMatch(/A new device wants to join/);
    // The joiner is told its own entries are kept.
    expect(panel(B).textContent).toMatch(/Your entries on this device will be merged in/);
    // No key has moved yet.
    expect(stored(B, "meter:sync")).toBeNull();

    await press(A, /^Approve$/);
    await waitFor(A, (p) => /Device added/.test(p.textContent), "the approval to finish");
    await waitFor(B, (p) => /Joined\./.test(p.textContent), "the joiner to finish");
    expect(JSON.parse(stored(B, "meter:sync")).vaultId).toBe(JSON.parse(stored(A, "meter:sync")).vaultId);
    expect(stored(B, "meter:sync:join")).toBeNull();

    // B adopts the account's ledger and keeps its own entry: merged, nothing lost.
    await press(B, /^Done$/);
    await waitFor(B, (p) => /Up to date/.test(p.textContent), "B's first sync");
    expect(names(B)).toEqual(["Beta", "Orion"]);
    // And what B had that the account did not is sent on, so A gets it too.
    await press(A, /^Done$/);
    await press(A, /^Sync now$/);
    await waitFor(A, (p) => /Up to date/.test(p.textContent), "A's sync");
    await until(() => names(A).length === 2, { what: "A to receive Beta" });
    expect(names(A)).toEqual(["Beta", "Orion"]);

    // An edit made on A appears on B after a sync.
    await openSettings(A);
    const select = doc(A).querySelector("#settings-defaults").parentElement.querySelector("select");
    setValue(A.window, select, "month");
    await settle();
    await until(() => A.requests.some((r) => r.method === "POST" && /\/log$/.test(r.url)), { what: "A to push" });
    await press(B, /^Sync now$/);
    await until(() => (JSON.parse(stored(B, "meter:v1")).prefs ?? []).some((p) => p.id === "overviewPeriod" && p.value === "month"),
      { what: "the edit to reach B" });
    // Which B then shows.
    await openSettings(B);
    expect(doc(B).querySelector("#settings-defaults").parentElement.querySelector("select").value).toBe("month");
  }, 120_000);

  it("lists both devices with their names once paired, and Remove is off for the other", async () => {
    const w = newRelay();
    const A = await bootApp(w, { seed: ledgerA });
    const B = await bootApp(w, { seed: ledgerB });
    await settle();
    await toApproval(A, B, w);
    await press(A, /^Approve$/);
    await waitFor(B, (p) => /Joined\./.test(p.textContent), "the joiner to finish");
    await press(B, /^Done$/);
    await waitFor(B, (p) => p.querySelectorAll(".rl-device").length === 2, "B's device list");
    // B names itself; the names are sealed with K, which the relay never has.
    await fill(B, panel(B).querySelector(".rl-name input"), "Pixel");
    await press(B, /^Save$/);
    await press(A, /^Done$/);
    await waitFor(A, (p) => p.querySelectorAll(".rl-device").length === 2 && /Pixel/.test(p.textContent), "A to list Pixel");
    const rows = [...panel(A).querySelectorAll(".rl-device")];
    expect(rows.filter((r) => /this device/.test(r.textContent))).toHaveLength(1);
    const other = rows.find((r) => /Pixel/.test(r.textContent));
    expect(other.querySelector("button").disabled).toBe(true);
    expect(panel(A).textContent).toMatch(/Removing a device comes in the next update/);
    expect(JSON.stringify(A.requests)).not.toContain("Pixel");
  }, 120_000);

  it("denies a request, and the other device is told nothing was shared", async () => {
    const w = newRelay();
    const A = await bootApp(w, { seed: ledgerA });
    const B = await bootApp(w, { seed: ledgerB });
    await settle();
    await toApproval(A, B, w);
    await press(A, /^Deny$/);
    expect(panel(A).textContent).toMatch(/Denied\. Nothing was shared/);
    await waitFor(B, (p) => /said no/.test(p.textContent), "B to hear");
    expect(stored(B, "meter:sync")).toBeNull();
    expect(stored(B, "meter:sync:join")).toBeNull();
  }, 120_000);

  it("reports an expired code on both devices", async () => {
    const w = newRelay();
    const A = await bootApp(w, { seed: ledgerA });
    const B = await bootApp(w, { seed: ledgerB });
    await settle();
    await makeAccount(A, w);
    // Eleven minutes pass: on A's own clock (which it checks the countdown by)...
    const real = A.window.Date.now.bind(A.window.Date);
    let skew = 0;
    A.window.Date.now = () => real() + skew;
    const code = await showCode(A);
    skew = 11 * 60_000;
    w.skew = skew; // ...and on the relay's, which is what the joiner meets.
    await waitFor(A, (p) => /That code expired/.test(p.textContent), "the approver to notice");
    expect(btn(panel(A), /^Make a new code$/)).toBeTruthy();
    await pasteCode(B, code);
    await waitFor(B, (p) => /expired or was already used/.test(p.textContent), "the joiner to be told");
    expect(stored(B, "meter:sync")).toBeNull();
  }, 120_000);

  it("rejects a code that is not a code before asking the relay anything", async () => {
    const w = newRelay();
    const B = await bootApp(w, { seed: ledgerB });
    await settle();
    await pasteCode(B, "relay.example.workers.dev/NOT-A-CODE");
    await waitFor(B, (p) => /Could not join/.test(p.textContent) || p.querySelector(".rl-problem"), "the refusal");
    expect(panel(B).querySelector(".rl-problem").textContent).toMatch(/characters|checksum|looks like/i);
    expect(B.requests).toEqual([]);
  }, 60_000);

  it("says how to leave first when this device already has an account", async () => {
    const w = newRelay();
    const A = await bootApp(w, { seed: ledgerA });
    await settle();
    await makeAccount(A, w);
    const keep = Object.fromEntries(["meter:sync", "meter:sync:meta", "meter:sync:sent", "meter:device"].map((k) => [k, stored(A, k)]).filter(([, v]) => v));
    const again = await bootApp(w, { seed: ledgerA, settings: keep, hash: "#join=relay.example.workers.dev/AAAA" });
    await settle();
    expect(again.window.location.hash).toBe("");
    expect(heading(again)).toBe("Your account");
    expect(panel(again).querySelector(".rl-problem").textContent).toMatch(/already has an account.+Leave on this device first/);
  }, 60_000);

  it("brings a restarted device back to the same account and syncs on opening", async () => {
    const w = newRelay();
    const A = await bootApp(w, { seed: ledgerA });
    await settle();
    await makeAccount(A, w);
    const keys = ["meter:sync", "meter:sync:meta", "meter:sync:sent", "meter:device"];
    const keep = Object.fromEntries(keys.map((k) => [k, stored(A, k)]).filter(([, v]) => v));
    const ledger = JSON.parse(stored(A, "meter:v1"));
    A.window.close();
    const again = await bootApp(w, { seed: ledger, settings: keep });
    await settle();
    await openSettings(again);
    expect(heading(again)).toBe("Your account");
    await waitFor(again, (p) => /Up to date/.test(p.textContent), "the sync on opening");
    // It carried on from where it was: the saved cursor, not a fresh start.
    expect(JSON.parse(stored(again, "meter:sync")).deviceId).toBe(JSON.parse(keep["meter:sync"]).deviceId);
  }, 60_000);
});

describe("with a live socket", () => {
  it("shows which device is running a meter, and never writes that to the ledger", async () => {
    const w = newRelay();
    const now = Date.now();
    const running = {
      projects: [project("a", "Orion")],
      sessions: [{
        id: "s1", projectId: "a", kind: "billed", rate: 20, currency: "USD", createdAt: now - 60_000, device: "dev-a",
        segments: [{ startedAt: now - 60_000, endedAt: null, lastTick: now }], closedAt: null, deletedAt: null,
      }],
    };
    const A = await bootApp(w, { seed: running, settings: { "meter:device": "dev-a" }, live: true });
    const B = await bootApp(w, { seed: ledgerB, settings: { "meter:device": "dev-b" }, live: true });
    await settle();
    await toApproval(A, B, w);
    await press(A, /^Approve$/);
    await waitFor(B, (p) => /Joined\./.test(p.textContent), "the joiner to finish");
    await press(B, /^Done$/);
    await waitFor(B, (p) => /Up to date/.test(p.textContent) && /Live updates are on/.test(p.textContent), "B to sync, live");
    // A said it was running before B existed. When A's connection drops and comes
    // back it says so again at once, which is how a newcomer learns without
    // waiting out the minute.
    const vault = JSON.parse(stored(A, "meter:sync"));
    const entry = await w.env.VAULT.entry(`v:${vault.vaultId}`);
    entry.ctx.sockets.find((ws) => !ws.closed && ws.att.dev === vault.deviceId).close(1006, "dropped");
    await waitFor(B, (p) => /Running on .+, seen \d+ s ago/.test(p.textContent), "presence on B");
    expect(panel(B).textContent).toMatch(/Live updates are on/);
    // Presence is on screen only: it is not in B's ledger or its stored progress.
    for (const key of ["meter:v1", "meter:sync", "meter:sync:meta", "meter:sync:sent"]) {
      expect(stored(B, key) ?? "").not.toMatch(/presence|seen \d+ s/);
    }
    expect(JSON.parse(stored(B, "meter:v1")).sessions.map((s) => s.id)).toContain("s1");
  }, 120_000);

  it("tells a device that has just reloaded which device runs the meter, without waiting out the minute", async () => {
    const w = newRelay();
    const now = Date.now();
    const running = {
      projects: [project("a", "Orion")],
      sessions: [{
        id: "s1", projectId: "a", kind: "billed", rate: 20, currency: "USD", createdAt: now - 60_000, device: "dev-a",
        segments: [{ startedAt: now - 60_000, endedAt: null, lastTick: now }], closedAt: null, deletedAt: null,
      }],
    };
    const A = await bootApp(w, { seed: running, settings: { "meter:device": "dev-a" }, live: true });
    const B = await bootApp(w, { seed: ledgerB, settings: { "meter:device": "dev-b" }, live: true });
    await settle();
    await toApproval(A, B, w);
    await press(A, /^Approve$/);
    await waitFor(B, (p) => /Joined\./.test(p.textContent), "the joiner to finish");
    await press(B, /^Done$/);
    await waitFor(B, (p) => /Up to date/.test(p.textContent) && /Live updates are on/.test(p.textContent), "B to sync, live");
    // B reloads: a new page with what B had stored, and no presence at all.
    // A's minute is far off, so only an answer to B's hello can reach it in time.
    const keys = ["meter:sync", "meter:sync:meta", "meter:sync:sent", "meter:device"];
    const keep = Object.fromEntries(keys.map((k) => [k, stored(B, k)]).filter(([, v]) => v));
    const ledger = JSON.parse(stored(B, "meter:v1"));
    B.window.close();
    const again = await bootApp(w, { seed: ledger, settings: keep, live: true });
    await settle();
    await openSettings(again);
    await waitFor(again, (p) => /Running on .+, seen \d+ s ago/.test(p.textContent), "presence on the reloaded B", 15_000);
  }, 120_000);

  it("delivers an edit made on one device to the other with no manual sync", async () => {
    const w = newRelay();
    const A = await bootApp(w, { seed: ledgerA, live: true });
    const B = await bootApp(w, { seed: ledgerB, live: true });
    await settle();
    await toApproval(A, B, w);
    await press(A, /^Approve$/);
    await waitFor(B, (p) => /Joined\./.test(p.textContent), "the joiner to finish");
    await press(B, /^Done$/);
    await waitFor(B, (p) => /Up to date/.test(p.textContent), "B to sync");
    await press(A, /^Done$/);
    await openSettings(A);
    setValue(A.window, doc(A).querySelector("#settings-defaults").parentElement.querySelector("select"), "year");
    await settle();
    await until(() => (JSON.parse(stored(B, "meter:v1")).prefs ?? []).some((p) => p.id === "overviewPeriod" && p.value === "year"),
      { timeout: 15_000, what: "the edit to reach B by itself" });
  }, 120_000);
});
