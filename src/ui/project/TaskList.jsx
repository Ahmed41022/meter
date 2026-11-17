import {
  PAY, hasReward, isPending, namesTask, paysOnAcceptance, perTask, taskPay, tasksOf,
} from "../../domain/earnings.js";
import { isRunning, lastActivityAt } from "../../domain/time.js";
import { limitFor } from "../../domain/terms.js";
import {
  ORDER, ORDERS, findTask, nameTakenBy, sessionsUnderTask, sortTaskRows,
} from "../../domain/tasks.js";
import TaskBreakdown from "../TaskBreakdown.jsx";
import TaskEditor from "../TaskEditor.jsx";
import TaskSettle from "../TaskSettle.jsx";

/**
 * The By task section: the sort controls, picking tasks to settle, the task
 * editor and the breakdown itself. Its state stays with the page, because the
 * section is only mounted while the project has tasks and a sort order or a
 * half-picked batch should not be forgotten when the last task goes and
 * another arrives.
 */
export default function TaskList({
  project, sessions, idleSessions, now, earnings, w, offClock, piece, settles, canSettle,
  rawTaskRows, order, setOrder, orderDesc, setOrderDesc, pickedTasks, setPickedTasks,
  editingTask, setEditingTask, filterTask, setFilterTask, setLedgerOpen, setSelected,
  onSaveTask, onDeleteTask, onSetOwnLimit, onSubmitTasks, onAnswerTasks, onReopenTasks,
  onRewardTasks, onSetPayStateMany,
}) {
  /**
   * Whether money here is CLAIMED per task, which decides whether a task with
   * no money against it is owed something or simply worth nothing.
   *
   * The project's own per-item price says yes, and so does any single task
   * carrying one — some projects price nothing centrally and everything per
   * task. So does being paid once accepted, where the hourly money itself is
   * claimed a task at a time. Anywhere else, "not claimed" against a task
   * would be a warning about money that was never owed, on every row, forever.
   */
  const accepts = settles || hasReward(project) || paysOnAcceptance(project)
    || rawTaskRows.some((r) => r.price != null);

  /**
   * What a task is worth, for ordering by it.
   *
   * The clock's money plus whatever reward names this task and this task
   * alone. A shared reward is left out rather than divided, exactly as the row
   * itself leaves it out: a fiftieth of a milestone payment is not a figure
   * anybody quoted, and sorting by it would rank rows on an invented number.
   */
  const payOf = (r) => {
    if (!r.taskId || !accepts) return r.billedCents;
    const pay = taskPay(earnings, r.taskId);
    return r.billedCents + pay.settled + pay.pending;
  };
  // Off the clock there is no amount to sort by — the money columns are not
  // merely zero there, they are absent.
  const orders = offClock ? ORDERS.filter(([key]) => key !== ORDER.PAY) : ORDERS;
  const taskRows = sortTaskRows(rawTaskRows, order, orderDesc, payOf);
  const pickable = taskRows.filter((r) => r.taskId).map((r) => r.taskId);
  const toggleTask = (id) =>
    setPickedTasks((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  /**
   * When the last sitting on some tasks ended, or null where they have none.
   *
   * The default time for submitting them, because work is nearly always
   * handed in as it is finished — and when a pay cutoff falls between
   * finishing and remembering to tick the box, the difference is a whole
   * payday. Asked of the tasks actually being submitted, at the click, rather
   * than of everything ticked when the bar opened: a task already handed in
   * and ticked alongside has a last sitting that says nothing about these. A
   * sitting still running ends when they go in, because submitting stops it,
   * so it counts as ending at `at`.
   */
  const lastWorkedOn = (ids, at) => sessions
    .filter((s) => ids.includes(s.taskId))
    .reduce((latest, s) => Math.max(latest, isRunning(s) ? at : (lastActivityAt(s) ?? 0)), 0)
    || null;

  /**
   * The pending lines that answering a task will never settle: a reward covering
   * fifty tasks is not paid by accepting one of them. Accept handles
   * everything else, so offering "mark paid" for the rest as well would be two
   * buttons doing the same thing to the same line.
   */
  const sharedOwedIds = earnings
    .filter((e) => !e.deletedAt && isPending(e) && tasksOf(e).length > 1
      && pickedTasks.some((t) => namesTask(e, t)))
    .map((e) => e.id);

  return (
    <div className="sec">
      <div className="sec-head">
        <span className="eyebrow">{w.byTask}</span>
        {canSettle && pickable.length > 1 ? (
          <button className="linkbtn"
                  onClick={() => setPickedTasks(
                    pickedTasks.length === pickable.length ? [] : pickable
                  )}>
            {pickedTasks.length === pickable.length ? "Select none" : `Select all ${pickable.length}`}
          </button>
        ) : (
          <span className="eyebrow">
            {taskRows.length} {w.task}{taskRows.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {/* How the list reads. Quiet until chosen, because the sort is a
          tool you reach for rather than a figure to be read. Clicking the
          order already on turns it round — "least idle first" is a real
          question and does not deserve a control of its own. */}
      {taskRows.length > 1 && (
        <div className="sortbar" role="group" aria-label="Order the tasks by">
          <span className="eyebrow">Sort</span>
          {orders.map(([key, label]) => (
            <button key={key} className={"sortbtn" + (order === key ? " on" : "")}
                    aria-pressed={order === key}
                    onClick={() => {
                      if (order === key) setOrderDesc((v) => !v);
                      else { setOrder(key); setOrderDesc(true); }
                    }}>
              {label}
              {order === key && <span aria-hidden="true">{orderDesc ? " ↓" : " ↑"}</span>}
            </button>
          ))}
        </div>
      )}

      {canSettle && pickedTasks.length > 0 && (
        <TaskSettle
          project={project} taskIds={pickedTasks} rows={taskRows}
          sharedOwedIds={sharedOwedIds} allIds={pickable}
          now={now} lastWorkedOn={lastWorkedOn}
          onSubmit={(ids, at) => { onSubmitTasks(ids, at); setPickedTasks([]); }}
          onAnswer={(ids, answer, at) => { onAnswerTasks(ids, answer, at); setPickedTasks([]); }}
          onReopen={(ids) => { onReopenTasks(ids); setPickedTasks([]); }}
          onReward={(entry) => { onRewardTasks(pickedTasks, entry); setPickedTasks([]); }}
          onPay={() => { onSetPayStateMany(sharedOwedIds, PAY.PAID); setPickedTasks([]); }}
          onSelectAll={() => setPickedTasks(pickable)}
          onClear={() => setPickedTasks([])} />
      )}
      {/* Only while the task is still there to edit: one removed under
          the open form, by an undo or by the other device, would leave
          it reading the fields of nothing. */}
      {editingTask && findTask(project, editingTask) && (
        <div style={{ marginBottom: 12 }}>
          <TaskEditor words={w} key={editingTask}
            task={findTask(project, editingTask)}
            currency={project.currency}
            projectRate={project.currentRate}
            projectPrice={perTask(project)}
            byAnswer={paysOnAcceptance(project)}
            projectLimit={limitFor(project, { ...findTask(project, editingTask), limitMs: null })}
            sessionCount={sessionsUnderTask([...sessions, ...idleSessions], editingTask)}
            nameTakenBy={(label) => nameTakenBy(project, label, editingTask)}
            onCancel={() => setEditingTask(null)}
            onSave={({ limitMs, ...patch }) => {
              onSaveTask(editingTask, patch);
              if (limitMs !== undefined) onSetOwnLimit?.(editingTask, limitMs);
              setEditingTask(null);
            }}
            onDelete={() => {
              onDeleteTask(editingTask);
              if (filterTask === editingTask) setFilterTask(null);
              setEditingTask(null);
            }}
          />
        </div>
      )}
      <TaskBreakdown offClock={offClock} piece={piece} rows={taskRows}
                     currency={project.currency} active={filterTask}
                     earnings={accepts ? earnings : null}
                     selected={canSettle ? pickedTasks : null}
                     onToggleSelect={canSettle ? toggleTask : undefined}
                     onEdit={(id) => setEditingTask(id)}
                     onPick={(key) => {
                       setFilterTask(key === filterTask ? null : key);
                       setLedgerOpen(true);
                       setSelected([]);
                     }} />
    </div>
  );
}
