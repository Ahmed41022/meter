import { isOffClock } from "../../domain/projects.js";

/**
 * The three boxes a goal is set with. A plain function rather than a component
 * because the panel calls it twice with its own state and wants the markup
 * back in place, not a new element between the form and its fields.
 */
export const goalFields = (project, set, key, goal, withPeriod) => (
    <div className="pair">
      {/* Off the clock there is nothing to earn, so time is the only measure
          on offer rather than a money option that could never move. */}
      {isOffClock(project) ? (
        <label className="field">
          <span className="eyebrow">Measure</span>
          <input className="inp" value="Minutes tracked" disabled readOnly />
        </label>
      ) : (
        <label className="field">
          <span className="eyebrow">Measure</span>
          <select className="inp" value={goal.type}
                  onChange={(e) => set({ [key]: { ...goal, type: e.target.value } })}>
            <option value="money">Money earned</option>
            <option value="time">Minutes worked</option>
          </select>
        </label>
      )}
      {withPeriod && (
        <label className="field">
          <span className="eyebrow">Resets</span>
          <select className="inp" value={goal.period}
                  onChange={(e) => set({ [key]: { ...goal, period: e.target.value } })}>
            <option value="week">Every Monday</option>
            <option value="month">Every 1st</option>
            <option value="lifetime">Never</option>
          </select>
        </label>
      )}
      <label className="field">
        <span className="eyebrow">Target</span>
        <input className="inp" type="number" min="0" step="any" placeholder="empty = no goal"
               value={goal.target}
               onChange={(e) => set({ [key]: { ...goal, target: e.target.value } })} />
      </label>
    </div>
);
