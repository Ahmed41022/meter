import { recordBackup } from "../../domain/backup.js";
import { toCsv } from "../../domain/csv.js";

/** Hands the user a file. Throws rather than failing quietly if the browser
 *  will not make one, so nothing downstream records a backup that never
 *  happened. Shared by every export, which is why it is not inside the
 *  handlers. */
export const download = (name, text, type) => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

export const stamp = () => `meter-${new Date().toISOString().slice(0, 10)}`;

/** A CSV as a file: the byte-order mark first, for the reason `exportCsv`
 *  gives, so no export forgets it. */
export const downloadCsv = (name, text) =>
  download(name, `\uFEFF${text}`, "text/csv;charset=utf-8");

/**
 * Everything that hands a ledger out or takes one in: the backup and CSV
 * exports, restoring from a file, and downloading an unreadable ledger. They
 * share `download` and the file-name stamp, and all of them report through the
 * same toast and commit path as the rest of the app, so they are given those
 * rather than owning any state. Not a hook: nothing here needs one.
 */
export function backupHandlers({
  stateRef, commit, flash, write, store, unreadable, restoring, setRestoring, setOpenProjectId,
  setUnreadable,
}) {
  const exportBackup = () => {
    // Serialised BEFORE the stamp, so the file records the state the user asked
    // for rather than one that claims to have already been backed up.
    download(`${stamp()}.json`, JSON.stringify(stateRef.current, null, 2), "application/json");
    commit((st) => recordBackup(st, Date.now()));
  };

  /**
   * Deliberately does NOT count as a backup.
   *
   * A CSV is for something else to read — a tax return, a spreadsheet. It drops
   * segments, goals, objectives and every id, so the app cannot read it back.
   * Letting it clear the backup nudge would leave someone believing they had a
   * copy they could restore from, which is the one mistake this whole feature
   * exists to prevent.
   *
   * The file starts with a byte-order mark. Without one, Excel on Windows reads
   * a CSV in the machine's ANSI code page instead of UTF-8, and every Arabic
   * name, emoji and "·" in it comes out as mojibake.
   */
  const exportCsv = () => {
    downloadCsv(`${stamp()}.csv`, toCsv(stateRef.current, Date.now()));
  };

  /**
   * Picking a file changes nothing yet. Restoring REPLACES the ledger rather
   * than merging into it, so the file is read, checked and then held until the
   * user has seen what it holds beside what it would replace. Replacing on the
   * pick itself, with a seven-second Undo the only word of what had happened,
   * was how a whole ledger could be swapped for an old file by mistake.
   */
  const importBackup = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.sessions)) throw new Error();
        setRestoring({ name: file.name, state: parsed });
      } catch {
        flash("That file isn't a Meter backup.");
      }
    };
    reader.readAsText(file);
  };

  /** The replacement itself, once agreed to. The Undo stays, for the second
   *  thoughts that only come once it has happened. */
  const confirmRestore = () => {
    const snapshot = stateRef.current;
    commit(() => restoring.state);
    setRestoring(null);
    setOpenProjectId(null);
    flash("Backup restored.", "Undo", () => commit(() => snapshot));
  };

  /** Hands over the ledger that could not be read, exactly as it was stored,
   *  for repairing or keeping. Where no copy could be kept in the browser, the
   *  store has been refusing to save over it; once the user holds this file
   *  that refusal has done its job, so saving resumes with what is on screen. */
  const downloadUnreadable = () => {
    try {
      download(`${stamp()}-unreadable.json`, unreadable.raw, "application/json");
    } catch {
      flash("The file couldn't be made, so nothing has changed.");
      return;
    }
    if (store.held) {
      store.release();
      write(stateRef.current);
    }
    setUnreadable((u) => ({ ...u, downloaded: true }));
  };

  return { exportBackup, exportCsv, importBackup, confirmRestore, downloadUnreadable };
}
