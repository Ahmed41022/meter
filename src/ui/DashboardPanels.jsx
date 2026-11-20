/**
 * The Overview's larger panels, as components.
 *
 * They were inline in DashboardView, which had grown to 598 lines doing three
 * jobs at once: preparing the figures, choosing the layout, and drawing nine
 * panels. These three are the biggest, and they are pure — every value they
 * draw arrives as a prop, and none of them reaches for the ledger. Pulling
 * them out leaves DashboardView about the numbers and leaves each panel small
 * enough to read in one go.
 */
import { formatMoney, formatShortDuration } from "../domain/money.js";
import { currenciesByValue } from "../domain/performance.js";
import { BY_COMPANY_ORDERS } from "../domain/order.js";
import { GoalMeter, goalFormatter } from "./parts.jsx";
import { useMoney } from "./useMoney.js";
import { moneyText, rateNote } from "./fxMoney.js";

/** A goal's period, said the way the sentence needs it. */
const PERIOD_WORD = { week: "this week", month: "this month" };

/** What each project is aiming at this period, and whether it is on pace. */
export function TargetsPanel({ targets, behind, onOpenProject }) {
  if (!targets.length) return null;
  return (
        <div className="sec" style={{ marginTop: 0, marginBottom: 26 }}>
          <div className="sec-head">
            <span className="eyebrow">Targets</span>
            <span className="eyebrow">{behind > 0 ? `${behind} behind` : "all on pace"}</span>
          </div>
          <div className="panel">
            {targets.map(({ project, goal, value, pacing }) => {
              const show = goalFormatter(goal.type, project.currency);
              return (
                <div className="trg" key={project.id}>
                  <div className="trg-top">
                    <button className="linkish trg-name"
                            onClick={() => onOpenProject(project.id)}>{project.name}</button>
                    <span className="trg-of">{PERIOD_WORD[goal.period]}</span>
                    <span className="goal-val">{show(value)} / {show(goal.target)}</span>
                  </div>
                  <GoalMeter type={goal.type} target={goal.target} value={value}
                             currency={project.currency} pace={pacing} />
                </div>
              );
            })}
          </div>
        </div>
  );
}

/** The segmented "order by" control both Overview breakdowns share. */
function OrderTabs({ label, orders, value, onChange }) {
  return (
    <div className="segmented small" role="tablist" aria-label={label}>
      {orders.map(([key, text]) => (
        <button key={key} role="tab" aria-selected={value === key}
                className={"seg" + (value === key ? " on" : "")}
                onClick={() => onChange(key)}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** Every project of one client totalled together. */
export function ByCompanyPanel({ show, companies, named, shares, sort, setSort }) {
  const fx = useMoney();
  if (!show) return null;
  return (
        <div className="sec">
          <div className="sec-head">
            <span className="eyebrow">By company</span>
            {named.length > 1 ? (
              <OrderTabs label="Order companies by" orders={BY_COMPANY_ORDERS} value={sort}
                         onChange={setSort} />
            ) : (
              <span className="eyebrow">
                {named.length} {named.length === 1 ? "company" : "companies"}
              </span>
            )}
          </div>
          <div className="panel">
            {companies.map((row) => {
              const share = shares?.get(row) ?? null;
              // The row's money in the display currency, when there is one;
              // otherwise as earned, as ever. The per-hour rates stay native.
              const earned = fx.show(row.billedCents, currenciesByValue);
              const waiting = fx.show(row.pendingCents, currenciesByValue);
              const voided = fx.show(row.cancelledCents, currenciesByValue);
              return (
                <div className={"crow" + (row.company === null ? " none" : "")} key={row.company ?? ""}>
                  <span className="crow-top">
                    <span className="crow-name">{row.company ?? "No company"}</span>
                    <span className="crow-amt" title={rateNote(earned) || undefined}>
                      {currenciesByValue(row.billedCents).length === 0
                        ? "—"
                        : moneyText(earned)}
                    </span>
                  </span>
                  <span className="crow-bar">
                    <span className="crow-fill"
                          style={{ width: `${(share ?? 0) * 100}%` }} />
                  </span>
                  <span className="crow-meta">
                    {formatShortDuration(row.billedMs)}
                    {row.idleMs > 0 && ` · ${formatShortDuration(row.idleMs)} idle`}
                    {/* The blended rate: what an hour of this client's work
                        actually came to across every project and task rate. */}
                    {row.rateCents !== null
                      && ` · ${formatMoney(row.rateCents, row.currency)}/hr`}
                    {row.timedRateCents !== null && row.rateCents !== row.timedRateCents
                      && ` (${formatMoney(row.timedRateCents, row.currency)}/hr timed)`}
                    {share !== null && ` · ${Math.round(share * 100)}% of revenue`}
                    {waiting.mode === "converted"
                      ? ((row.pendingCents ? Object.values(row.pendingCents).some((c) => c !== 0) : false)
                        && ` · ${moneyText(waiting)} pending`)
                      : row.currency && (row.pendingCents[row.currency] ?? 0) !== 0
                        && ` · ${formatMoney(row.pendingCents[row.currency], row.currency)} pending`}
                    {voided.mode === "converted"
                      ? (Object.values(row.cancelledCents ?? {}).some((c) => c !== 0)
                        && ` · ${moneyText(voided)} cancelled`)
                      : row.currency && (row.cancelledCents[row.currency] ?? 0) !== 0
                        && ` · ${formatMoney(row.cancelledCents[row.currency], row.currency)} cancelled`}
                    {row.projects.length > 1 && ` · ${row.projects.length} projects`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
  );
}

/** Where the period's time and money actually went. `rateCurrency` is the one
 *  currency the ranking by the hour was taken in, and so the one its figures
 *  are in. */
export function ByProjectPanel({
  rows, shownRows, orders, byRate, rateCurrency, top, widest, projectSort, setProjectSort,
  onOpenProject,
}) {
  const fx = useMoney();
  return (
      <div className="sec">
        <div className="sec-head">
          <span className="eyebrow">By project</span>
          {orders.length > 1 ? (
            <OrderTabs label="Order projects by" orders={orders} value={projectSort}
                       onChange={setProjectSort} />
          ) : (
            <span className="eyebrow">{rows.length ? `${rows.length} active` : ""}</span>
          )}
        </div>
        {/* One project carrying most of the income is a fact about risk rather
            than success, and the kind people notice too late. */}
        {top && top.share >= 0.3 && (
          <p className="concentration">
            <strong>{top.row.project.name}</strong> is {Math.round(top.share * 100)}% of it.
          </p>
        )}
        <div className="panel">
          {shownRows.length === 0 ? (
            <div className="empty">
              No project logged time in this period.
            </div>
          ) : shownRows.map(({
            project, billedMs, idleMs, billedCents, pendingCents, cancelledCents, perHour,
          }) => {
            // One colour for every bar. These are projects, not an ordered
            // scale, so shading them by size would double-encode the length.
            const cents = billedCents[project.currency] ?? 0;
            // In the display currency this is the project's whole settled
            // money; as earned it stays the figure in the project's own.
            const earned = fx.show(billedCents, currenciesByValue);
            const waiting = fx.show(pendingCents, currenciesByValue);
            const voided = fx.show(cancelledCents, currenciesByValue);
            const some = (figures) => Object.values(figures).some((c) => c !== 0);
            return (
              <button className="prow" key={project.id} onClick={() => onOpenProject(project.id)}>
                <span className="prow-top">
                  <span className="prow-name">{project.name}</span>
                  <span className="prow-amt" title={rateNote(earned) || undefined}>
                    {earned.mode === "converted" ? moneyText(earned) : formatMoney(cents, project.currency)}
                  </span>
                </span>
                <span className="prow-bar">
                  <span className="prow-billed"
                        style={{ width: `${(billedMs / widest) * 100}%` }} />
                  <span className="prow-idle"
                        style={{ width: `${(idleMs / widest) * 100}%` }} />
                </span>
                <span className="prow-meta">
                  {byRate && perHour !== null
                    && <strong>{formatMoney(perHour, rateCurrency)}/hr · </strong>}
                  {formatShortDuration(billedMs)} billed
                  {idleMs > 0 && ` · ${formatShortDuration(idleMs)} idle`}
                  {/* Otherwise a project whose money is all waiting on
                      acceptance reads as having earned nothing. */}
                  {waiting.mode === "converted"
                    ? some(pendingCents) && ` · ${moneyText(waiting)} pending`
                    : (pendingCents[project.currency] ?? 0) !== 0
                      && ` · ${formatMoney(pendingCents[project.currency], project.currency)} pending`}
                  {/* And a project whose work was turned down reads as having
                      earned nothing for no stated reason, with the hours
                      sitting right beside the zero. */}
                  {voided.mode === "converted"
                    ? some(cancelledCents) && ` · ${moneyText(voided)} cancelled`
                    : (cancelledCents[project.currency] ?? 0) !== 0
                      && ` · ${formatMoney(cancelledCents[project.currency], project.currency)} cancelled`}
                </span>
              </button>
            );
          })}
        </div>
      </div>
  );
}
