/**
 * A system notification, where this device allows one.
 *
 * Asked for once, when something that wants one is set up, because a browser
 * only asks while the person is clicking. Shown through the service worker
 * where there is one — a phone will not show a notification any other way —
 * and directly otherwise, as the desktop app does. Anything that fails is
 * quiet: the app says the same thing on screen either way.
 */

const supported = () => typeof Notification !== "undefined";

export const askToNotify = () => {
  try {
    if (supported() && Notification.permission === "default") Notification.requestPermission();
  } catch {
    // An old browser takes a callback and throws on a promise; nothing to do.
  }
};

export const notify = async (title, body, tag) => {
  try {
    if (!supported() || Notification.permission !== "granted") return false;
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (registration?.showNotification) {
      await registration.showNotification(title, { body, tag });
    } else {
      new Notification(title, { body, tag });
    }
    return true;
  } catch {
    return false;
  }
};
