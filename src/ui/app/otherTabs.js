/**
 * Is another tab of this browser holding the meter right now?
 *
 * The already-running warning used to go by the heartbeat alone: a meter this
 * device opened, ticked seconds ago, meant another tab. So did reloading the
 * tab that was running it, which said "close one" with only one open. Tabs of
 * one browser can simply ask each other, so they do: a tab that opens on a
 * running meter asks, and a tab that holds one answers. No answer means the
 * last tick was this tab's own, from before the reload.
 *
 * One channel per page, used both ways. A BroadcastChannel never hears what it
 * posts itself, so a tab cannot answer its own question.
 *
 * Where there is no BroadcastChannel the question cannot be asked, and the
 * answer is null: the caller keeps the old rule.
 */
const NAME = "meter-tabs";
/** Long enough for a busy tab in the background to answer, short enough that
 *  the warning still comes with the page. */
export const ASK_MS = 400;

let channel = null;
let holding = () => false;

const open = (win) => {
  if (channel) return channel;
  const BC = win?.BroadcastChannel;
  if (typeof BC !== "function") return null;
  try {
    channel = new BC(NAME);
  } catch {
    return null;
  }
  channel.addEventListener("message", (e) => {
    const m = e?.data;
    if (m && m.t === "who" && holding()) {
      try { channel.postMessage({ t: "here", id: m.id }); } catch { /* closing */ }
    }
  });
  return channel;
};

/** This tab answers "here" whenever `fn()` says it holds a meter. */
export const answerWhileHolding = (fn, win = globalThis) => {
  holding = typeof fn === "function" ? fn : () => false;
  open(win);
};

/** Resolves true when another tab answers, false when none does, and null
 *  when tabs cannot be asked here. */
export const askOtherTabs = (win = globalThis, wait = ASK_MS) => {
  const ch = open(win);
  if (!ch) return Promise.resolve(null);
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const onAnswer = (e) => {
      if (e?.data?.t === "here" && e.data.id === id) finish(true);
    };
    const timer = setTimeout(() => finish(false), wait);
    function finish(found) {
      clearTimeout(timer);
      ch.removeEventListener("message", onAnswer);
      resolve(found);
    }
    ch.addEventListener("message", onAnswer);
    try { ch.postMessage({ t: "who", id }); } catch { finish(null); }
  });
};

/** For tests: forget the channel, so the next call opens a fresh one. */
export const resetOtherTabs = () => {
  try { channel?.close(); } catch { /* already closed */ }
  channel = null;
  holding = () => false;
};
