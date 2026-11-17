import { Notice } from "../parts.jsx";
import { countWord, daysWord } from "../words.js";

/**
 * The nudge to take a backup when what exists only in this browser has gone
 * unsaved for too long.
 */
export default function BackupReminder({ backup, exportBackup }) {
  return (
    <Notice title={backup.never ? "Never backed up" : `Last backed up ${daysWord(backup.days)}`}>
      {countWord(backup.unsaved)} {backup.unsaved === 1 ? "exists" : "exist"} only in this
      browser. Clearing site data, or
      reinstalling, takes {backup.unsaved === 1 ? "it" : "them"} with it —
      {" "}<button className="linkish" onClick={exportBackup}>export a backup</button> to keep a copy
      you hold.
    </Notice>
  );
}
