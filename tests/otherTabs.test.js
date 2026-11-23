import { afterEach, describe, expect, it } from "vitest";
import { answerWhileHolding, askOtherTabs, resetOtherTabs } from "../src/ui/app/otherTabs.js";

/**
 * Two "tabs" in one process: the module keeps one channel per page, so the
 * other tab is a plain BroadcastChannel of the same name answering by hand.
 */
const otherTab = (answers) => {
  const ch = new BroadcastChannel("meter-tabs");
  ch.onmessage = (e) => {
    if (answers && e.data?.t === "who") ch.postMessage({ t: "here", id: e.data.id });
  };
  return ch;
};

describe("asking the other tabs whether one holds the meter", () => {
  let other = null;
  afterEach(() => { other?.close(); other = null; resetOtherTabs(); });

  it("hears nobody when this is the only tab, as after a reload", async () => {
    answerWhileHolding(() => true); // this tab holds it, and must not answer itself
    expect(await askOtherTabs(globalThis, 150)).toBe(false);
  });

  it("hears another tab that holds it", async () => {
    other = otherTab(true);
    expect(await askOtherTabs(globalThis, 400)).toBe(true);
  });

  it("does not count a tab that is open but holds nothing", async () => {
    other = otherTab(false);
    expect(await askOtherTabs(globalThis, 150)).toBe(false);
  });

  it("answers for this tab only while it holds a meter", async () => {
    let holding = false;
    answerWhileHolding(() => holding);
    const asker = new BroadcastChannel("meter-tabs");
    const heard = [];
    asker.onmessage = (e) => heard.push(e.data);
    asker.postMessage({ t: "who", id: "q1" });
    await new Promise((r) => setTimeout(r, 60));
    holding = true;
    asker.postMessage({ t: "who", id: "q2" });
    await new Promise((r) => setTimeout(r, 60));
    asker.close();
    expect(heard).toEqual([{ t: "here", id: "q2" }]);
  });

  it("says it cannot ask where there is no BroadcastChannel", async () => {
    expect(await askOtherTabs({}, 50)).toBeNull();
  });
});
