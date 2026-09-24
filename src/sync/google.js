/**
 * Signing in to Google, from a page with no server behind it.
 *
 * Google Identity Services, token model: the page asks for an access token, gets
 * one good for about an hour, and asks again when it expires. There is no refresh
 * token and no client secret, because a page cannot keep a secret — which is also
 * why the client id below is not one. It identifies the app; it authorises
 * nothing on its own.
 *
 * The id is entered by the user rather than built in. It belongs to THEIR Google
 * Cloud project, tied to THEIR authorised origin, so hard-coding one would mean
 * everybody shared an app registration that only worked on one domain.
 *
 * `drive.appdata` is the narrowest scope that can do the job: a hidden folder
 * this app owns. It cannot read one other thing in the user's Drive, which is
 * worth more than the convenience of the broader scope.
 */
export const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const GIS = "https://accounts.google.com/gsi/client";

/** Renew a little early. A token that expires mid-request reads to the user as a
 *  sync that failed for no reason. */
const EARLY_MS = 120_000;

/** Long enough for a slow connection, short enough that a blocked script is
 *  reported rather than left spinning. A tracker blocker will silently never
 *  fire `onerror`, so a timeout is the only thing that notices. */
const LOAD_TIMEOUT_MS = 15_000;

/** Loads the Google script once, however many callers ask. */
export function loadGis(win = globalThis, src = GIS, timeoutMs = LOAD_TIMEOUT_MS) {
  if (win.__meterGis) return win.__meterGis;
  win.__meterGis = new Promise((resolve, reject) => {
    if (win.google?.accounts?.oauth2) return resolve(win.google);
    // Never leave a rejected promise cached: someone who unblocks the script and
    // presses the button again must get a fresh attempt rather than the old
    // failure.
    const fail = (message) => {
      win.__meterGis = null;
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail("Google sign-in did not load. A blocker or a firewall may be stopping it."),
      timeoutMs,
    );
    const el = win.document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => {
      clearTimeout(timer);
      if (win.google?.accounts?.oauth2) resolve(win.google);
      else fail("Google sign-in loaded but exposed nothing.");
    };
    el.onerror = () => {
      clearTimeout(timer);
      fail("Could not reach Google sign-in.");
    };
    win.document.head.appendChild(el);
  });
  return win.__meterGis;
}

/**
 * An access-token source.
 *
 * `getToken()` hands back a live token, asking Google only when the one it holds
 * is missing or nearly expired. The first call may show the consent screen; later
 * ones are normally silent, because consent has already been given.
 */
export function createAuth({ clientId, win = globalThis, load = loadGis, now = () => Date.now() }) {
  let token = null;
  let expiresAt = 0;
  let client = null;
  let pending = null;

  const fresh = () => token !== null && now() < expiresAt - EARLY_MS;

  const clientFor = async () => {
    if (client) return client;
    const google = await load(win);
    client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: () => {},
    });
    return client;
  };

  const request = async ({ prompt }) => {
    const tokenClient = await clientFor();
    // One request at a time. Two in flight would show the consent popup twice,
    // and a browser blocks the second.
    if (pending) return pending;
    const run = new Promise((resolve, reject) => {
      tokenClient.callback = (response) => {
        if (response?.error) {
          return reject(new Error(response.error_description || response.error));
        }
        token = response.access_token;
        expiresAt = now() + Number(response.expires_in ?? 3600) * 1000;
        resolve(token);
      };
      try {
        tokenClient.requestAccessToken(prompt === undefined ? {} : { prompt });
      } catch (e) {
        reject(e);
      }
    });
    // Cleared here rather than inside the callback, and this is not a style
    // choice. The executor above runs synchronously, so a callback that fires
    // synchronously would clear `pending` BEFORE the assignment below put the
    // promise there — leaving it permanently non-null and every later request
    // returning the first one's stale token forever.
    pending = run;
    run.then(
      () => { if (pending === run) pending = null; },
      () => { if (pending === run) pending = null; },
    );
    return run;
  };

  return {
    /** True when a token is in hand, which is as much as a page can know about
     *  being "signed in" — there is no session here, only a token. */
    hasToken: () => fresh(),

    /** Explicit: shows the consent screen if Google wants to. For a button. */
    signIn: () => request({ prompt: "" }),

    /** Implicit: for syncing. Returns null rather than popping a dialog the user
     *  did not ask for, so a background sync can fail quietly and let the UI ask. */
    getToken: async () => {
      if (fresh()) return token;
      try {
        return await request({ prompt: "none" });
      } catch {
        return null;
      }
    },

    /** Forgets the token and tells Google to drop it. The page holds nothing
     *  afterwards, so signing out is real rather than cosmetic. */
    signOut: async () => {
      const held = token;
      token = null;
      expiresAt = 0;
      if (held) {
        try {
          const google = await load(win);
          google.accounts.oauth2.revoke(held, () => {});
        } catch { /* already gone as far as this page is concerned */ }
      }
    },
  };
}
