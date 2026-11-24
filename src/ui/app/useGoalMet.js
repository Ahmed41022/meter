import { useEffect, useRef } from "react";
import { coverWords, goalStanding, isPausedGoal } from "../../domain/workGoals.js";
import { goalFormatter } from "../parts.jsx";
import { PERIOD_WORD } from "../goals/words.js";
import { notify } from "../notify.js";

/**
 * Saying once that a goal has been met, as it is met.
 *
 * Only a goal this page has seen NOT met, for the same period and target, can
 * become met: opening the app on a goal already reached says nothing, and nor
 * does lowering a target under what is already done. Once said it is not said
 * again for that period, whatever is corrected afterwards. The system's own
 * notification comes only from the device holding a meter, so one goal is not
 * announced by every device that is open.
 */
export function useGoalMet({ goals, projects, ctx, ready, meterHere, flash }) {
  const seen = useRef(new Map());
  const said = useRef(new Set());
  useEffect(() => {
    if (!ready) return;
    for (const goal of goals) {
      if (isPausedGoal(goal)) continue;
      const at = goalStanding(goal, ctx);
      const key = `${goal.id}|${goal.type}|${goal.period}|${at.from}|${at.target}`;
      const was = seen.current.get(goal.id);
      seen.current.set(goal.id, { key, met: at.met });
      if (!at.met || was?.key !== key || was.met || said.current.has(`${goal.id}|${at.from}`)) continue;
      said.current.add(`${goal.id}|${at.from}`);
      const show = goalFormatter(goal.type, goal.currency);
      const message = `${coverWords(goal, projects)}: ${show(at.target)} ${PERIOD_WORD[goal.period]}. Goal met.`;
      flash(message);
      if (meterHere) notify("Goal met", message, `goal-${goal.id}`);
    }
  });
}
