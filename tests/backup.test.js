import { describe, it, expect } from "vitest";
import {
  STALE_DAYS, backupState, lastBackupAt, recordBackup, unsavedSince,
} from "../src/domain/backup.js";

const DAY = 86_400_000;
const T = new Date(2026, 8, 24, 12).getTime();
const session = (id, createdAt, extra = {}) =>
  ({ id, projectId: "p1", createdAt, segments: [], deletedAt: null, ...extra });
const store = (sessions = [], extra = {}) => ({ projects: [], sessions, ...extra });

describe("knowing when the ledger was last written to a file", () => {
  it("reads a store written before backups were tracked as never backed up", () => {
    expect(lastBackupAt({ projects: [], sessions: [] })).toBeNull();
    expect(backupState(store([session("s1", T - DAY)]), T).never).toBe(true);
  });

  it("stamps the moment a file was handed over", () => {
    expect(lastBackupAt(recordBackup(store(), T))).toBe(T);
  });

  it("counts the days since, floored, so 'today' never reads as one day ago", () => {
    const s = store([session("s1", T)], { lastBackupAt: T - DAY * 3 - 1000 });
    expect(backupState(s, T).days).toBe(3);
    expect(backupState(store([session("s1", T)], { lastBackupAt: T - 1000 }), T).days).toBe(0);
  });

  it("never treats a clock that ran backwards as a negative age", () => {
    // A restored file, or a machine whose clock was corrected, can carry a
    // stamp in the future. Reading "-4 days ago" is worse than reading "0".
    expect(backupState(store([session("s1", T)], { lastBackupAt: T + DAY * 4 }), T).days).toBe(0);
  });
});

describe("whether to ask for a backup at all", () => {
  it("says nothing at all when there is nothing to lose", () => {
    // Nagging someone to back up an empty ledger teaches them to ignore the
    // banner that will one day matter.
    expect(backupState(store(), T).stale).toBe(false);
    expect(backupState({ projects: [], sessions: [] }, T).stale).toBe(false);
  });

  it("asks once work exists and no file has ever been made", () => {
    expect(backupState(store([session("s1", T - DAY)]), T).stale).toBe(true);
  });

  it("stays quiet while the existing file is still complete", () => {
    // Backed up a year ago and nothing recorded since: the file on disk holds
    // everything. Age alone is not a reason to ask again.
    const s = store([session("s1", T - DAY * 400)], { lastBackupAt: T - DAY * 360 });
    expect(backupState(s, T).unsaved).toBe(0);
    expect(backupState(s, T).stale).toBe(false);
  });

  it("asks again only once new work has piled up AND time has passed", () => {
    const old = T - DAY * (STALE_DAYS + 1);
    // new work, but backed up yesterday — too soon to ask
    expect(backupState(store([session("s1", T)], { lastBackupAt: T - DAY }), T).stale).toBe(false);
    // new work, and the backup is older than the threshold
    expect(backupState(store([session("s1", T)], { lastBackupAt: old }), T).stale).toBe(true);
  });

  it("counts what would actually be lost, ignoring what the file already holds", () => {
    const at = T - DAY * 10;
    const s = {
      projects: [],
      sessions: [session("old", at - DAY), session("new1", at + DAY), session("new2", T)],
      earnings: [
        { id: "e1", createdAt: at - DAY, deletedAt: null },
        { id: "e2", createdAt: at + DAY, deletedAt: null },
      ],
      lastBackupAt: at,
    };
    expect(unsavedSince(s, at)).toBe(3); // two sessions and one earning
    expect(backupState(s, T).unsaved).toBe(3);
  });

  it("does not count work the user has already deleted", () => {
    const s = store([
      session("s1", T, { deletedAt: T }),
      session("s2", T),
    ], { lastBackupAt: T - DAY * 30 });
    expect(backupState(s, T).unsaved).toBe(1);
  });

  it("treats everything as unsaved when there has never been a backup", () => {
    const s = store([session("s1", T - DAY * 500), session("s2", T)]);
    expect(unsavedSince(s, null)).toBe(2);
  });
});
