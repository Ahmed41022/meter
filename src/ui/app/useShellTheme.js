import { useEffect } from "react";
import { THEME } from "../../storage/settings.js";

/**
 * The parts of the window the app does not draw, in the theme it is showing.
 *
 * The app's colours live on its own element, so a theme picked in Settings
 * (dark on a light system, say) reached the app and stopped there: the page
 * behind it, and with it the browser's scrollbar, stayed in the system's. The
 * root's `color-scheme` is what the scrollbar and the form controls follow, so
 * it is set here, with the background, whenever the theme or the system's
 * changes. The colours are read off the app's own tokens, so the palette in
 * styles.js stays the only place a colour is written.
 *
 * In the desktop app the title bar is drawn by the window, and the shell asks
 * for its colours through `window.meterShell` (desktop/preload.js). A browser
 * has no such thing, and this is then only the first half.
 */
export function useShellTheme(theme, ready = true) {
  useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    // Not while the ledger loads: that screen does not carry the chosen theme,
    // and its colours would be the system's.
    if (!ready) return undefined;
    const apply = () => {
      const dark = theme === THEME.DARK || (theme !== THEME.LIGHT && Boolean(media?.matches));
      const root = document.documentElement;
      root.style.colorScheme = dark ? "dark" : "light";
      const app = document.querySelector(".mtr[data-theme], .mtr");
      if (!app) return;
      const style = getComputedStyle(app);
      const paper = style.getPropertyValue("--paper").trim();
      const ink = style.getPropertyValue("--ink").trim();
      if (!paper) return;
      root.style.background = paper;
      document.body.style.background = paper;
      try {
        globalThis.meterShell?.setTitleBar?.({ color: paper, symbol: ink });
      } catch { /* the shell's business, never the page's */ }
    };
    apply();
    media?.addEventListener?.("change", apply);
    return () => media?.removeEventListener?.("change", apply);
  }, [theme, ready]);
}
