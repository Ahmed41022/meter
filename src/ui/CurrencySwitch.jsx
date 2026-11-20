import { useEffect, useRef, useState } from "react";
import { hasCurrency } from "../domain/fx.js";
import { useCurrency } from "./CurrencyContext.jsx";
import { currencyLabel } from "./currencyNames.js";

/**
 * The ▾ beside a total: pick the one currency every total is shown in, or
 * "As earned". The choice is app-wide (a synced preference), so choosing here
 * switches every total at once; this button only offers it where the eye is.
 *
 * `display` is what the total beside it printed (see useDisplay), which is how
 * the menu knows why converting did not happen and can say so.
 *
 * A menu button pattern: the button has aria-haspopup and aria-expanded, the
 * items are menuitemradio in a roving focus, Escape and a click outside close
 * it, and Up, Down, Home and End move between the enabled items.
 */
export default function CurrencySwitch({ display, className = "" }) {
  const { choice, rates, favourites, onChoose, onOpenSettings } = useCurrency();
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const button = useRef(null);
  const menu = useRef(null);

  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!root.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("touchstart", away);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("touchstart", away);
    };
  }, [open]);

  const items = () => [...(menu.current?.querySelectorAll("[role=menuitemradio]:not(:disabled)") ?? [])];
  const focusItem = (at) => {
    const list = items();
    if (list.length) list[(at + list.length) % list.length].focus();
  };
  // On opening, focus lands on the current choice, or the first item that works.
  useEffect(() => {
    if (!open) return;
    const list = items();
    (list.find((el) => el.getAttribute("aria-checked") === "true") ?? list[0])?.focus();
  }, [open]);

  const conv = display.conv;
  const usable = conv.why !== "off" && conv.why !== "none";
  const note = conv.why === "off" ? "off"
    : conv.why === "none" ? "none"
      : conv.why === "missing" && choice !== "earned" ? "missing" : null;

  const pick = (value) => { onChoose(value); close(true); };

  const onKey = (e) => {
    const list = items();
    const at = list.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(at < 0 ? -1 : at - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(-1); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === "Tab") close();
  };

  return (
    <span className={`fx-switch-wrap ${className}`.trim()} ref={root}>
      <button type="button" className="fx-btn" ref={button}
              aria-haspopup="menu" aria-expanded={open}
              aria-label="Show totals in another currency"
              onClick={() => setOpen((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); }
                else if (e.key === "Escape" && open) { e.stopPropagation(); close(); }
              }}>
        ▾
      </button>
      {open && (
        <div className="fx-pop" onKeyDown={onKey}>
          <div role="menu" aria-label="Show totals in" ref={menu}>
            {favourites.map((code) => {
              const noRate = usable && !hasCurrency(rates, code);
              return (
                <button type="button" role="menuitemradio" key={code} className="fx-item"
                        aria-checked={choice === code} disabled={!usable || noRate}
                        onClick={() => pick(code)}>
                  <span>{currencyLabel(code)}</span>
                  <span className="fx-tick">{choice === code ? "✓" : noRate ? "no rate" : ""}</span>
                </button>
              );
            })}
            <button type="button" role="menuitemradio" className="fx-item"
                    aria-checked={choice === "earned"} onClick={() => pick("earned")}>
              <span>As earned</span>
              <span className="fx-tick">{choice === "earned" ? "✓" : ""}</span>
            </button>
          </div>
          {note && (
            <div className="fx-why" role="note">
              {note === "off" && <>
                Live rates are off — turn them on in{" "}
                <button type="button" className="linkish"
                        onClick={() => { close(); onOpenSettings(); }}>
                  Settings → Currency
                </button>
              </>}
              {note === "none" && "No rates yet."}
              {note === "missing" && `No rate for ${conv.codes.join(", ")}. Showing each currency as earned.`}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
