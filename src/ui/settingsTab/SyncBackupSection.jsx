import { useRef } from "react";
import { countWord, daysWord } from "../words.js";

/**
 * Where else this ledger exists: a file you hold (Export backup, Restore), a
 * spreadsheet-readable copy (Export CSV), and Drive (the Sync panel, handed in
 * as `children` so its wiring stays in App next to the sync machinery).
 *
 * The three answer one question together, which is why they share a section.
 * They live here rather than on Work because the Life tab is a view of the
 * same ledger and a backup is of all of it, not of one list.
 */
export default function SyncBackupSection({
  backup, onExport, onImport, onExportCsv, restore, onConfirmRestore, onCancelRestore, children,
}) {
  const fileRef = useRef(null);
  return (
    <section className="settings-sec" aria-labelledby="settings-sync">
      <h2 className="settings-title" id="settings-sync">Sync &amp; backup</h2>
      {/* Where the Restore button was, because that is where the reader is
          looking once the file is picked. Restoring replaces; it does not
          merge. So the two ledgers are set side by side, in terms a person
          can recognise them by, before either is touched. */}
      {restore ? (
        <div className="panel restore" role="alertdialog" aria-labelledby="restore-title">
          <span className="eyebrow" id="restore-title">Replace your ledger?</span>
          <p>
            Restoring “{restore.name}” replaces everything here with what the file holds.
            Nothing is merged: anything here that the file doesn&apos;t have is gone, unless you
            press Undo straight after.
          </p>
          <dl className="restore-sides">
            <dt>Here now</dt>
            <dd>{restore.current}</dd>
            <dt>In the file</dt>
            <dd>{restore.incoming}</dd>
          </dl>
          <div className="controls">
            <button className="btn danger" onClick={onConfirmRestore}>Replace my ledger</button>
            <button className="btn ghost" onClick={onCancelRestore}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="controls">
          {/* Prominent only once a backup is overdue, so the one thing worth
              doing stands out the rest of the time it is just a button. */}
          <button className={"btn " + (backup?.stale ? "primary" : "ghost")} onClick={onExport}>
            Export backup
          </button>
          <button className="btn ghost" onClick={() => fileRef.current?.click()}>Restore</button>
          <button className="btn ghost" onClick={onExportCsv}>Export CSV</button>
          <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }}
                 onChange={(e) => {
                   const f = e.target.files?.[0];
                   if (f) onImport(f);
                   e.target.value = "";
                 }} />
        </div>
      )}
      {/* Stated whether or not it is overdue: a reader should be able to see
          that the last copy is recent, not have to trust the silence. */}
      {backup && (
        <p className="backup-note">
          {backup.never
            ? "No backup has ever been exported."
            : `Last backup ${daysWord(backup.days)}.`}
          {backup.unsaved > 0 && ` ${countWord(backup.unsaved)} since.`}
        </p>
      )}
      {children}
    </section>
  );
}
