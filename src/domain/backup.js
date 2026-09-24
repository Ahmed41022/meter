/**
 * How long the ledger has gone without being written out to a file the user
 * actually holds.
 *
 * Browser storage is not a backup: it is one profile, on one machine, that a
 * cleared cache or a reinstalled app takes with it. The only copy that survives
 * that is an exported file, so the app has to know when the last one was made.
 *
 * Like the rest of `domain/`, nothing here reads the clock or storage — `now` is
 * passed in.
 */

const DAY = 86_400_000;

/** How long is too long. A week is short enough that a lost week is annoying
 *  rather than ruinous, and long enough not to nag. */
export const STALE_DAYS = 7;

/** Absent means never, which is the state every store starts in and the state
 *  a restored file arrives in unless it carried one of its own. */
export const lastBackupAt = (state) => state?.lastBackupAt ?? null;

/** Stamped by whatever actually hands the user a file, never by opening a
 *  dialog: a backup that was cancelled is not a backup. */
export const recordBackup = (state, now) => ({ ...state, lastBackupAt: now });

const live = (list) => (list ?? []).filter((r) => !r.deletedAt);

/** Records written since the last backup — the work that would actually be
 *  lost. Everything counts as new when there has never been a backup. */
export const unsavedSince = (state, at) => {
  const after = (r) => at === null || (r.createdAt ?? 0) > at;
  return live(state?.sessions).filter(after).length
    + live(state?.earnings).filter(after).length;
};

/**
 * Whether the user is carrying work that exists in no file.
 *
 * Two guards against nagging, because a banner that cries wolf is a banner
 * people learn to look past:
 *
 *  - An empty ledger is never stale. There is nothing to lose yet.
 *  - Neither is a ledger nothing has been added to since its last backup,
 *    however long ago that was. The existing file is still complete, so age
 *    alone is not a reason to ask again.
 */
export const backupState = (state, now, staleDays = STALE_DAYS) => {
  const at = lastBackupAt(state);
  const unsaved = unsavedSince(state, at);
  const age = at === null ? null : Math.max(0, now - at);
  return {
    at,
    unsaved,
    days: age === null ? null : Math.floor(age / DAY),
    never: at === null,
    stale: unsaved > 0 && (at === null || age >= staleDays * DAY),
  };
};
