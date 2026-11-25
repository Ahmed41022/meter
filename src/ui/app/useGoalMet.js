import { useEffect, useRef } from "react";
import { coverWords, goalStanding, isGoing } from "../../domain/workGoals.js";
import { goalFormatter } from "../parts.jsx";
import { dayLeft } from "../../domain/hoursLeft.js";
import { isRunning } from "../../domain/time.js";
import { PERIOD_WORD, leftWords } from "../goals/words.js";
import { notify } from "../notify.js";

/**
 * Saying once that a goal has been met, as it is met, and once that the time
 * left for one is getting short.
 *
 * Only a goal this page has seen NOT met, for the same period and target, can
 * become met: opening the app on a goal already reached says nothing, and nor
 * does lowering a target under what is already done. Once said it is not said
 * again for that period, whatever is corrected afterwards. The system's own
 * notification comes only from the device holding a meter, so one goal is not
 * announced by every device that is open.
 *
 * Time getting short is said the same way, of a day's goal and of a longer one
 * on its last working day: before that, what today cannot hold is asked of the
 * days after. It is mostly news where nothing is running, so with no meter
 * going anywhere, each device that is open says it.
 */
export function useGoalMet({ goals, projects, ctx, ready, meterHere, flash }) {
  const seen = useRef(new Map());
  const said = useRef(new Set());
  useEffect(() => {
    if (!ready) return;
    for (const goal of goals) {
      if (!isGoing(goal, projects)) continue;
      const at = goalStanding(goal, ctx);
      const key = `${goal.id}|${goal.type}|${goal.period}|${at.from}|${at.target}`;
      const was = seen.current.get(goal.id);
      // Today's part, and the day it is of: a new day starts calm.
      const todayKey = `${key}|${ctx.endsAt}|${dayLeft(ctx.now, ctx.endsAt).from}`;
      const asks = at.today !== null && (goal.period === "day" || at.pacing?.daysLeft === 1);
      const pressed = asks && (at.today.state === "tight" || at.today.state === "short");
      seen.current.set(goal.id, { key, met: at.met, todayKey, calm: asks && at.today.state === "fits" });
      if (pressed && was?.todayKey === todayKey && was.calm && !said.current.has(`${goal.id}|tight|${todayKey}`)) {
        said.current.add(`${goal.id}|tight|${todayKey}`);
        const message = `${coverWords(goal, projects)}: ${goalFormatter(goal.type, goal.currency)(at.today.toGo)} to go, ${leftWords(at.today.leftMs)} left today.`;
        flash(message);
        if (meterHere || !ctx.sessions.some(isRunning)) notify("Time is getting short", message, `goal-time-${goal.id}`);
      }
      if (!at.met || was?.key !== key || was.met || said.current.has(`${goal.id}|${at.from}`)) continue;
      said.current.add(`${goal.id}|${at.from}`);
      const show = goalFormatter(goal.type, goal.currency);
      const message = `${coverWords(goal, projects)}: ${show(at.target)} ${PERIOD_WORD[goal.period]}. Goal met.`;
      flash(message);
      if (meterHere) notify("Goal met", message, `goal-${goal.id}`);
    }
  });
}
