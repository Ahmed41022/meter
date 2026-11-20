import ThemeSwitch from "../ThemeSwitch.jsx";

/**
 * How the app looks on THIS device.
 *
 * It used to sit in the footer of every screen. System is the default and
 * stays it; the other two exist because "what my OS is set to" and "what I
 * want to look at right now" are not the same question — least of all at 2am.
 * The choice is per device (see settings.js), so it is not part of the ledger
 * and does not sync.
 */
export default function AppearanceSection({ theme, onTheme }) {
  return (
    <section className="settings-sec" aria-labelledby="settings-appearance">
      <h2 className="settings-title" id="settings-appearance">Appearance</h2>
      <ThemeSwitch theme={theme} onChange={onTheme} />
    </section>
  );
}
