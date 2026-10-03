import { useState } from "react";
import { formatMoney, formatShortDuration } from "../domain/money.js";
import { findTask } from "../domain/tasks.js";
import { TASK, isOpenTask, taskState } from "../domain/taskState.js";
import { REWARD, acceptanceCents, bonusPerHour, rewardModel } from "../domain/earnings.js";

/**
 * Moving a batch of tasks through their life.
 *
 * Acceptance does not arrive one task at a time. A platform reviews a week of
 * submissions and answers them together, and a payout covers everything
 * approved that month — so recording it a row at a time is not merely slow,
 * it is the wrong shape, and past thirty or forty tasks it is the reason the
 * ledger stops being kept at all.
 *
 * Which buttons appear is decided by what is selected, not by a mode:
 *
 *  - SUBMIT is offered for tasks still open. It freezes their hours forever,
 *    settles the hourly money, and writes the acceptance reward as pending.
 *  - ACCEPTED and REJECTED are offered for every task already handed in,
 *    answered or not. They are the only two answers that can come back, and
 *    an answer can be changed its mind about: rejecting is what cancels a
 *    task's pay, so the opposite button has to stay within reach afterwards
 *    or one wrong click costs a week's money with no way back to it.
 *  - REOPEN undoes a state on tasks that have one, for the ordinary case of
 *    having ticked the wrong row. It gives back hours a rejection cancelled
 *    and leaves settled money alone.
 *
 * ONE REWARD sits apart from all of that. It is "finish fifty and we pay you
 * X" — a single payment naming every task in the selection, where splitting it
 * fifty ways would invent a price nobody quoted.
 */
const pad = (n) => String(n).padStart(2, "0");
const toInput = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** Midday, so a timezone cannot nudge the chosen day across a boundary and
 *  land the money in the wrong pay period — the one thing this date decides. */
const fromInput = (text, fallback) => {
  const at = new Date(`${text}T12:00`).getTime();
  return Number.isFinite(at) ? at : fallback;
};

export default function TaskSettle({
  project, taskIds, rows, sharedOwedIds, allIds, now = Date.now(), lastWorkedAt = null,
  onSubmit, onAnswer, onReopen, onReward, onPay, onSelectAll, onClear,
}) {
  const [rewarding, setRewarding] = useState(false);
  const [form, setForm] = useState({ amount: "", note: "" });
  /**
   * The day the work actually went in, which is not the day you tick the box.
   *
   * It defaults to when the last sitting on these tasks ended rather than to
   * now, because you almost always hand work in as you finish it — and the
   * difference is a whole payday whenever a cutoff falls between the two.
   * Editable, because only you know when it really went.
   */
  const [when, setWhen] = useState(() => toInput(lastWorkedAt ?? now));

  const currency = project.currency;
  const model = rewardModel(project);
  const msOf = (id) => rows.find((r) => r.taskId === id)?.billedMs ?? 0;
  const happenedAt = () => fromInput(when, now);

  const open = taskIds.filter((id) => isOpenTask(findTask(project, id)));
  // Anything handed in can be answered, including something answered before.
  // Re-answering is idempotent, so offering it costs nothing and withholding
  // it would strand a mistaken rejection.
  const stated = taskIds.filter((id) => taskState(findTask(project, id)) !== null);

  // What submitting the open ones would record. A null amount contributes
  // nothing rather than counting as zero — an unpriced task records no line.
  const owed = open.reduce(
    (sum, id) => sum + (acceptanceCents(project, findTask(project, id), msOf(id)) ?? 0), 0,
  );
  const openMs = open.reduce((sum, id) => sum + msOf(id), 0);

  const cents = Math.round(Number(form.amount) * 100);
  const validReward = Number.isFinite(cents) && cents !== 0;

  const record = () => {
    if (!validReward) return;
    onReward({ cents, note: form.note });
    setForm({ amount: "", note: "" });
    setRewarding(false);
  };

  const these = open.length === 1 ? "this task" : `these ${open.length}`;
  const them = open.length === 1 ? "it" : "them";

  return (
    <>
      <div className="selbar">
        <span className="selbar-count">
          {taskIds.length} selected
          {owed > 0 && ` · ${formatMoney(owed, currency)} to claim`}
        </span>
        {open.length > 0 && (
          <button className="btn primary" onClick={() => onSubmit(open, happenedAt())}>
            Submit {open.length}
          </button>
        )}
        {stated.length > 0 && (
          <>
            <button className="btn primary" onClick={() => onAnswer(stated, TASK.ACCEPTED, happenedAt())}>
              Accepted {stated.length}
            </button>
            <button className="btn ghost" onClick={() => onAnswer(stated, TASK.CANCELLED, happenedAt())}>
              Rejected {stated.length}
            </button>
          </>
        )}
        {(open.length > 0 || stated.length > 0) && (
          <label className="selbar-when">
            <span className="eyebrow">On</span>
            <input className="inp" type="date" value={when}
                   aria-label="The day this happened"
                   onChange={(e) => setWhen(e.target.value)} />
          </label>
        )}
        <button className="btn ghost" onClick={() => setRewarding((v) => !v)}>
          {rewarding ? "Cancel reward" : "One reward"}
        </button>
        {/* Only what an answer will not reach. A reward shared across fifty
            tasks is never settled by accepting one of them, so it still needs
            a way to be marked paid. */}
        {sharedOwedIds.length > 0 && (
          <button className="btn ghost" onClick={onPay}>
            Mark {sharedOwedIds.length} paid
          </button>
        )}
        {stated.length > 0 && (
          <button className="btn ghost" onClick={() => onReopen(stated)}>
            Reopen {stated.length}
          </button>
        )}
        {taskIds.length < allIds.length && (
          <button className="btn ghost" onClick={onSelectAll}>All {allIds.length}</button>
        )}
        <button className="btn ghost" onClick={onClear}>Clear</button>
      </div>

      {open.length > 0 && (
        <p className="hint" style={{ marginTop: -4, marginBottom: 12 }}>
          Submitting stops the clock on {these} for good — no more hours can be
          recorded against {them} — and settles the hourly money, which is what
          handing the work in earns. The date beside the buttons is the day the
          work went in, not the day you tick the box: it decides which pay period
          the money falls in, so a Saturday ticked off on Monday would otherwise
          slip a whole payday.
          {model === REWARD.PER_HOUR ? (
            <>
              {" "}The bonus of {formatMoney(Math.round(bonusPerHour(project) * 100), currency)}/hr
              on {formatShortDuration(openMs)} is filed as pending until you hear back.
            </>
          ) : model === REWARD.PER_TASK ? (
            <>
              {" "}The per-item price is filed as pending until you hear back.
              {owed === 0 && " Nothing is priced here yet, so no reward will be recorded."}
            </>
          ) : (
            <>
              {" "}This project pays nothing extra on acceptance, so no reward line is
              written — set one in Settings if it should.
            </>
          )}
        </p>
      )}

      {rewarding && (
        <div className="panel" style={{ marginBottom: 12 }}>
          <p className="hint" style={{ marginTop: 0 }}>
            One payment covering all {taskIds.length}. Each one will read as paid for
            without being given a share of it — the money was never quoted per task.
          </p>
          <div className="pair">
            <label className="field">
              <span className="eyebrow">Amount ({currency})</span>
              <input className="inp" type="number" step="any" autoFocus value={form.amount}
                     onChange={(e) => setForm({ ...form, amount: e.target.value })}
                     onKeyDown={(e) => { if (e.key === "Enter") record(); }} />
            </label>
            <label className="field">
              <span className="eyebrow">Note</span>
              <input className="inp" placeholder="50-task milestone" value={form.note}
                     onChange={(e) => setForm({ ...form, note: e.target.value })}
                     onKeyDown={(e) => { if (e.key === "Enter") record(); }} />
            </label>
          </div>
          <div className="controls">
            <button className="btn primary" disabled={!validReward} onClick={record}>
              Record for {taskIds.length} task{taskIds.length === 1 ? "" : "s"}
            </button>
            <button className="btn ghost" onClick={() => setRewarding(false)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}
