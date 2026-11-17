import { formatMoney } from "../../domain/money.js";
import { REWARD } from "../../domain/earnings.js";
import { SCOPE } from "../../domain/terms.js";
import { isOffClock } from "../../domain/projects.js";

/**
 * The money half of the panel: the hourly rate, the per-task time limit, what
 * acceptance pays and how far a change to the terms reaches. It is the part
 * that explains arithmetic at length, so it lives apart from the form's wiring.
 */
export default function RateTerms({
  project, rate, limit, over, reward, each, perHour, set, onKey, limitRefused, limitHours,
  overPct, rateChanged, limitChanged, scope, setScope, hasRunningSession,
}) {
  // A rate that is not a number above zero has never been applied, and with an
  // explicit Save that silence would read as the button not working.
  const rateRefused = !isOffClock(project) && rate.trim() !== "" && !(Number(rate) > 0);

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
          <label className="field">
            <span className="eyebrow">Hourly rate ({project.currency})</span>
            <input className="inp" type="number" min="0" step="any" value={rate}
                   onKeyDown={onKey} onChange={(e) => set({ rate: e.target.value })} />
          </label>
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
          {rateChanged || limitChanged ? (
            <>
              <div className="sec-head" style={{ marginTop: 18 }}>
                <span className="eyebrow">
                  Apply the new {rateChanged && limitChanged ? "rate and limit" : rateChanged ? "rate" : "limit"}
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
                    {rateChanged && " Work filed under no task keeps the rate it was recorded at."}
                  </>
                ) : (
                  <>
                    Every task on this project is worked out again under the new terms, the
                    ones already handed in and paid included, so past figures will move. A task
                    with a rate or a limit of its own keeps it.
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="hint">
              Changing the rate or the time limit asks whether it reaches work already handed
              in{hasRunningSession ? " or the sitting running now" : ""}.
            </div>
          )}
          {rateRefused && (
            <div className="hint warn">
              An hourly rate has to be a number above zero, so this one will be left as it is.
              To stop charging by the hour, set this project off the clock or price it per task.
            </div>
          )}
        </>
      )}
    </>
  );
}
