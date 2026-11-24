import { isPieceOnly } from "../../domain/earnings.js";
import { parseTaskRate, readPrice, resolveTaskId } from "../../domain/tasks.js";

/**
 * What the ledger-edit handlers share: how an id is minted, and how a task
 * prompt's answer becomes a task. Starting a session and moving sessions both
 * read the prompt the same way, so neither owns it.
 */
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/**
 * Turns a prompt answer into a task id plus the state change that must land
 * first. A new label reuses an existing task's id when it already matches, so
 * the prompt can never mint a duplicate the user would read as the same task.
 */
export const resolveTaskPick = (project, pick, createTask) => {
  if (pick?.label === undefined) return { id: pick?.taskId ?? null, prepare: (s) => s };
  const id = resolveTaskId(project, pick.label, uid());
  return { id, prepare: (s) => createTask(s, id, pick.label, pick.pay, pick.note, pick.minMs) };
};

/**
 * What the one pay box on the task prompt means, which depends on how the
 * project pays. A piece-rate project reads it as what one accepted item is
 * worth; an hourly one reads it as a rate, or as a share of the base — and
 * that includes hourly work with a per-item bonus, where the box says Rate.
 * Read as a price there, a task meant to pay $45 an hour was given a $45 item
 * price and no rate. Both readings take a decimal comma, as the editor does.
 *
 * Nothing is written when the box was left empty, because empty already has a
 * meaning — inherit — and a stored null would say it less clearly.
 */
export const payFields = (project, pay) => {
  if (!String(pay ?? "").trim()) return {};
  if (isPieceOnly(project)) {
    const price = readPrice(pay);
    return price === null ? {} : { price };
  }
  const { rate, factor } = parseTaskRate(pay);
  // `!= null`, not truthiness: zero is a rate somebody meant to type.
  return { ...(rate != null ? { rate } : {}), ...(factor != null ? { factor } : {}) };
};
