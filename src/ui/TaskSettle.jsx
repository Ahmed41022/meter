import { useState } from "react";
import { formatMoney, formatShortDuration } from "../domain/money.js";
import { findTask } from "../domain/tasks.js";
import { TASK, isOpenTask, taskState } from "../domain/taskState.js";
import {
  REWARD, acceptanceCents, bonusPerHour, paysOnAcceptance, rewardModel,
} from "../domain/earnings.js";

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
 *    counts them as earned where the project is paid as worked (until a
 *    rejection takes them back), and files the acceptance reward as pending —
 *    the one the task already has, re-priced, if it was handed in before.
 *  - ACCEPTED and REJECTED are offered for every task already handed in,
 *    answered or not. They are the only two answers that can come back, and
 *    an answer can be changed its mind about: rejecting is what cancels a
 *    task's pay, so the opposite button has to stay within reach afterwards
 *    or one wrong click costs a week's money with no way back to it.
 *  - REOPEN undoes a state on tasks that have one, for the ordinary case of
 *    having ticked the wrong row. On an answered task it takes back what the
 *    answer did, leaving the hours and the reward pending until the task is
 *    accepted again; on one only handed in it leaves the money alone.
 *
 * ONE REWARD sits apart from all of that. It is "finish fifty and we pay you
 * X" — a single payment naming every task in the selection, where splitting it
 * fifty ways would invent a price nobody quoted.
 */
const pad = (n) => String(n).padStart(2, "0");
/** datetime-local speaks local wall clock both ways; epoch integers stay the
 *  storage format either side of this boundary.
 *
 *  To the minute, not the day. A pay period shuts at an hour — Sunday 19:00
 *  in New York is 02:00 Monday here — so a day alone cannot say which side of
 *  it an answer fell, and a cutoff hour that no recorded time can reach is a
 *  setting that does nothing. */
const toInput = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromInput = (text, fallback) => {
  const at = new Date(text).getTime();
  return Number.isFinite(at) ? at : fallback;
};

/** A moment to the minute, read back through the box's own format, so what is
 *  recorded is exactly what the box shows. */
const toMinute = (t) => fromInput(toInput(t), t);

/** A moment in words, for the hint that says what each button will record. */
const spoken = (t) => new Date(t).toLocaleString(undefined, {
  weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});

export default function TaskSettle({
  project, taskIds, rows, sharedOwedIds, allIds, now = Date.now(), lastWorkedOn = () => null,
  onSubmit, onAnswer, onReopen, onReward, onPay, onSelectAll, onClear,
}) {
  const [rewarding, setRewarding] = useState(false);
  const [form, setForm] = useState({ amount: "", note: "" });
  /**
   * A time typed into the box, or null while the defaults stand.
   *
   * Which moment a button records depends on what it records. SUBMITTING is
   * dated from the end of the last sitting on the tasks being handed in,
   * because work is nearly always handed in as it is finished. An ANSWER is
   * dated from the minute you press it, because you are entering it as you
   * read it — and nothing about when you did the work says when somebody else
   * got round to it.
   *
   * So the defaults are worked out at the CLICK, from what is selected then.
   * Fixing one when the bar opened went stale twice over: a selection changed
   * after it (an open task ticked and then unticked) kept the first one's
   * last sitting, and a bar left open across a cutoff kept a minute that had
   * passed — either way an acceptance stored a payday early. Once a time is
   * typed it is what every button records, because then it is a fact you
   * have stated rather than a guess about which one you meant.
   *
   * The answer's time is the one that decides a payday, so getting its
   * default wrong is a whole pay period, not a cosmetic nicety.
   */
  const [typed, setTyped] = useState(null);

  const currency = project.currency;
  const model = rewardModel(project);
  const msOf = (id) => rows.find((r) => r.taskId === id)?.billedMs ?? 0;

  const open = taskIds.filter((id) => isOpenTask(findTask(project, id)));
  // Anything handed in can be answered, including something answered before.
  // Re-answering is idempotent, so offering it costs nothing and withholding
  // it would strand a mistaken rejection.
  const stated = taskIds.filter((id) => taskState(findTask(project, id)) !== null);

  const typedAt = typed === null ? null : fromInput(typed, null);
  /** When the last sitting on the open tasks ended, as of `at` — a sitting
   *  still running ends when they are handed in — or null where they have
   *  none, which leaves the moment itself. */
  const lastSitting = (at) => lastWorkedOn(open, at);
  const submitDefault = (at) => toMinute(lastSitting(at) ?? at);
  // Read from the clock at the click, not from `now`, which is only as fresh
  // as the last render.
  const submitAt = () => typedAt ?? submitDefault(Date.now());
  const answerAt = () => typedAt ?? toMinute(Date.now());
  // The box shows what will be recorded: the submission time where there is
  // something to submit, the current minute where there are only answers.
  const shown = typed ?? toInput(open.length > 0 ? submitDefault(now) : now);

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
          <button className="btn primary" onClick={() => onSubmit(open, submitAt())}>
            Submit {open.length}
          </button>
        )}
        {stated.length > 0 && (
          <>
            <button className="btn primary" onClick={() => onAnswer(stated, TASK.ACCEPTED, answerAt())}>
              Accepted {stated.length}
            </button>
            <button className="btn ghost" onClick={() => onAnswer(stated, TASK.CANCELLED, answerAt())}>
              Rejected {stated.length}
            </button>
          </>
        )}
        {(open.length > 0 || stated.length > 0) && (
          <label className="selbar-when">
            <span className="eyebrow">On</span>
            {/* Clearing the box is the other way back to the defaults. */}
            <input className="inp" type="datetime-local" value={shown}
                   aria-label="When this happened"
                   onChange={(e) => setTyped(e.target.value || null)} />
          </label>
        )}
        {typed !== null && (
          <button className="linkish" onClick={() => setTyped(null)}>use the defaults</button>
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

      {(open.length > 0 || stated.length > 0) && (
        <p className="hint" style={{ marginTop: -4, marginBottom: 12 }}>
          {open.length > 0 && (
            <>
              Submitting stops the clock on {these} for good — no more hours can be
              recorded against {them}.
              {/* Neither branch calls the hours settled. On a project paid as
                  worked they count from here, but a rejection still cancels
                  them, so "settled" would promise something the next answer
                  can take back. */}
              {paysOnAcceptance(project)
                ? " The money stays pending: on this project nothing is earned until"
                  + " somebody accepts the work, so it is reported on its own line"
                  + " rather than in your earnings until you hear back."
                : " On this project the hours count as earned once they are handed in,"
                  + " unless the answer is a rejection, which cancels them."}
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
              {model !== null
                && " A task handed in before keeps the one reward it has, re-priced from its"
                  + " hours, rather than gaining a second."}
              {" "}
            </>
          )}
          {stated.length > 0 && (
            <>
              Accepted pays the hours and each task&apos;s own reward; Rejected cancels that
              money and keeps the hours on the record. Reopening a task that has had an answer
              takes back what the answer did — its money is pending until it is accepted
              again — while reopening one only handed in leaves its money alone.{" "}
            </>
          )}
          {/* What each button will record, said outright: the box can show
              only one time, and with both kinds of task ticked the two
              defaults differ. */}
          {typedAt !== null ? (
            <>
              Every button records the time in the box,{" "}
              <strong>{spoken(typedAt)}</strong>.{" "}
            </>
          ) : (
            <>
              {open.length > 0 && (lastSitting(now) === null
                ? "Submit records the minute you press it"
                : <>Submit records <strong>{spoken(submitDefault(now))}</strong>, when the last
                  sitting on {these} ended</>)}
              {open.length > 0 && stated.length > 0 && "; "}
              {stated.length > 0 && "Accepted and Rejected record the minute you press them"}
              {". Type a time in the box and every button records that instead. "}
            </>
          )}
          The time is when this happened, not when you tick the box. On an answer it
          decides which pay period the money falls in, to the minute of the cutoff, so an
          acceptance recorded late slips a whole payday.
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
