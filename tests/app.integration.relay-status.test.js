/**
 * How the app reports and recovers when the relay is not simply fine: offline,
 * paused, over an allowance, a key it does not have, data it cannot read; and
 * how often it asks (debounce, the slow poll that exists only while a meter runs
 * and there is no live socket). The built app, the real Worker, no network.
 */
import { describe, it, expect } from "vitest";
import { guardBuiltApp, settle, setValue, until, wait } from "./app.integration.helpers.js";
import {
  bootApp, doc, fill, makeInvite, newRelay, openSettings, panel, press, stored, waitFor,
} from "./app.integration.relay-helpers.js";
import { createTransport } from "../src/sync/relay.js";

guardBuiltApp();

const seed = {
  projects: [{
    id: "a", name: "Orion", currentRate: 20, currency: "USD",
    createdAt: Date.now() - 86_400_000, sessionGoal: null, overallGoal: null, tasks: [],
  }],
  sessions: [],
};

async function makeAccount(dom, w, options = {}) {
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
  return options;
}

/** The page's fetch, with `answer(url, init)` consulted first: a Response to
 *  put in place of the relay's, or undefined to let the request through. */
const intercept = (dom, answer) => {
  const real = dom.window.fetch;
  dom.window.fetch = async (url, init = {}) => answer(String(url), init) ?? real(url, init);
  return () => { dom.window.fetch = real; };
};
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const syncNow = async (dom) => {
  const b = [...panel(dom).querySelectorAll("button")].find((x) => /^Sync now$/.test(x.textContent));
  b.click();
  await settle();
};
const pip = (dom) => doc(dom).querySelector(".foot .pip");
const edit = (dom, value) => setValue(dom.window, doc(dom).querySelector("#settings-defaults").parentElement.querySelector("select"), value);

describe("when the relay cannot be reached", () => {
  it("says offline, keeps the edit, and sends it when the relay is back", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    const restore = intercept(dom, () => { throw new Error("offline"); });
    edit(dom, "month");
    await settle();
    await syncNow(dom);
    await waitFor(dom, (p) => /Could not reach the relay/.test(p.textContent), "the offline status");
    expect(pip(dom).textContent).toBe("Offline, will retry");
    expect(pip(dom).className).toMatch(/pip-error/);
    // The edit is in the ledger: local use never waited on the relay.
    expect(JSON.parse(stored(dom, "meter:v1")).prefs.find((p) => p.id === "overviewPeriod").value).toBe("month");
    restore();
    await syncNow(dom);
    await waitFor(dom, (p) => /Up to date/.test(p.textContent), "recovery");
    expect(pip(dom).textContent).toMatch(/^Synced/);
  }, 90_000);

  it("says paused, with what it means, when the relay answers 503", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    intercept(dom, () => json(503, { code: "overloaded" }));
    await syncNow(dom);
    await waitFor(dom, (p) => /down or over its daily limit/.test(p.textContent), "the paused status");
    expect(panel(dom).textContent).toMatch(/nothing is lost/);
    expect(pip(dom).textContent).toBe("Relay paused");
  }, 60_000);
});

describe("when a limit or the key is the problem", () => {
  it("says the daily allowance is used and when it resets, and keeps everything pending", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    const resetAt = Date.now() + 3 * 3_600_000;
    intercept(dom, (url, init) => (init.method === "POST" && /\/log$/.test(url)
      ? json(429, { code: "vault_quota", what: "appends", max: 2000, resetAt }) : undefined));
    edit(dom, "week");
    await settle();
    await until(() => /allowance for today is used/.test(panel(dom).textContent), { timeout: 15_000, what: "the allowance status" });
    expect(panel(dom).textContent).toMatch(/resets at \d\d:\d\d/);
    expect(pip(dom).textContent).toBe("Allowance reached");
    expect(JSON.parse(stored(dom, "meter:v1")).prefs.find((p) => p.id === "overviewPeriod").value).toBe("week");
  }, 60_000);

  it("says the key moved on, and plainly that handing it over is a later update", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    intercept(dom, (url) => (/\/log\?/.test(url) ? json(409, { code: "epoch", epoch: 2 }) : undefined));
    await syncNow(dom);
    await waitFor(dom, (p) => /needs the new key/.test(p.textContent), "the rekey status");
    expect(panel(dom).textContent).toMatch(/comes in a later update/);
    expect(pip(dom).textContent).toBe("Needs the new key");
    // Adding a device cannot work without the key either, so it is off.
    expect([...panel(dom).querySelectorAll("button")].find((b) => /^Add a device$/.test(b.textContent)).disabled).toBe(true);
  }, 60_000);

  it("says Meter needs updating when another device wrote a newer format, and loses nothing", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    // A newer build writes a batch this one cannot read, with the account's own key.
    const vault = JSON.parse(stored(dom, "meter:sync"));
    const other = await createTransport({ fetch: w.fetch, vault });
    const head = (await other.pull(0)).head;
    await other.push({ expect: head, bid: "ffffffffffffffffffffffffffffff01", batch: { v: 99, changes: [], meta: {} } });
    await syncNow(dom);
    await waitFor(dom, (p) => /newer format/.test(p.textContent), "the needs-update status");
    expect(pip(dom).textContent).toBe("Update Meter");
    expect(JSON.parse(stored(dom, "meter:v1")).projects.map((p) => p.name)).toEqual(["Orion"]);
  }, 60_000);
});

describe("when it asks", () => {
  it("sends a burst of edits as one push, soon after the last", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    await openSettings(dom);
    const pushes = () => dom.requests.filter((r) => r.method === "POST" && /\/log$/.test(r.url)).length;
    expect(pushes()).toBe(0);
    edit(dom, "month");
    await wait(200);
    edit(dom, "year");
    await wait(900);
    // Not yet: the debounce restarted at the second edit.
    expect(pushes()).toBe(0);
    await until(() => pushes() === 1, { timeout: 5_000, what: "the one push" });
    await wait(600);
    expect(pushes()).toBe(1);
  }, 60_000);

  const running = () => {
    const t = Date.now();
    return {
      projects: seed.projects,
      sessions: [{
        id: "s1", projectId: "a", kind: "billed", rate: 20, currency: "USD", createdAt: t - 60_000, device: "dev-a",
        segments: [{ startedAt: t - 60_000, endedAt: null, lastTick: t }], closedAt: null, deletedAt: null,
      }],
    };
  };
  const slowPoll = (dom) => dom.window.__intervals.find((t) => t.ms === 120_000);
  const pulls = (dom) => dom.requests.filter((r) => r.method === "GET" && /\/log\?/.test(r.url)).length;

  it("polls slowly while a meter runs and there is no live socket", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed: running(), settings: { "meter:device": "dev-a" } });
    await settle();
    await makeAccount(dom, w);
    const poll = slowPoll(dom);
    expect(poll).toBeTruthy();
    const before = pulls(dom);
    poll.fn();
    await until(() => pulls(dom) > before, { what: "the poll's pull" });
  }, 60_000);

  it("does not poll while the socket is up", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed: running(), settings: { "meter:device": "dev-a" }, live: true });
    await settle();
    await makeAccount(dom, w);
    await waitFor(dom, (p) => /Live updates are on/.test(p.textContent), "the socket");
    expect(slowPoll(dom)).toBeUndefined();
  }, 60_000);

  it("does not poll with no meter running", async () => {
    const w = newRelay();
    const dom = await bootApp(w, { seed });
    await settle();
    await makeAccount(dom, w);
    expect(slowPoll(dom)).toBeUndefined();
  }, 60_000);
});
