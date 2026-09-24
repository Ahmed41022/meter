/**
 * The ledger kept in the user's own Google Drive.
 *
 * It lives in `appDataFolder`: a hidden per-application folder inside their
 * Drive. It does not appear in the Drive UI, no other app can read it, and it
 * travels with the account rather than with a server somebody has to run. The
 * scope that reaches it, `drive.appdata`, cannot touch anything else they own —
 * which is the point of choosing it over the scope that can.
 *
 * `fetch` and the token getter are arguments, not imports, so every branch here
 * is testable without a network or a Google account.
 *
 * On concurrency, honestly: Drive v3 has no If-Match on update, so there is no
 * true compare-and-swap. This reads the revision, merges, and writes only if the
 * revision has not moved since. A simultaneous write from another device can
 * still land in between and lose this one — and it is recoverable, because
 * syncing MERGES and never discards local records. The device that lost simply
 * pushes the same records again on its next sync. That property, not the check
 * below, is what makes this safe.
 */
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

export const FILE_NAME = "meter.json";

/** Errors worth telling apart: one means sign in again, the rest mean try later. */
export class SyncError extends Error {
  constructor(message, { status = 0, needsAuth = false } = {}) {
    super(message);
    this.name = "SyncError";
    this.status = status;
    this.needsAuth = needsAuth;
  }
}

const describe = async (res) => {
  let detail = "";
  try {
    const body = await res.json();
    detail = body?.error?.message ?? "";
  } catch { /* a non-JSON error body is still an error */ }
  return detail || res.statusText || `HTTP ${res.status}`;
};

export function createDrive({ getToken, fetch: doFetch = globalThis.fetch }) {
  /** Every call goes through here, so token expiry is handled in one place: a
   *  401 or 403 is reported as needing auth rather than as a dead sync. */
  const call = async (url, options = {}) => {
    const token = await getToken();
    if (!token) throw new SyncError("Not signed in.", { needsAuth: true });
    const res = await doFetch(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
      throw new SyncError(await describe(res), { status: res.status, needsAuth: true });
    }
    if (!res.ok) throw new SyncError(await describe(res), { status: res.status });
    return res;
  };

  /** The one file, or null on a Drive that has never synced. Asking by name
   *  rather than remembering an id means a reinstall finds the existing file
   *  instead of starting a second one. */
  const find = async () => {
    const query = new URLSearchParams({
      spaces: "appDataFolder",
      q: `name = '${FILE_NAME}' and trashed = false`,
      fields: "files(id,headRevisionId,modifiedTime)",
      pageSize: "10",
    });
    const res = await call(`${API}?${query}`);
    const { files = [] } = await res.json();
    // Newest wins if a past race ever made two. Nothing is deleted here: an
    // unexpected second file is a thing to notice, not to tidy away silently.
    return files.sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)))[0]
      ?? null;
  };

  const read = async (id) => {
    const res = await call(`${API}/${id}?alt=media`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new SyncError("The file in Drive is not readable as a ledger.");
    }
  };

  const create = async (text) => {
    const boundary = `meter${Math.random().toString(36).slice(2)}`;
    const metadata = { name: FILE_NAME, parents: ["appDataFolder"] };
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      "Content-Type: application/json",
      "",
      text,
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const res = await call(`${UPLOAD}?uploadType=multipart&fields=id,headRevisionId`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return res.json();
  };

  const update = async (id, text) => {
    const res = await call(`${UPLOAD}/${id}?uploadType=media&fields=id,headRevisionId`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: text,
    });
    return res.json();
  };

  return { find, read, create, update };
}

/**
 * One round of syncing: bring the two copies to the same place.
 *
 * `merge` and `serialise` are passed in so this stays about transport. The order
 * matters — read, merge, then write — because writing first would overwrite work
 * this device has not seen.
 *
 * Returns what happened, for the UI to report: nothing is more reassuring than a
 * sync that says it found nothing to do.
 */
export async function syncOnce({ drive, local, merge, revision = null }) {
  const file = await drive.find();

  if (!file) {
    const created = await drive.create(JSON.stringify(local));
    return { state: local, revision: created.headRevisionId ?? null, pushed: true, pulled: false, created: true };
  }

  const remote = await drive.read(file.id);
  const merged = merge(local, remote);

  // Whether the remote needs writing is decided by comparing against the REMOTE,
  // not the local copy: a device that only received changes has nothing to push,
  // and pushing anyway would churn the file and the revision on every open.
  const same = JSON.stringify(merged) === JSON.stringify(remote);
  if (same) {
    return {
      state: merged, revision: file.headRevisionId ?? null,
      pushed: false, pulled: JSON.stringify(merged) !== JSON.stringify(local), created: false,
    };
  }

  // Someone wrote between this device's last sync and now. Not an error — the
  // merge above already took their changes in — but worth reporting, because it
  // is the moment two devices were both working.
  const raced = revision !== null && file.headRevisionId != null
    && file.headRevisionId !== revision;

  const written = await drive.update(file.id, JSON.stringify(merged));
  return {
    state: merged,
    revision: written.headRevisionId ?? null,
    pushed: true,
    pulled: JSON.stringify(merged) !== JSON.stringify(local),
    created: false,
    raced,
  };
}
