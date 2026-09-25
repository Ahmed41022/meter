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

/** A silent request happens behind the UI and should give up quickly. An
 *  interactive one is waiting for a person to read a consent screen, so it gets
 *  minutes rather than seconds. */
const SILENT_TIMEOUT_MS = 30_000;
const INTERACTIVE_TIMEOUT_MS = 180_000;

const GIS_MESSAGES = {
  popup_failed_to_open: "The sign-in window could not open. A popup blocker may be stopping it.",
  popup_closed: "Sign-in was closed before it finished.",
};

const describeGis = (err) =>
  GIS_MESSAGES[err?.type] ?? err?.message ?? "Google refused the sign-in request.";

/**
 * Whether Google will even consider this page's origin.
 *
 * It will not accept `file://` — a page opened from disk has no origin to
 * authorise, and reports itself as `null`. That is exactly what the packaged
 * desktop build is, so asking there can only ever produce an error popup.
 * Knowing in advance lets the UI explain instead of offering a button that
 * cannot work. `localhost` is allowed because Google makes an explicit
 * exception for it.
 */
export const originAllowed = (win = globalThis) => {
  const origin = win?.location?.origin ?? "";
  if (origin.startsWith("https:")) return true;
  if (!origin.startsWith("http:")) return false;
  const host = win?.location?.hostname ?? "";
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
};

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

  const request = async ({ prompt, timeoutMs = SILENT_TIMEOUT_MS }) => {
    const tokenClient = await clientFor();
    // One request at a time. Two in flight would show the consent popup twice,
    // and a browser blocks the second.
    if (pending) return pending;
    const run = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      // Nothing here is guaranteed to be called back. A request Google will not
      // answer at all leaves both callbacks silent, and an unsettled promise is
      // worse than a failed one: `pending` stays set, so every later request
      // returns the same promise that never resolves, and the app sits on
      // "Syncing…" with the button disabled until it is restarted.
      const timer = setTimeout(
        () => finish(reject, new Error("Google did not answer the sign-in request.")),
        timeoutMs,
      );
      tokenClient.callback = (response) => {
        if (response?.error) {
          return finish(reject, new Error(response.error_description || response.error));
        }
        token = response.access_token;
        expiresAt = now() + Number(response.expires_in ?? 3600) * 1000;
        finish(resolve, token);
      };
      // GIS reports a refused or impossible request HERE, not through
      // `callback`: a blocked popup, a window closed before consent, an origin
      // Google will not accept. Setting only `callback` leaves every one of
      // those hanging.
      tokenClient.error_callback = (err) => finish(reject, new Error(describeGis(err)));
      try {
        tokenClient.requestAccessToken(prompt === undefined ? {} : { prompt });
      } catch (e) {
        finish(reject, e);
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

    /** Explicit, for a button. `select_account` rather than the default, because
     *  the default silently reuses whichever account the browser is already
     *  signed in to — and someone with two Google accounts has no way to say
     *  which one holds their ledger. */
    signIn: () => request({ prompt: "select_account", timeoutMs: INTERACTIVE_TIMEOUT_MS }),

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
