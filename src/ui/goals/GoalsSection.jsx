import { useMemo, useState } from "react";
import { coverWords, goalResults, goalStanding, isPausedGoal } from "../../domain/workGoals.js";
import { currenciesByValue } from "../../domain/performance.js";
import { formatMoney } from "../../domain/money.js";
import { useCurrency } from "../CurrencyContext.jsx";
import { GoalMeter, goalFormatter } from "../parts.jsx";
import { rateDay } from "../fxMoney.js";
import GoalForm from "./GoalForm.jsx";
import { EVERY_WORD, PERIOD_WORD, resultWords } from "./words.js";

/** How many goals Today shows before "Show all": more than a few at once is a
 *  list, not a focus. */
const SHOWN = 3;

/** What a day's goal says under its bar. A week's and a month's say their
 *  pace, from the bar itself. */
const dayWords = (at, show) => {
  if (at.met) return at.over > 0 ? `Met · ${show(at.over)} over` : "Met";
  return at.off ? "Day off" : `${show(at.toGo)} to go`;
};

/** What the figure leaves out or estimates, or "". */
const caveat = (at) => [
  at.approx && `estimated at ${rateDay(at.date)} rates`,
  Object.keys(at.uncounted).length > 0
    && `not counting ${currenciesByValue(at.uncounted).map(([c, cents]) => formatMoney(cents, c)).join(" and ")}, which needs live rates`,
].filter(Boolean).join(" · ");

function Goal({ goal, projects, ctx, results, managing, first, last, actions, onEdit }) {
  const paused = isPausedGoal(goal);
  const at = goalStanding(goal, ctx);
  const show = goalFormatter(goal.type, goal.currency);
  const note = caveat(at);
  const said = resultWords(results, goal.period);
  return (
    <div className={"trg wgoal" + (paused ? " paused" : "")}>
      <div className="trg-top">
        <span className="trg-name">{coverWords(goal, projects)}</span>
        <span className="trg-of">{paused ? `${EVERY_WORD[goal.period].toLowerCase()}, paused` : PERIOD_WORD[goal.period]}</span>
        <span className="goal-val">
          {paused ? show(at.target) : `${at.approx ? "≈ " : ""}${show(at.value)} / ${show(at.target)}`}
        </span>
      </div>
      {!paused && (
        <>
          <GoalMeter type={goal.type} target={at.target} value={at.value} currency={goal.currency} pace={at.pacing} />
          {goal.period === "day" && (
            <div className={"goal-pace " + (at.met ? "met" : "even")}>{dayWords(at, show)}</div>
          )}
          {note && <div className="goal-pace">{note}</div>}
        </>
      )}
      {said && (
        <div className="goal-results">
          <span className="goal-dots" aria-hidden="true">
            {[...results].reverse().map((r) => <i key={r.from} className={r.met ? "met" : ""} />)}
          </span>
          {said}
        </div>
      )}
      {managing && (
        <div className="goal-actions">
          <button className="linkish" onClick={onEdit}>Edit</button>
          <button className="linkish" onClick={() => (paused ? actions.onResumeGoal : actions.onPauseGoal)(goal.id)}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button className="linkish" disabled={first} onClick={() => actions.onMoveGoal(goal.id, -1)}>Move up</button>
          <button className="linkish" disabled={last} onClick={() => actions.onMoveGoal(goal.id, 1)}>Move down</button>
          <button className="linkish danger" onClick={() => actions.onRemoveGoal(goal.id)}>Delete</button>
        </div>
      )}
    </div>
  );
}

/**
 * The goals for work, on Today: where each stands, how its last periods went,
 * and the form to set one. `ctx` is what `goalStanding` reads, worked out by
 * the screen, so a goal and the figures beside it count the same records.
 */
export default function GoalsSection({ goals, projects, ctx: given, actions }) {
  const { fxOn, rates } = useCurrency();
  const ctx = { ...given, fxOn, rates };
  const [form, setForm] = useState(null); // "new" | a goal's id
  const [managing, setManaging] = useState(false);
  const [showAll, setShowAll] = useState(false);

  /* A finished period only changes when its records do, and a day when the day
     does: not on every tick of a running meter, which would read months of
     sessions over again each second. */
  const minute = Math.floor(ctx.now / 60_000);
  const results = useMemo(
    () => new Map(goals.map((g) => [g.id, goalResults(g, ctx)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above: the minute, not the second
    [goals, given.source, fxOn, rates, minute],
  );

  // Paused ones after the rest, and only when they are asked for.
  const ordered = [...goals.filter((g) => !isPausedGoal(g)), ...goals.filter(isPausedGoal)];
  const going = ordered.filter((g) => !isPausedGoal(g));
  // Managed in their own order, so moving one is seen to move it.
  const shown = managing ? goals : showAll ? ordered : going.slice(0, SHOWN);
  const hidden = ordered.length - shown.length;
  const editing = goals.find((g) => g.id === form) ?? null;
  const close = () => setForm(null);

  return (
    <div className="sec">
      <div className="sec-head">
        <span className="eyebrow">Goals</span>
        {goals.length > 0 && (
          <button className="linkbtn" onClick={() => { setManaging((v) => !v); close(); }}>
            {managing ? "Done" : "Manage"}
          </button>
        )}
      </div>
      <div className="panel">
        {shown.map((g) => (editing?.id === g.id ? (
          <div className="trg" key={g.id}>
            <GoalForm key={g.id} goal={g} projects={projects} onCancel={close}
                      onSave={(fields) => { actions.onEditGoal(g.id, fields); close(); }} />
          </div>
        ) : (
          <Goal key={g.id} goal={g} projects={projects} ctx={ctx} results={results.get(g.id) ?? []}
                managing={managing} actions={actions} onEdit={() => setForm(g.id)}
                first={goals[0].id === g.id} last={goals.at(-1).id === g.id} />
        )))}
        {form === "new" ? (
          <div className={shown.length ? "trg" : ""}>
            <GoalForm projects={projects} onCancel={close}
                      onSave={(fields) => { actions.onAddGoal(fields); close(); setShowAll(true); }} />
          </div>
        ) : (
          <div className={"goal-foot" + (shown.length ? "" : " first")}>
            <button className="linkish obj-add first" onClick={() => setForm("new")}>+ Set goal</button>
            {!managing && (hidden > 0 || showAll) && ordered.length > Math.min(SHOWN, going.length) && (
              <button className="linkish obj-add first" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show fewer" : `Show all ${ordered.length}`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
