import { formatMoney } from "../../domain/money.js";
import { REWARD, paysOnAcceptance } from "../../domain/earnings.js";
import { SCOPE } from "../../domain/terms.js";
import { MODEL } from "../../domain/payModel.js";
import { isOffClock } from "../../domain/projects.js";

/**
 * The money half of the panel: the hourly rate, the per-task time limit, what
 * acceptance pays and how far a change to the terms reaches. It is the part
 * that explains arithmetic at length, so it lives apart from the form's wiring.
 */
export default function RateTerms({
  project, model, modelChanged, payMissing, saved, least, leastRefused, rate, limit, over, reward, each, perHour, set, onKey, limitRefused, limitHours,
  overPct, rateChanged, limitChanged, scope, setScope, hasRunningSession,
}) {
  // A rate that is not a number above zero has never been applied, and with an
  // explicit Save that silence would read as the button not working.
  const piece = model === MODEL.PER_TASK;
  const rateRefused = !isOffClock(project) && !piece && !modelChanged && rate.trim() !== "" && !(Number(rate) > 0);

  /**
   * The arithmetic spelled out. "+10/hr" is precisely the thing that reads as
   * "+10 per task" to anyone who has met the other reward system, and getting
   * that wrong is what this whole setting exists to fix — so the panel shows
   * 80 and 10 becoming 90 rather than leaving it to be inferred.
   */
  const asMoney = (n) => formatMoney(Math.round(n * 100), project.currency);
  const rateNum = Number(rate);
  const upliftNum = Number(perHour);
  const previewable = Number.isFinite(rateNum) && rateNum > 0
    && Number.isFinite(upliftNum) && upliftNum > 0;
  const ratePreview = previewable ? asMoney(rateNum) : null;
  const upliftPreview = previewable ? asMoney(upliftNum) : null;
  const totalPreview = previewable ? asMoney(rateNum + upliftNum) : null;

  return (
    <>
      {/* Off the clock replaces the rate rather than sitting beside it. A rate
          on something that never earns is the thing this setting exists to
          stop people faking with 0.00001. */}
      {isOffClock(project) ? (
        <div className="hint" style={{ marginTop: 0 }}>
          This isn&apos;t work, so it has no rate. Its hours are tracked and reported on their
          own, and never counted into earnings, billable share, or the project breakdown.
        </div>
      ) : (
        <>
          <div className="field">
            <span className="eyebrow">How it pays</span>
            <div className="modes" role="tablist" aria-label="How this project pays">
              {[[MODEL.HOURLY, "By the hour"], [MODEL.PER_TASK, "Per task"]].map(([key, label]) => (
                <button key={key} type="button" role="tab" aria-selected={model === key}
                        className={"seg-btn" + (model === key ? " on" : "")}
                        // Leaving per task, the price does not become a bonus on
                        // top of the hours unless that is chosen.
                        onClick={() => set({
                          model: key,
                          ...(saved.model === MODEL.PER_TASK
                            ? { reward: key === MODEL.PER_TASK ? saved.reward : "none" } : {}),
                        })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {piece ? (
            <label className="field">
              <span className="eyebrow">Per accepted task ({project.currency})</span>
              <input className="inp" type="number" min="0" step="any" value={each}
                     placeholder="what one accepted item pays"
                     onKeyDown={onKey} onChange={(e) => set({ each: e.target.value })} />
            </label>
          ) : (
            <label className="field">
              <span className="eyebrow">Hourly rate ({project.currency})</span>
              <input className="inp" type="number" min="0" step="any" value={rate}
                     onKeyDown={onKey} onChange={(e) => set({ rate: e.target.value })} />
            </label>
          )}
          {payMissing && (
            <div className="hint warn" role="alert">
              {piece
                ? "What does one task pay? A number above zero, before this can be saved."
                : "What does an hour pay? A rate above zero, before this can be saved."}
            </div>
          )}
          {piece && (
            <div className="hint">
              The clock still runs, so you can see what an hour of it came to — but the money comes
              from the tasks accepted, not from the time. A task can have a price of its own.
              {modelChanged && " It pays once accepted."}
            </div>
          )}
          {modelChanged && !piece && paysOnAcceptance(project) && (
            <div className="hint">
              Its money is still counted once accepted. Change that under When it pays, below.
            </div>
          )}
          {/* A platform that pays a task's time in full only up to a limit,
              and the time over it at a share of the rate, or not at all. */}
          <div className="pair">
            <label className="field">
              <span className="eyebrow">Time limit per task (hours)</span>
              <input className="inp" type="number" min="0" step="any" value={limit}
                     placeholder="none" onKeyDown={onKey}
                     onChange={(e) => set({ limit: e.target.value })} />
            </label>
            <label className="field">
              <span className="eyebrow">Time over it pays (% of rate)</span>
              <input className="inp" type="number" min="0" step="any" value={over}
                     placeholder="0 = unpaid" disabled={limit.trim() === ""} onKeyDown={onKey}
                     onChange={(e) => set({ over: e.target.value })} />
            </label>
          </div>
          {limit.trim() !== "" && !limitRefused && (
            <div className="hint">
              A task&apos;s first {+limitHours.toFixed(2)}h of billed time pay the full rate; time
              over it pays {overPct === 0 ? "nothing" : `${+overPct.toFixed(2)}% of it`}. Idle time
              does not count toward the limit. A task can carry a limit of its own.
            </div>
          )}
          {limitRefused && (
            <div className="hint warn">
              A limit has to be a number of hours above zero, and what time over it pays a
              percentage from 0 up, so this one will be left as it is.
            </div>
          )}
          {/* The opposite: how long a task has to take. Its clock counts down. */}
          <label className="field">
            <span className="eyebrow">Minimum time per task (hours)</span>
            <input className="inp" inputMode="decimal" value={least}
                   placeholder="none" onKeyDown={onKey}
                   onChange={(e) => set({ least: e.target.value })} />
          </label>
          {least.trim() !== "" && !leastRefused && Number(least.replace(",", ".")) > 0 && (
            <div className="hint">
              An open task&apos;s clock counts down from {+Number(least.replace(",", ".")).toFixed(2)}h
              of billed time, and says when it is met. Pay is not affected. A task can carry a
              minimum of its own.
            </div>
          )}
          {leastRefused && (
            <div className="hint warn">
              A minimum has to be a number of hours, so this one will be left as it is.
            </div>
          )}
          {!piece && <>
          <div className="sec-head" style={{ marginTop: 18 }}>
            <span className="eyebrow">Acceptance reward</span>
          </div>
          {/* The two reward systems are alternatives, not options to combine:
              a project holding both would have two answers to "what does
              acceptance pay". Picking one clears the other on save. */}
          <div className="modes" role="tablist" aria-label="What acceptance pays">
            {[
              ["none", "Nothing"],
              [REWARD.PER_TASK, "A flat amount"],
              [REWARD.PER_HOUR, "More per hour"],
            ].map(([key, label]) => (
              <button key={key} role="tab" aria-selected={reward === key}
                      className={"seg-btn" + (reward === key ? " on" : "")}
                      onClick={() => set({ reward: key })}>
                {label}
              </button>
            ))}
          </div>

          {reward === REWARD.PER_TASK && (
            <label className="field" style={{ marginTop: 14 }}>
              <span className="eyebrow">Per accepted task ({project.currency})</span>
              <input className="inp" type="number" min="0" step="any"
                     placeholder="what one accepted item pays"
                     value={each} onKeyDown={onKey}
                     onChange={(e) => set({ each: e.target.value })} />
            </label>
          )}
          {reward === REWARD.PER_HOUR && (
            <label className="field" style={{ marginTop: 14 }}>
              <span className="eyebrow">Extra per hour once accepted ({project.currency})</span>
              <input className="inp" type="number" min="0" step="any"
                     placeholder="on top of the hourly rate"
                     value={perHour} onKeyDown={onKey}
                     onChange={(e) => set({ perHour: e.target.value })} />
            </label>
          )}

          <div className="hint">
            {reward === REWARD.PER_HOUR ? (
              <>
                Paid <strong>for every hour worked on the task</strong>, not once per task.
                {upliftPreview && <> At {ratePreview} plus {upliftPreview} an hour, accepted
                  work comes to {totalPreview} an hour, and a task that took twice as long is
                  worth twice as much.</>}
                {" "}Submitting files it as pending; marking the task accepted pays it.
              </>
            ) : reward === REWARD.PER_TASK ? (
              <>
                One flat amount per accepted item, however long it took — a task can override it
                with its own price. Submitting files it as pending; marking the task accepted
                pays it.
              </>
            ) : (
              <>
                Acceptance pays nothing extra here; the hourly rate is the whole of it. You can
                still record a one-off reward across a batch of tasks from the task list.
              </>
            )}
          </div>
          </>}
          {rateChanged || limitChanged || modelChanged ? (
            <>
              <div className="sec-head" style={{ marginTop: 18 }}>
                <span className="eyebrow">
                  Apply the new {[
                    modelChanged && "way it pays", rateChanged && "rate", limitChanged && "limit",
                  ].filter(Boolean).join(" and ")}
                </span>
              </div>
              <div className="modes" role="tablist" aria-label="How far the change reaches">
                {[[SCOPE.FORWARD, "From now on"], [SCOPE.ALL, "Past included"]].map(([key, label]) => (
                  <button key={key} role="tab" aria-selected={scope === key}
                          className={"seg-btn" + (scope === key ? " on" : "")}
                          onClick={() => setScope(key)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="hint" style={{ marginTop: 10 }}>
                {scope === SCOPE.FORWARD ? (
                  <>
                    Tasks already handed in keep the terms they were handed in under. Tasks
                    still open take the new ones, and so does everything recorded from now on.
                    {(rateChanged || modelChanged) && " Work filed under no task keeps the rate it was recorded at."}
                    {modelChanged && " Hours already on an open task change with it."}
                  </>
                ) : (
                  <>
                    Every task on this project is worked out again under the new terms, the
                    ones already handed in and paid included, so past figures will move. A task
                    with a rate or a limit of its own keeps it.
                    {modelChanged && (piece
                      ? " Hours already recorded stop paying, under no task too, and every task handed in is paid the price instead."
                      : " Hours already recorded are paid the rate, and the per-task pay written when each task was handed in is worked out again.")}
                    {modelChanged && " Amounts you entered yourself stay as they are. You can undo it."}
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="hint">
              Changing {piece ? "how it pays" : "how it pays, the rate"} or the time limit asks whether it reaches work already handed
              in{hasRunningSession ? " or the sitting running now" : ""}.
            </div>
          )}
          {rateRefused && (
            <div className="hint warn">
              An hourly rate has to be a number above zero, so this one will be left as it is.
              To stop charging by the hour, choose Per task above, or set this project off the
              clock under Counts as.
            </div>
          )}
        </>
      )}
    </>
  );
}
