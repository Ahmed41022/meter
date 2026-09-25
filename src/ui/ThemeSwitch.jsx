import { THEME } from "../storage/settings.js";

/**
 * Light, dark, or whatever the machine says.
 *
 * Icons rather than words, because this sits at the foot of every screen and
 * three labelled buttons is a lot of furniture for something touched twice a
 * year. Each one still carries its name for anyone who cannot see the glyph,
 * and as a tooltip for anyone who can but does not recognise it.
 */
const Sun = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"
       stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <circle cx="8" cy="8" r="3.1" />
    <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6
             M3.2 3.2l1.13 1.13M11.67 11.67l1.13 1.13
             M12.8 3.2l-1.13 1.13M4.33 11.67L3.2 12.8" />
  </svg>
);

const Moon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
       fill="currentColor">
    {/* One path, not a circle with a bite cut out of it: a cut-out would need a
        background colour to cut WITH, and this sits on two of them. */}
    <path d="M13.2 10.1A5.8 5.8 0 0 1 5.9 2.8a5.9 5.9 0 1 0 7.3 7.3z" />
  </svg>
);

const Auto = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"
       stroke="currentColor" strokeWidth="1.5">
    <circle cx="8" cy="8" r="5.4" fill="none" />
    {/* Half filled: the setting is "both, depending". */}
    <path d="M8 2.6a5.4 5.4 0 0 1 0 10.8z" fill="currentColor" stroke="none" />
  </svg>
);

const CHOICES = [
  [THEME.LIGHT, "Light", Sun],
  [THEME.DARK, "Dark", Moon],
  [THEME.SYSTEM, "Match system", Auto],
];

export default function ThemeSwitch({ theme, onChange }) {
  return (
    <div className="segmented theme" role="tablist" aria-label="Theme">
      {CHOICES.map(([key, label, Icon]) => (
        <button key={key} role="tab" aria-selected={theme === key} aria-label={label}
                title={label}
                className={"seg icon" + (theme === key ? " on" : "")}
                onClick={() => onChange(key)}>
          <Icon />
        </button>
      ))}
    </div>
  );
}
