import { useState } from "react";
import { elapsedMs, isOpen, isRunning, startedAt } from "../../domain/time.js";
import { formatDuration, formatMoney, formatShortDuration } from "../../domain/money.js";
import { PAY, earnedFrom, isCancelled, isPending, priceFor } from "../../domain/earnings.js";
import {
  isIdle, overLimitMs, wasCorrected, wasManual,
} from "../../domain/sessions.js";
import { TASK, taskState } from "../../domain/taskState.js";
import { UNASSIGNED, findTask, rateFor, taskLabel } from "../../domain/tasks.js";
import TaskPrompt from "../TaskPrompt.jsx";
import SessionEditor from "../SessionEditor.jsx";
import ManualSession from "../ManualSession.jsx";
import {
  SESSION_ORDERS, currenciesOf, groupOrder, opensDescending, orderByMoney, orderByNumber,
} from "../../domain/order.js";
import SortBar from "../SortBar.jsx";
import { date, time } from "./format.js";
import { currenciesByValue } from "../../domain/performance.js";
import { useDisplay } from "../CurrencyContext.jsx";
import CurrencySwitch from "../CurrencySwitch.jsx";
import { moneyText, rateNote } from "../fxMoney.js";

/** Above this many rows the ledger is collapsed on arrival, so Settings and
 *  the per-task figures stay reachable without a long scroll. */
const LEDGER_AUTO_COLLAPSE = 5;

/** What marking these sessions would say against their tasks' answers: how
 *  many it touches, under what, and what the mark would claim about them. */
const contradiction = (status, { rejected, accepted }) => {
  const n = rejected + accepted;
  const under = rejected && accepted
    ? `rejected tasks (${rejected}) and accepted ones (${accepted})`
    : rejected
      ? (rejected === 1 ? "a rejected task" : "rejected tasks")
      : (accepted === 1 ? "an accepted task" : "accepted tasks");
  const claim = status === PAY.PAID
    ? "money came in for work that was turned down"
    : !accepted
      ? "money is still to come for work that was turned down"
      : !rejected
        ? "work already accepted is still waiting to be paid"
        : "money is still to come for work that has already been answered";
  return `${n} of the selected sessions ${n === 1 ? "is" : "are"} under ${under}. Marking `
    + `${n === 1 ? "it" : "them"} ${status === PAY.PAID ? "paid" : "pending"} says ${claim}.`;
};

/**
 * The session list: grouping by task filter, selection and its bulk actions,
 * adding time by hand, and the rows with their editing wiring. Its own
 * questions (what is selected, what has been asked, which row is open for
 * editing) live here; what the rest of the page also needs is passed in.
 */
export default function Ledger({
  project, sessions, idleSessions, now, price, whole, totalFigures, totalMs, currency, offClock,
  piece, settles, stopped, w, earnings, findOverlaps, focusSession, focusRow, ledgerOpen,
  setLedgerOpen, filterTask, setFilterTask, selected, setSelected, setEditingTask, setSettling,
  onSetPayStateMany, onAssign, onCorrect, onRevertCorrection, onDeleteSession, onAddManual,
  defaultSort = "newest",
}) {
  const [addingTime, setAddingTime] = useState(false);
  const shownTotal = useDisplay(totalFigures, currenciesByValue);
  const [bulkPrompt, setBulkPrompt] = useState(false);
  // A mark waiting on a yes because it would contradict a task's answer.
  // Tied to the rows it was asked about, so changing the selection drops it.
  const [asked, setAsked] = useState(null);           // {status, ids} | null
  const [editingSession, setEditingSession] = useState(null);
  // A pick on the bar, or null to follow the synced default; lasts until the
  // page is left.
  const [picked, setPicked] = useState(null);
  const sort = picked ?? { key: defaultSort, desc: opensDescending(defaultSort) };

  // The ledger shows both kinds; the totals above keep them apart.
  const ordered = [...sessions, ...idleSessions].sort((a, b) => startedAt(b) - startedAt(a));
  /**
   * What a sitting is worth, as the figure on its row: one currency's cents,
   * or null where it is worth nothing. Idle time earns nothing and a rejected
   * sitting never arrived (the totals above leave it out the same way), so
   * both sink. A running sitting is valued as of now, as its row shows it.
   * Off the clock there is no money, so the row's figure is its length.
   */
  const moneyOf = (s) => {
    if (isIdle(s) || isCancelled(s)) return {};
    return piece
      ? { [currency]: earnedFrom(earnings, s.id) }
      : { [s.currency]: whole(s) };
  };
  const hoursBy = {};
  for (const s of ordered) hoursBy[s.currency] = (hoursBy[s.currency] || 0) + elapsedMs(s, now);
  const byAmount = (rows) => (offClock
    ? orderByNumber(rows, (s) => (elapsedMs(s, now) > 0 ? elapsedMs(s, now) : null), sort.desc)
    : orderByMoney(rows, moneyOf, {
      desc: sort.desc, groups: groupOrder(currenciesOf(rows, moneyOf), hoursBy),
    }));
  // The ledger is one flat list, so a sort needs no day headings to give up.
  // Newest turned round is oldest first.
  const arranged = sort.key === "amount"
    ? byAmount(ordered)
    : orderByNumber(ordered, startedAt, sort.desc);
  const visible = filterTask
    ? arranged.filter((s) =>
        filterTask === UNASSIGNED ? !s.taskId : s.taskId === filterTask)
    : arranged;
  const showLedger = ledgerOpen ?? (visible.length <= LEDGER_AUTO_COLLAPSE && !filterTask);
  // The session the editor is open on, for as long as it exists. Deleted from
  // its own row while the form is open, it has no times left to read, and a
  // form reading them anyway would take the whole page down with it.
  const editedSession = editingSession
    ? ordered.find((x) => x.id === editingSession) ?? null
    : null;
  const selecting = selected.length > 0;
  const toggleSelect = (id) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  /**
   * How many selected sessions a mark would set against their task's answer.
   *
   * A rejected task's sessions are cancelled because the work was turned
   * down, so marking them paid or pending says money is coming for it. An
   * accepted task's are paid, so marking them pending says it is still to
   * come. Either can be meant — an answer overturned later, a payment that
   * bounced — but it is far more often a row ticked by mistake, so the bar
   * says so and waits for a yes. Nothing else is asked about.
   */
  const against = (status) => {
    const count = { rejected: 0, accepted: 0 };
    for (const s of ordered) {
      if (!selected.includes(s.id) || !s.taskId) continue;
      const answer = taskState(findTask(project, s.taskId));
      if (answer === TASK.CANCELLED) count.rejected += 1;
      else if (answer === TASK.ACCEPTED && status === PAY.PENDING) count.accepted += 1;
    }
    return count;
  };
  const mark = (status, anyway = false) => {
    const count = against(status);
    if (!anyway && count.rejected + count.accepted > 0) {
      setAsked({ status, ids: selected });
      return;
    }
    onSetPayStateMany(selected, status);
    setSelected([]);
    setAsked(null);
  };
  const askedAbout = asked && asked.ids.length === selected.length
    && asked.ids.every((id) => selected.includes(id)) ? asked.status : null;
  const objection = askedAbout ? against(askedAbout) : null;
  const askedNow = objection && objection.rejected + objection.accepted > 0 ? askedAbout : null;

  return (
    <div className="sec">
      <div className="sec-head">
        <button className="toggle" onClick={() => setLedgerOpen(!showLedger)}
                aria-expanded={showLedger}>
          <span className={"chev" + (showLedger ? " open" : "")}>▶</span>
          <span className="eyebrow">
            {w.ledger} · {ordered.length}{offClock
              ? ` entr${ordered.length === 1 ? "y" : "ies"}`
              : ` session${ordered.length === 1 ? "" : "s"}`}
          </span>
        </button>
        <span className="eyebrow">
          {!offClock && <>
            {moneyText(shownTotal)}
            {rateNote(shownTotal) && ` ${rateNote(shownTotal)}`}
            {" "}<CurrencySwitch display={shownTotal} />{" · "}
          </>}
          {totalMs ? formatShortDuration(totalMs) : "0m"}
          {!stopped && <>
            {" · "}
            <button className="linkish" onClick={() => setAddingTime((v) => !v)}>
              {addingTime ? "cancel" : "add time"}
            </button>
          </>}
        </span>
      </div>

      {addingTime && (
        <div style={{ marginBottom: 14 }}>
          <ManualSession
            project={project} offClock={offClock} now={now} findOverlaps={findOverlaps}
            sessions={[...sessions, ...idleSessions]}
            onCancel={() => setAddingTime(false)}
            // Closed only once the time is in. A refused block keeps what
            // was typed, so the reason can be read and the entry fixed.
            onSave={(entry) => { if (onAddManual(entry)) setAddingTime(false); }} />
        </div>
      )}

      {filterTask && (
        <>
          <button className="chip" onClick={() => setFilterTask(null)}>
            Showing {filterTask === UNASSIGNED ? "sessions with no task" : taskLabel(project, filterTask)} ✕
          </button>
          {/* Filtering down to a task is what you do in order to WORK on it,
              and its note is where the ids live. Making them readable only
              from the summary above would mean scrolling away from the
              sessions you came here for. */}
          {findTask(project, filterTask)?.note && (
            <div className="filter-note">
              {findTask(project, filterTask).note}
              <button className="linkish" onClick={() => setEditingTask(filterTask)}>edit</button>
            </div>
          )}
        </>
      )}

      {selecting && (
        <div className="selbar">
          {askedNow ? (
            <>
              <span className="selbar-count" role="alert"
                    style={{ color: "var(--ink-2)", fontWeight: 500 }}>
                {contradiction(askedNow, objection)}
              </span>
              <button className="btn primary" onClick={() => mark(askedNow, true)}>
                Mark {askedNow === PAY.PAID ? "paid" : "pending"} anyway
              </button>
              <button className="btn ghost" onClick={() => setAsked(null)}>Cancel</button>
            </>
          ) : (
            <>
              <span className="selbar-count">{selected.length} selected</span>
              <button className="btn primary" onClick={() => setBulkPrompt(true)}>
                {w.assign}
              </button>
              {/* Work paid on acceptance arrives pending and is settled in
                  batches, which is how it actually gets approved. */}
              <button className="btn ghost" onClick={() => mark(PAY.PAID)}>Mark paid</button>
              <button className="btn ghost" onClick={() => mark(PAY.PENDING)}>Mark pending</button>
              <button className="btn ghost" onClick={() => setSelected([])}>Clear</button>
            </>
          )}
        </div>
      )}

      {bulkPrompt && (
        <div style={{ marginBottom: 12 }}>
          <TaskPrompt
            project={project} confirmLabel={`Move ${selected.length} session${selected.length === 1 ? "" : "s"}`}
            onCancel={() => setBulkPrompt(false)}
            onConfirm={(pick) => {
              onAssign(selected, pick);
              setSelected([]);
              setBulkPrompt(false);
            }}
          />
        </div>
      )}

      {showLedger && visible.length > 1 && (
        <div className="controls" style={{ marginTop: 0, marginBottom: 12 }}>
          <button className="btn ghost"
                  onClick={() => setSelected(
                    selected.length === visible.length ? [] : visible.map((x) => x.id)
                  )}>
            {selected.length === visible.length ? "Deselect all" : `Select all ${visible.length}`}
          </button>
        </div>
      )}

      {showLedger && visible.length > 1 && (
        <SortBar label="Order the sessions by"
                 orders={offClock ? SESSION_ORDERS.map(([k, l]) => [k, k === "amount" ? "Duration" : l]) : SESSION_ORDERS}
                 order={sort.key} desc={sort.desc} opensDesc={opensDescending}
                 onChange={(key, desc) => setPicked({ key, desc })} />
      )}

      {editedSession && (
        <div style={{ marginBottom: 12 }}>
          <SessionEditor
            key={editedSession.id}
            session={editedSession}
            project={project} findOverlaps={findOverlaps}
            sessions={[...sessions, ...idleSessions]}
            onCancel={() => setEditingSession(null)}
            onSave={(window_) => { onCorrect(editingSession, window_); setEditingSession(null); }}
            onRevert={() => { onRevertCorrection(editingSession); setEditingSession(null); }}
          />
        </div>
      )}

      {showLedger && (
      <div className="panel">
        {visible.length === 0 ? (
          <div className="empty">
            {filterTask ? w.emptyFiltered : w.emptyLedger}
          </div>
        ) : visible.map((s) => (
          <div className={"row pick" + (isIdle(s) ? " is-idle" : "")
                 + (isCancelled(s) ? " is-void" : "")
                 + (selected.includes(s.id) ? " sel" : "")
                 + (s.id === focusSession ? " focus" : "")}
               ref={s.id === focusSession ? focusRow : null}
               key={s.id}>
            <input type="checkbox" className="row-check" checked={selected.includes(s.id)}
                   aria-label={`Select session from ${date(startedAt(s))}`}
                   onChange={() => toggleSelect(s.id)} />
            <div>
              <div className="row-when">
                {date(startedAt(s))} · {time(startedAt(s))}{isRunning(s) && " · running"}
                {isPending(s) && <span className="tag">Pending</span>}
                {isCancelled(s) && <span className="tag">Cancelled</span>}
                {isIdle(s) && <span className="tag">Idle</span>}
                {wasCorrected(s) && <span className="edited">Edited</span>}
                {wasManual(s) && <span className="edited">Added</span>}
                {!isOpen(s) && (
                  <>
                    {" "}
                    <button className="linkish" onClick={() => setEditingSession(s.id)}>edit</button>
                    {/* The second way in. Acceptance lands days after the
                        work, so the answer at stop time is often "not yet". */}
                    {settles && (
                      <>
                        {" · "}
                        <button className="linkish" onClick={() => setSettling(s.id)}>
                          {earnedFrom(earnings, s.id) > 0 ? "add more" : "what it earned"}
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
              <div className="row-meta">
                {s.taskId ? `${taskLabel(project, s.taskId)} · ` : `${w.noTask} · `}
                {formatDuration(elapsedMs(s, now))}
                {!offClock && (piece ? (
                  // A piece-rate project pays for accepted items, so an
                  // hourly figure here is a $0.00 that means nothing. What it
                  // is worth is the price of what this sitting produced.
                  <>
                    {" · "}
                    {priceFor(project, findTask(project, s.taskId)) !== null
                      ? `${formatMoney(Math.round(priceFor(project, findTask(project, s.taskId)) * 100), currency)} per item`
                      : "no price set"}
                  </>
                ) : (
                  <>
                    {" at "}
                    {formatMoney(Math.round(rateFor(project, s) * 100), s.currency)}/hr
                    {rateFor(project, s) !== s.rate && " (task rate)"}
                    {/* Said, because the figure on the right is less than
                        the hours at this rate, and would read as a slip. */}
                    {overLimitMs(s, -Infinity, Infinity, now, price) > 0
                      && ` · ${formatShortDuration(overLimitMs(s, -Infinity, Infinity, now, price))} over the limit at ${Math.round(price.limit(s).factor * 100)}%`}
                  </>
                ))}
                {s.segments.length > 1 && ` · ${s.segments.length} blocks`}
              </div>
            </div>
            <span className="row-amt">
              {offClock
                ? formatShortDuration(elapsedMs(s, now))
                : piece
                  ? formatMoney(earnedFrom(earnings, s.id), currency)
                  : formatMoney(whole(s), s.currency)}
            </span>
            <button className="x" aria-label="Remove session" onClick={() => onDeleteSession(s.id)}>×</button>
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
