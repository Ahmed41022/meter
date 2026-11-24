import { useEffect, useRef } from "react";
import { formatShortDuration } from "../../domain/money.js";
import { isRunning } from "../../domain/time.js";
import { liveSessions, ownedBy } from "../../domain/sessions.js";
import { liveProjects } from "../../domain/projects.js";
import { taskLabel } from "../../domain/tasks.js";
import { hoursText, minimumOf } from "../../domain/minimum.js";
import { notify } from "../notify.js";

/**
 * Saying so when a running meter's task crosses its time limit, or meets its
 * minimum. The strip counts down to either; this is the one-off notice as it
 * passes.
 */
export function useOverLimit({ state, now, price, device, flash }) {
  /**
   * Where each running meter's task crosses its time limit or meets its
   * minimum, if it has one. Known before it happens — the sitting is going, so
   * the moment is already fixed — which is what the strip counts down to.
   */
  const projects = liveProjects(state.projects);
  const moments = liveSessions(state.sessions)
    .filter((s) => isRunning(s) && ownedBy(s, device))
    .flatMap((session) => {
      const owner = projects.find((p) => p.id === session.projectId);
      const task = owner ? taskLabel(owner, session.taskId) : "This task";
      const terms = price.terms(session);
      const least = owner ? minimumOf(owner, session, state.sessions, now) : null;
      return [
        (terms?.at ?? null) !== null && {
          at: terms.at, tag: `limit-${session.taskId}`, title: "Over the time limit",
          message: `${task} is past its ${formatShortDuration(terms.ms)} limit. Time from now pays ${Math.round(terms.factor * 100)}%.`,
        },
        (least?.at ?? null) !== null && {
          at: least.at, tag: `minimum-${session.taskId}`, title: "Minimum time met",
          message: `${task} has met its ${hoursText(least.ms)}h minimum.`,
        },
      ].filter(Boolean);
    });
  const key = moments.map((m) => `${m.tag}:${m.at}`).join("|");
  // Said once, as the line is crossed, and only by the device running the
  // meter. A window opened after it was crossed says so in the strip instead.
  const lastTick = useRef(Date.now());
  useEffect(() => {
    const before = lastTick.current;
    lastTick.current = now;
    for (const { at, tag, title, message } of moments) {
      if (!(before < at && now >= at)) continue;
      notify(title, message, tag);
      flash(message);
    }
  }, [now, key]); // eslint-disable-line react-hooks/exhaustive-deps -- fires on the tick that crosses the line
}
