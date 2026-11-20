import { useState } from "react";
import { COMMON_CURRENCIES, knownCurrencies } from "../../domain/fx.js";
import { HOSTS } from "../../fx/rates.js";

/** "19 November 2026" from the feed's plain date, with no time zone to shift it. */
const dayWords = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
};

/** How long ago, in the coarsest unit that is not a lie: "just now", "5 hours". */
const agoWords = (ms) => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 120) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
};

let names = null;
/** "Egyptian Pound" for EGP, or "" where the platform cannot say. */
const nameOf = (code) => {
  try {
    names ??= new Intl.DisplayNames(undefined, { type: "currency" });
    const n = names.of(code);
    return n && n !== code ? n : "";
  } catch {
    return "";
  }
};

function Status({ fx, now }) {
  const { status, error, rates, fetchedAt } = fx;
  if (status === "off") return <p className="fx-status">Off. Totals show each currency as earned.</p>;
  if (status === "loading") return <p className="fx-status" role="status">Fetching…</p>;
  const have = rates
    ? `Rates from ${dayWords(rates.date)}${status === "error" ? `, fetched ${agoWords(now - fetchedAt)}` : ""}.`
    : "";
  if (status === "error") {
    return (
      <p className="fx-status err" role="status">
        {error} {have ? `Using the saved ones: ${have}` : "No saved rates, so only “As earned” works."}
      </p>
    );
  }
  return (
    <p className="fx-status" role="status">
      {have || "No rates yet."}
    </p>
  );
}

/**
 * Live exchange rates: the on/off switch, which rates are in use, and the
 * currencies the switcher offers.
 *
 * The switch and the favourites are synced preferences (the owner's choices);
 * the rates themselves are per-device public data (see fx/rates.js). Off is the
 * default, and while it is off the app never contacts the rates feed.
 */
export default function CurrencySection({
  fxOn, onFxOn, fx, now, favourites, onFavourites, displayCurrency, onDisplayCurrency,
}) {
  const [pick, setPick] = useState("");
  const offered = (fx.rates ? knownCurrencies(fx.rates) : COMMON_CURRENCIES)
    .filter((c) => !favourites.includes(c));
  const choice = offered.includes(pick) ? pick : (offered[0] ?? "");

  const move = (i, by) => {
    const next = [...favourites];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onFavourites(next);
  };
  const shown = displayCurrency === "earned" || favourites.includes(displayCurrency)
    ? favourites : [...favourites, displayCurrency];

  return (
    <section className="settings-sec" aria-labelledby="settings-currency">
      <h2 className="settings-title" id="settings-currency">Currency</h2>
      <div className="panel">
        <label className="fx-switch">
          <input type="checkbox" checked={fxOn} onChange={(e) => onFxOn(e.target.checked)} />
          Use live exchange rates
        </label>
        <Status fx={fx} now={now} />
        <div className="controls">
          <button className="btn ghost" disabled={!fxOn || fx.status === "loading"}
                  onClick={fx.refresh}>
            Refresh now
          </button>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <span className="eyebrow">Favourite currencies</span>
        <div role="list" aria-label="Favourite currencies">
          {favourites.map((code, i) => (
            <div className="fav-row" role="listitem" key={code}>
              <span className="fav-code">
                {code}<span className="fav-name">{nameOf(code)}</span>
              </span>
              <button className="btn ghost" aria-label={`Move ${code} up`}
                      disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button className="btn ghost" aria-label={`Move ${code} down`}
                      disabled={i === favourites.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button className="btn ghost" aria-label={`Remove ${code}`}
                      disabled={favourites.length === 1}
                      onClick={() => onFavourites(favourites.filter((c) => c !== code))}>
                Remove
              </button>
            </div>
          ))}
        </div>
        <div className="fav-add">
          <select className="inp" aria-label="Currency to add" value={choice}
                  onChange={(e) => setPick(e.target.value)}>
            {offered.map((c) => (
              <option key={c} value={c}>{nameOf(c) ? `${c} · ${nameOf(c)}` : c}</option>
            ))}
          </select>
          <button className="btn ghost" disabled={!choice}
                  onClick={() => onFavourites([...favourites, choice])}>
            Add
          </button>
        </div>
        <label className="field" style={{ marginTop: 16 }}>
          <span className="eyebrow">Show totals in</span>
          <select className="inp" value={displayCurrency}
                  onChange={(e) => onDisplayCurrency(e.target.value)}>
            {shown.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value="earned">As earned</option>
          </select>
        </label>
        <div className="hint">
          Shared by every device that syncs. Without usable rates, totals stay as earned.
        </div>
      </div>

      <p className="fx-note">
        Rates are asked of {HOSTS[0]} (or {HOSTS[1]} if that is down). Nothing from your
        ledger is sent to it, only the request for the rates.
      </p>
      <p className="fx-note">
        Exchange rates from the free Currency API by fawazahmed0, public domain (CC0).
      </p>
    </section>
  );
}
