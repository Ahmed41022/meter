import { useMemo } from "react";
import { qrSvg } from "../../../sync/qr.js";

/**
 * A QR code, drawn as inline SVG by src/sync/qr.js. Always black on white with its
 * own quiet zone, in both themes: a code on a dark page, or inverted, fails to
 * scan on many phones. The width is set in CSS (.rl-qr), never below 220 px.
 * Nothing is drawn if the text cannot be encoded; the typed code beside it is
 * the way in either way.
 */
export default function QrCode({ text, label = "QR code" }) {
  const svg = useMemo(() => {
    try { return qrSvg(text, { label }); } catch { return null; }
  }, [text, label]);
  if (!svg) return null;
  return <div className="rl-qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}
