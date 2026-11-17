import { paceGoal } from "../../domain/goals.js";
import { GoalBar } from "../parts.jsx";

/**
 * The session and overall goal bars. The overall figure is worked out by the
 * page, because the closing summary of a finished project reads it too.
 */
export default function Goals({
  project, sessionGoal, overallGoal, currency, current, whole, shownMs, overallValue, now,
}) {
  return (
    <div className="sec">
      <div className="sec-head"><span className="eyebrow">Goals</span></div>
      <div className="panel">
        {sessionGoal && (
          <GoalBar label="This session" type={sessionGoal.type} target={sessionGoal.target}
                   currency={currency}
                   value={sessionGoal.type === "money"
                     ? (current ? whole(current) : 0) / 100
                     : shownMs / 60000} />
        )}
        {overallGoal && (
          <GoalBar
            label={overallGoal.period === "lifetime" ? "All time"
                 : overallGoal.period === "week" ? "This week" : "This month"}
            type={overallGoal.type} target={overallGoal.target} currency={project.currency}
            value={overallValue} pace={paceGoal(overallGoal, overallValue, now)} />
        )}
      </div>
    </div>
  );
}
