import { useEffect, useId, useState } from "react";

/**
 * A small round "?" that shows a short explanation in place, and hides it
 * again on a second tap or Escape.
 *
 * Inline and not a hover tip, because a phone has no hover, and a tap is the
 * only thing every device can do. A hook rather than one component because the
 * button belongs in a heading's row and the panel under that row, and a
 * panel inside the row would sit beside the heading instead of below it. The
 * explanation is kept out of the page until asked for: it is long, and read
 * once.
 *
 *   const help = useHelp("How this works");
 *   <h2>Title {help.button}</h2>
 *   {help.panel(<ul>…</ul>)}
 */
export function useHelp(label) {
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return {
    button: (
      <button type="button" className="help-btn" aria-label={label} aria-expanded={open}
              aria-controls={open ? id : undefined} onClick={() => setOpen((v) => !v)}>
        ?
      </button>
    ),
    panel: (children) => (open ? <div className="help-panel" id={id} role="note">{children}</div> : null),
  };
}
