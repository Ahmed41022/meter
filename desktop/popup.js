/**
 * Which pop-ups belong inside the app, and which belong in a real browser.
 *
 * Everything the app links to — a help page, a Google Cloud console — should
 * leave and open in the browser, because a link is not part of the app.
 *
 * Signing in is the exception, and not a cosmetic one. Google's sign-in window
 * is opened by the page with `window.open` and hands the token back by talking
 * to the window that opened it. A browser launched by the operating system has
 * no such relationship: the token would arrive nowhere, and the app would wait
 * for an answer that could never come. So this one has to open as a genuine
 * child window.
 *
 * The test is on the host, and on an allow-list rather than a substring match.
 * "accounts.google.com.example.com" contains the name and is not Google.
 */
const SIGN_IN_HOSTS = new Set([
  "accounts.google.com",
  "content.googleapis.com",
]);

function isSignIn(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Only over https. A sign-in offered over anything else is not one.
  return parsed.protocol === "https:" && SIGN_IN_HOSTS.has(parsed.hostname);
}

module.exports = { isSignIn, SIGN_IN_HOSTS };
