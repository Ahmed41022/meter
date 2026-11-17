import { useEffect, useRef } from "react";
import { formatShortDuration } from "../../domain/money.js";
import { isRunning } from "../../domain/time.js";
import { liveSessions, ownedBy } from "../../domain/sessions.js";
import { liveProjects } from "../../domain/projects.js";
import { taskLabel } from "../../domain/tasks.js";
import { notify } from "../notify.js";

/**
 * Saying so when the running meter's task crosses its time limit. The strip
 * counts down to the moment; this is the one-off notice as it passes.
 */
export function useOverLimit({ state, now, price, device, flash }) {
  const runningHere = liveSessions(state.sessions).find((s) => isRunning(s) && ownedBy(s, device));
  /**
   * Where the running meter's task crosses its time limit, if it has one.
   * Known before it happens — the sitting is going, so the moment the limit
   * is reached is already fixed — which is what the strip counts down to.
   */
  const limitAt = runningHere ? price.terms(runningHere)?.at ?? null : null;
  // Said once, as the line is crossed, and only by the device running the
  // meter. A window opened after it was crossed says so in the strip instead.
  const lastTick = useRef(Date.now());
  useEffect(() => {
    const before = lastTick.current;
    lastTick.current = now;
    if (limitAt === null || !(before < limitAt && now >= limitAt)) return;
    const owner = liveProjects(state.projects).find((p) => p.id === runningHere.projectId);
    const terms = price.terms(runningHere);
    const task = owner ? taskLabel(owner, runningHere.taskId) : "This task";
    const message = `${task} is past its ${formatShortDuration(terms.ms)} limit. Time from now pays ${Math.round(terms.factor * 100)}%.`;
    notify("Over the time limit", message, `limit-${runningHere.taskId}`);
    flash(message);
  }, [now, limitAt]); // eslint-disable-line react-hooks/exhaustive-deps -- fires on the tick that crosses the line
}
