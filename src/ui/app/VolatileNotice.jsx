import { Notice } from "../parts.jsx";

/**
 * Says so when the browser will not keep anything. Separate from the saved-or-not
 * notices because it is known at startup and never goes away until the page
 * is served differently.
 */
export default function VolatileNotice() {
  return (
    <Notice title="Nothing is being saved">
      This browser is blocking storage, so your sessions disappear when you reload. Serve the
      file over http instead of opening it directly, or allow site data for this page.
    </Notice>
  );
}
