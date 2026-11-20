import AppearanceSection from "./settingsTab/AppearanceSection.jsx";
import SyncBackupSection from "./settingsTab/SyncBackupSection.jsx";

/**
 * The things you set once and rarely touch, gathered in one place instead of
 * scattered across the footer and the bottom of the Work tab. Each section is
 * its own small component in settingsTab/; this only lays them out.
 *
 * Not to be confused with settings/, which is a single PROJECT's settings.
 */
export default function SettingsTab({ theme, onTheme, backupProps, sync }) {
  return (
    <>
      <AppearanceSection theme={theme} onTheme={onTheme} />
      <SyncBackupSection {...backupProps}>{sync}</SyncBackupSection>
    </>
  );
}
