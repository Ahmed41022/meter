/**
 * What the relay screens say, as plain functions of what happened. Kept apart
 * from the components so every sentence is tested once and the screens only
 * choose where to put it.
 *
 * The vocabulary comes from two places: the engine's status words (engine.js,
 * `sync`) and the TransportError codes of relay.js `failure`. Each is mapped
 * to a sentence a person can act on, never to a raw code.
 */
import { CodeError } from "./codes.js";
import { TransportError } from "./engine.js";

const pad = (n) => String(n).padStart(2, "0");

/** A time of day in the viewer's own clock, for "it resets at 14:00". */
export const timeOfDay = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** "12 s ago", "3 min ago": for presence and last-seen, where seconds matter. */
export const secondsAgo = (at, now) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

// ------------------------------------------------------------------ failures

const AUTH_WORDS = {
  invite_invalid: "That invite code is not valid. Check it and try again.",
  invite_revoked: "That invite was cancelled by whoever made it. Ask for a new one.",
  invite_expired: "That invite has expired. Ask for a new one.",
  invite_required: "This relay only creates accounts for people with an invite. Enter an invite code.",
};

/**
 * Why a relay call failed, as `{ message, retry }`. `retry` means the same step
 * can simply be tried again; `field` names the input the message is about, so a
 * screen can point at it.
 */
export function explainFailure(e) {
  if (e instanceof CodeError) return { message: e.message, retry: false, field: "code" };
  if (!(e instanceof TransportError)) return { message: "Something went wrong. Nothing was lost; try again.", retry: true };
  const code = e.detail?.code;
  switch (e.code) {
    case "auth":
      return { message: AUTH_WORDS[code] ?? "The relay refused this request.", retry: false, field: code?.startsWith("invite") ? "invite" : undefined };
    case "conflict":
      if (code === "invite_used") return { message: "That invite has already been used. Each invite makes one account. Ask for a new one.", retry: false, field: "invite" };
      return { message: "The relay says something changed in the meantime. Try again.", retry: true };
    case "deleted":
      return { message: "The account this invite made was deleted.", retry: false };
    case "quota":
      if (e.detail?.what === "relay_full") return { message: "This relay is full and is not making new accounts right now. Try again later, or use a relay of your own.", retry: false };
      if (e.detail?.what === "creation") {
        const when = Number.isFinite(e.detail.resetAt) ? ` It opens again at ${timeOfDay(e.detail.resetAt)}.` : "";
        return { message: `Too many accounts were made from this network today.${when}`, retry: false };
      }
      return { message: "The relay has reached a limit for now. Try again later.", retry: true };
    case "network":
      return { message: "Could not reach the relay. Check your connection and try again.", retry: true };
    case "paused":
      return { message: "The relay is busy or paused. Try again in a little while.", retry: true };
    case "gone":
      return { message: "The relay no longer has that. Start again.", retry: false };
    default:
      return { message: e.message && e.message !== e.code ? e.message : "The relay answered in a way Meter does not understand.", retry: false };
  }
}

// -------------------------------------------------------------------- status

const quotaWords = (s) => {
  const what = s.detail?.what;
  const reset = Number.isFinite(s.detail?.resetAt) ? ` It resets at ${timeOfDay(s.detail.resetAt)}.` : "";
  if (what === "appends") return `Your sync allowance for today is used.${reset} Everything stays on this device and is sent after the reset.`;
  if (what === "bytes") return "This account has reached its storage limit on the relay. Nothing is lost here, but new changes cannot be sent until space is freed.";
  if (what === "snapshot_size") return "The ledger is too large for this relay to hold. Nothing is lost here.";
  if (what === "devices") return "The account already has the most devices it can have.";
  return `The relay has reached a limit for this account.${reset}`;
};

/**
 * The sync status as `{ tone, label, detail }`.
 *
 *  tone   "ok" | "busy" | "warn" | "bad": the footer dot and the colour of the line
 *  label  the short phrase (the footer reads this)
 *  detail the sentence for the Settings panel: what it means and what to do
 *
 * `status` is what the app's sync hook keeps: `{ state, at, retryAt, detail,
 * message }` where `state` is the engine's status word or one of the app's own
 * ("idle", "syncing", "unsupported"), and `detail` is the engine's
 * TransportError detail for a quota.
 */
export function statusWords(status, now = Date.now()) {
  const s = status ?? { state: "idle" };
  const retry = Number.isFinite(s.retryAt) && s.retryAt > now ? ` Trying again at ${timeOfDay(s.retryAt)}.` : "";
  switch (s.state) {
    case "idle":
      return { tone: "busy", label: "Starting…", detail: "Meter Sync is starting." };
    case "syncing":
      return { tone: "busy", label: "Syncing…", detail: "Syncing now." };
    case "ok":
      return {
        tone: "ok",
        label: s.at ? `Synced ${secondsAgo(s.at, now)}` : "Synced",
        detail: s.at ? `Up to date. Last synced ${secondsAgo(s.at, now)}.` : "Up to date.",
      };
    case "busy":
      return { tone: "busy", label: "Busy, will retry", detail: `Another device kept writing at the same moment, so this round stopped early. Nothing is lost.${retry}` };
    case "backoff":
    case "network":
      return { tone: "warn", label: "Offline, will retry", detail: `Could not reach the relay. Your changes are kept on this device and will be sent when it is back.${retry}` };
    case "paused":
      return { tone: "warn", label: "Relay paused", detail: `The relay is down or over its daily limit. Everything still works here and nothing is lost; Meter will try again later.${retry}` };
    case "quota":
      return { tone: "warn", label: "Allowance reached", detail: quotaWords(s) + retry };
    case "auth":
      return { tone: "bad", label: "Device removed", detail: "This device was removed from the account. Your ledger here is untouched, but it no longer syncs. To sync again, leave on this device and join from another device." };
    case "deleted":
      return { tone: "bad", label: "Account deleted", detail: "The account was deleted, so nothing syncs any more. Your ledger on this device is untouched. You can leave the account here, and make or join another." };
    case "rekey":
      return { tone: "bad", label: "Needs the new key", detail: "This device needs the new key. The account's key was changed, and handing it to this device is not built yet; it comes in a later update. Until then this device cannot sync. Your ledger here is untouched." };
    case "needs-update":
      return { tone: "bad", label: "Update Meter", detail: "Another device wrote data in a newer format than this version reads. Update Meter to keep syncing. Nothing was changed or lost." };
    case "unsupported":
      return { tone: "bad", label: "Cannot sync here", detail: s.message ?? "Sync needs a secure page (https) and a current browser." };
    default:
      return { tone: "warn", label: "Sync problem", detail: s.message ?? "Sync stopped for a reason Meter does not recognise." };
  }
}

/** The word the existing `.pip-*` classes understand. */
export const pipState = (tone, state) =>
  (state === "syncing" ? "syncing" : tone === "ok" ? "ok" : tone === "busy" ? "idle" : "error");

// ------------------------------------------------------------- device names

/** A starting name for this device. Plain words a person would recognise in a
 *  list of their own devices; editable afterwards. */
export function defaultDeviceName(win = globalThis) {
  const ua = String(win.navigator?.userAgent ?? "");
  const loc = win.location;
  if (/Electron/i.test(ua)) return "Meter desktop";
  if (/Android/i.test(ua)) return "Android phone";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iPhone or iPad";
  if (loc && /^(127\.0\.0\.1|localhost)$/.test(loc.hostname)) return "This computer (local)";
  return "Browser";
}

/** Names are sealed and short. Trimmed, collapsed, capped, never empty. */
export const cleanDeviceName = (text, fallback = "This device") => {
  const t = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return t || fallback;
};
