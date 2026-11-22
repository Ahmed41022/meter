import { useEffect, useRef, useState } from "react";

/**
 * A step's heading. When the step was reached by acting (not merely by opening
 * the Settings tab), focus moves to it, so a keyboard or screen-reader user
 * lands where the new content starts instead of on a button that is gone.
 * `tabIndex={-1}` makes it focusable by script without putting it in the tab order.
 */
export function StepHeading({ children, focus = false, id }) {
  const ref = useRef(null);
  useEffect(() => { if (focus) ref.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once, when the step appears
  return <h3 className="rl-h" ref={ref} tabIndex={-1} id={id}>{children}</h3>;
}

/** A failure, announced. Nothing when there is none. */
export function Problem({ children }) {
  return children ? <p className="rl-problem" role="alert">{children}</p> : null;
}

/** A re-render once in a while, so "seen 12 s ago" and a countdown stay true
 *  without anything else having to change. */
export function useTick(ms = 1_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Puts text on the clipboard. Resolves true when it did. The old textarea route
 * is the fallback for a page that may not use the async API (an http page, some
 * embedded browsers); where neither works the caller says to copy by hand.
 */
export async function copyText(text, win = globalThis) {
  try {
    if (win.navigator?.clipboard?.writeText) {
      await win.navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the older route */ }
  try {
    const d = win.document;
    const area = d.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    d.body.appendChild(area);
    area.select();
    const ok = d.execCommand?.("copy") === true;
    d.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** A Copy button that says what happened, for a secret the person must be able
 *  to move to another place. */
export function CopyButton({ text, label = "Copy", className = "btn ghost" }) {
  const [said, setSaid] = useState("");
  return (
    <>
      <button type="button" className={className}
              onClick={async () => setSaid((await copyText(text)) ? "Copied." : "Could not copy. Select it and copy by hand.")}>
        {label}
      </button>
      <span className="rl-copied" role="status">{said}</span>
    </>
  );
}
