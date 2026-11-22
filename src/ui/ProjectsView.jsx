import { useMemo, useState } from "react";
import { elapsedMs, isRunning, lastActivityAt } from "../domain/time.js";
import { formatMoney, formatShortDuration } from "../domain/money.js";
import {
  companyOf, isDone as projectDone, isPaused, searchProjects,
} from "../domain/projects.js";
import { isCancelled, isPending, isPieceOnly, perTask } from "../domain/earnings.js";
import { isDone } from "../domain/objectives.js";
import { sessionCents } from "../domain/sessions.js";
import { pricer } from "../domain/terms.js";
import {
  CARD_ORDERS, LIFE_ORDERS, currenciesOf, groupOrder, opensDescending, orderByMoneyIn,
  orderByName, orderByNumber,
} from "../domain/order.js";
import { wordsFor } from "./words.js";
import SortBar from "./SortBar.jsx";
import { useCurrency, useDisplay } from "./CurrencyContext.jsx";
import CurrencySwitch from "./CurrencySwitch.jsx";
import { displayMoney } from "../domain/fxDisplay.js";
import { moneyText, rateNote } from "./fxMoney.js";
import NewProject from "./NewProject.jsx";

export { CURRENCIES } from "./NewProject.jsx";

/**
 * The Work tab and the Life tab are the same list asking different questions.
 *
 * Work asks what it earned. Life asks how long it took, and never shows a rate
 * or a currency — demanding one for something that cannot earn is what drove
 * the 0.00001 workaround in the first place.
 *
 * The caller decides which projects belong here; this only decides how to read
 * them.
 */
export default function ProjectsView({
  scope = "work", projects, sessions, earnings = [], objectives = [], now,
  defaultSort = "added", onOpen, onAdd, allProjects = null, companies = [],
}) {
  const life = scope === "life";
  const w = wordsFor(life);
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [query, setQuery] = useState("");
  // What was picked on the bar, or null to follow the synced default. It lasts
  // until the list is left, like the Overview period, and is never written
  // back: changing the default is Settings' job.
  const [picked, setPicked] = useState(null);
  const { choice, fxOn, rates } = useCurrency();
  const fxSettings = { choice, fxOn, rates };
  const orders = life ? LIFE_ORDERS : CARD_ORDERS;
  const usable = (key) => orders.some(([k]) => k === key);
  // A pick made on Work can outlive a switch to Life, where Earned is absent.
  const opens = (key) => ({ key, desc: opensDescending(key) });
  const sort = picked && usable(picked.key)
    ? picked
    : opens(usable(defaultSort) ? defaultSort : "added");

  // What a sitting came to: its rate, and a share of it for time over its
  // task's limit, as every other screen values it.
  const price = useMemo(() => pricer(projects, sessions), [projects, sessions]);
  const whole = (s) => sessionCents(s, -Infinity, Infinity, now, price);

  // Money is summed per currency — adding EGP to USD would be a lie. There is
  // no money on the Life tab at all, so its headline counts time instead.
  const totals = useMemo(() => {
    if (life) return [];
    const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
    const acc = {};
    sessions.forEach((s) => {
      const project = byId[s.projectId];
      if (!project || isPending(s) || isCancelled(s)) return;
      acc[s.currency] = (acc[s.currency] || 0)
        + sessionCents(s, -Infinity, Infinity, now, price);
    });
    // Money that never came from an hour still belongs in what you have
    // earned. Leaving it out understated the headline by more than half on a
    // ledger where most of the work was paid per accepted item.
    earnings.forEach((e) => {
      if (!byId[e.projectId] || isPending(e) || isCancelled(e)) return;
      acc[e.currency] = (acc[e.currency] || 0) + e.cents;
    });
    return Object.entries(acc);
  }, [life, projects, sessions, earnings, now, price]);

  // The headline in the display currency, when there is one to show. The order
  // is the one `totals` has always been in.
  const shownTotals = useDisplay(Object.fromEntries(totals));

  const trackedMs = useMemo(() => {
    if (!life) return 0;
    const mine = new Set(projects.map((p) => p.id));
    return sessions.filter((s) => mine.has(s.projectId))
      .reduce((total, s) => total + elapsedMs(s, now), 0);
  }, [life, projects, sessions, now]);

  /**
   * The cards in the chosen order. Everything it needs is read straight off
   * the sessions and earnings, as the cards read them.
   *
   * Earned is per currency, never summed across: a project's figures are
   * {EGP: ..., USD: ...} (a bonus can arrive in another currency than the
   * rate), and orderByMoney places it by its biggest single figure. The
   * currencies are laid out most hours worked first, the order the rest of the
   * app lists them in.
   */
  function ordered(list) {
    const { key, desc } = sort;
    const mineOf = (p) => sessions.filter((s) => s.projectId === p.id);
    switch (key) {
      case "earned": {
        const figures = (p) => {
          const acc = {};
          mineOf(p).filter((s) => !isPending(s) && !isCancelled(s)).forEach((s) => {
            acc[s.currency] = (acc[s.currency] || 0) + whole(s);
          });
          earnings.filter((e) => e.projectId === p.id && !isPending(e) && !isCancelled(e))
            .forEach((e) => { acc[e.currency] = (acc[e.currency] || 0) + e.cents; });
          return acc;
        };
        const ms = {};
        const ids = new Set(list.map((p) => p.id));
        sessions.filter((s) => ids.has(s.projectId)).forEach((s) => {
          ms[s.currency] = (ms[s.currency] || 0) + elapsedMs(s, now);
        });
        // Calculated once per project: the figures feed both the groups and
        // the sort.
        const memo = new Map(list.map((p) => [p.id, figures(p)]));
        const of = (p) => memo.get(p.id);
        return orderByMoneyIn(list, of, { desc, groups: groupOrder(currenciesOf(list, of), ms) },
          fxSettings);
      }
      case "recent":
        return orderByNumber(list, (p) => {
          const mine = mineOf(p);
          return mine.length ? Math.max(...mine.map((s) => lastActivityAt(s))) : null;
        }, desc);
      case "name":
        return orderByName(list, (p) => p.name, desc);
      case "time":
        return orderByNumber(list, (p) => {
          const ms = mineOf(p).reduce((a, s) => a + elapsedMs(s, now), 0);
          return ms > 0 ? ms : null;
        }, desc);
      default:
        // Added: the order the projects came in, which is the order today's
        // lists have always had. Turning it round reverses it.
        return desc ? list : [...list].reverse();
    }
  }

  const openCount = (projectId) =>
    objectives.filter((o) => o.projectId === projectId && !isDone(o)).length;

  /** One card. Defined once and handed to both groups, so a finished project
   *  reads exactly like a live one — it is filed away, not diminished. */
  const card = (p) => {
    const mine = sessions.filter((s) => s.projectId === p.id);
    const ms = mine.reduce((a, s) => a + elapsedMs(s, now), 0);
    const settled = (s) => !isPending(s) && !isCancelled(s);
    // Money is kept per currency: a project can hold sessions at one rate and a
    // bonus in another currency, and adding them printed one number in the
    // project's currency that was neither.
    const figures = (pred) => {
      if (life) return {};
      const acc = {};
      mine.filter(pred).forEach((s) => { acc[s.currency] = (acc[s.currency] || 0) + whole(s); });
      earnings.filter((e) => e.projectId === p.id && pred(e))
        .forEach((e) => { acc[e.currency] = (acc[e.currency] || 0) + e.cents; });
      return Object.fromEntries(Object.entries(acc).filter(([, c]) => c !== 0));
    };
    // The project's own currency leads, then the rest, biggest first.
    const cardOrder = (f) => Object.entries(f).sort((x, y) =>
      (y[0] === p.currency) - (x[0] === p.currency) || y[1] - x[1]);
    const cardMoney = (f) => displayMoney(f, fxSettings, cardOrder);
    const earned = figures(settled);
    // A card always says what it earned, even when that is nothing at all.
    const cents = cardMoney(Object.keys(earned).length ? earned : { [p.currency]: 0 });
    const waiting = cardMoney(figures(isPending));
    /**
     * What was earned here and then taken back.
     *
     * In no total — it never arrived. But a card showing hours against a
     * smaller figure than the hours imply, or against nothing at all, reads
     * as a bug in the app rather than as a batch that was turned down. The
     * amount is the missing half of that sentence.
     */
    const voided = cardMoney(figures(isCancelled));
    const said = (d) => moneyText(d);
    const tip = (d) => rateNote(d) || undefined;
    const open = openCount(p.id);
    const company = life ? null : companyOf(p);
    const stopped = isPaused(p) || projectDone(p);
    return (
      <button className={"card" + (life ? " off" : "") + (stopped ? " stopped" : "")} key={p.id}
              onClick={() => onOpen(p.id)}>
        <span>
          <span className="card-name">
            {mine.some(isRunning) && <span className="dot" />}
            {p.name}
            {isPaused(p) && <span className="tag">Paused</span>}
          </span>
          <span className="card-meta">
            {company && `${company} · `}
            {life
              ? `${mine.length} entr${mine.length === 1 ? "y" : "ies"}`
              // A project paid per accepted item has no hourly rate, and
              // printing currentRate gave it a confident $0.00/hr.
              : `${isPieceOnly(p)
                ? `${formatMoney(Math.round(perTask(p) * 100), p.currency)} per task`
                : `${formatMoney(Math.round(p.currentRate * 100), p.currency)}/hr`} · ${
                  mine.length} session${mine.length === 1 ? "" : "s"}`}
            {open > 0 && !stopped && ` · ${open} to do`}
          </span>
        </span>
        <span>
          <span className="card-amt" title={life ? undefined : tip(cents)}>
            {life ? (ms ? formatShortDuration(ms) : "—") : said(cents)}
          </span>
          <span className="card-dur">
            {life ? "tracked" : (ms ? formatShortDuration(ms) : "no time yet")}
            {waiting.mode === "converted" || waiting.entries.length > 0
              ? ` · ${said(waiting)} pending` : ""}
            {voided.mode === "converted" || voided.entries.length > 0
              ? ` · ${said(voided)} cancelled` : ""}
          </span>
        </span>
      </button>
    );
  };

  /** Finished work is filed, not deleted. Paused stays in the live list,
   *  because "not now" is a different statement from "over". */
  // Searching narrows the LIST only. The headline above still totals every
  // project, because what you have earned does not change while you look for
  // something.
  const matching = ordered(searchProjects(projects, query));
  const running = matching.filter((p) => !projectDone(p));
  const finished = matching.filter(projectDone);
  const searching = query.trim() !== "";
  // Worth a box only once the list is long enough to lose something in. Kept
  // visible while a query is live, so it never vanishes mid-search.
  const searchable = projects.length > 6 || searching;
  // A match inside a collapsed group is a match the reader cannot see.
  const openFinished = showDone || searching;

  return (
    <>
      <div className="grand">
        <span className="eyebrow">
          {life ? "Tracked across everything" : "Earned across everything"}
        </span>
        {!life && <CurrencySwitch display={shownTotals} className="grand-switch" />}
        {life ? (
          <div className="grand-amt">{trackedMs ? formatShortDuration(trackedMs) : "—"}</div>
        ) : shownTotals.mode === "converted" ? (
          <div className="grand-amt">
            {moneyText(shownTotals)}
            {rateNote(shownTotals) && <span className="fx-date">{rateNote(shownTotals)}</span>}
          </div>
        ) : totals.length === 0 ? (
          <div className="grand-amt">—</div>
        ) : totals.map(([cur, cents]) => (
          <div className="grand-amt" key={cur}>{formatMoney(cents, cur)}</div>
        ))}
      </div>

      {searchable && (
        <div className="finder">
          <input className="find" type="search" value={query} placeholder={`Find a ${w.projectNoun}`}
                 aria-label={`Find a ${w.projectNoun}`}
                 onChange={(e) => setQuery(e.target.value)} />
          {searching && (
            <button className="linkish find-clear" onClick={() => setQuery("")}>Clear</button>
          )}
        </div>
      )}

      {projects.length > 1 && (
        <SortBar label="Order the projects by" orders={orders} order={sort.key}
                 desc={sort.desc} opensDesc={opensDescending}
                 onChange={(key, desc) => setPicked({ key, desc })} />
      )}

      <div className="stack">
        {searching && matching.length === 0 && (
          <div className="panel empty">
            Nothing matches “{query.trim()}”.
          </div>
        )}

        {!searching && running.length === 0 && !adding && (
          <div className="panel empty">
            {finished.length > 0
              ? "Nothing running. Everything here is finished — it's all still below."
              : life
                ? "Nothing here yet. Add something you track but don’t work — sleep, play, time away."
                : "Nothing here yet. Add a project with its hourly rate, then start the meter."}
          </div>
        )}

        {running.map(card)}
      </div>

      {/* Finished projects are filed away rather than deleted: the hours
          happened and every total still counts them. Collapsed by default,
          because the list you work from is the live one. */}
      {finished.length > 0 && (
        <div className="sec" style={{ marginTop: 18 }}>
          <button className="done-head" aria-expanded={openFinished}
                  onClick={() => setShowDone((v) => !v)}>
            <span className={"chev" + (openFinished ? " open" : "")}>▶</span>
            <span className="eyebrow">
              Done · {finished.length}{searching && ` matching`}
            </span>
          </button>
          {openFinished && <div className="stack">{finished.map(card)}</div>}
        </div>
      )}


      <div className="sec">
        {adding ? (
          <NewProject life={life} noun={w.projectNoun} now={now}
                      projects={allProjects ?? projects} companies={companies}
                      onAdd={(fields, schedule) => { onAdd(fields, schedule); setAdding(false); }}
                      onCancel={() => setAdding(false)} />
        ) : (
          <div className="controls">
            <button className="btn primary" onClick={() => setAdding(true)}>
              New {w.projectNoun}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
