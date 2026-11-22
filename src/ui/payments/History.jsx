import { useState } from "react";
import { dayKey } from "../../domain/objectives.js";
import {
  packChoice, statementLabel, statementRange, unpackChoice,
} from "../../domain/statementPeriod.js";
import { SETTING, loadSetting, saveSetting } from "../../storage/settings.js";
import { downloadCsv, stamp } from "../app/backup.js";
import ByCompany from "./ByCompany.jsx";
import ByPayday from "./ByPayday.jsx";
import PeriodFilter from "./PeriodFilter.jsx";

/**
 * What has been paid, past and answered: by payday or by company, over a span
 * that is remembered on this device. The span, which payday is open and which
 * company is picked are all this view's own, because nothing outside needs
 * them. Only the interactive part is marked print-hide; the statement sheet
 * inside each view is what a print shows instead.
 */
export default function History({ history, pay, now }) {
  const [view, setView] = useState("payday");
  const [{ key, custom }, setPeriod] = useState(() => unpackChoice(loadSetting(SETTING.STATEMENT_PERIOD)));
  const [open, setOpen] = useState(() => new Set());
  const [picked, setPicked] = useState(null);

  const remember = (nextKey, nextCustom) => {
    setPeriod({ key: nextKey, custom: nextCustom });
    saveSetting(SETTING.STATEMENT_PERIOD, packChoice(nextKey, nextCustom));
  };
  const toggle = (rowKey) => setOpen((cur) => {
    const next = new Set(cur);
    if (!next.delete(rowKey)) next.add(rowKey);
    return next;
  });

  const range = statementRange(key, dayKey(now), custom);
  const label = statementLabel(key, range);

  // The companies that have anything in the history or coming, by their own name; the
  // one picked is kept only while it is still one of them.
  const companies = [...new Map([...history, ...(pay?.due ?? [])].map((r) => [r.client, r.company])).entries()]
    .map(([client, company]) => ({ client, company }))
    .sort((a, b) => a.company.localeCompare(b.company));
  const client = companies.some((c) => c.client === picked) ? picked : companies[0]?.client ?? "";

  // The file name says what it holds; the contents are the view's own rows.
  const onCsv = (name, text) => downloadCsv(`${stamp()}-${name}.csv`, text);

  return (
    <div className="sec">
      <div className="sec-head print-hide">
        <span className="eyebrow">History</span>
      </div>
      <div className="print-hide">
        <div className="segmented" role="tablist" aria-label="History view">
          {[["payday", "By payday"], ["company", "By company"]].map(([k, text]) => (
            <button key={k} type="button" role="tab" aria-selected={view === k}
                    className={"seg" + (view === k ? " on" : "")} onClick={() => setView(k)}>
              {text}
            </button>
          ))}
        </div>
        <PeriodFilter choice={key} custom={custom} onChoose={(k) => remember(k, custom)}
                      onCustom={(c) => remember(key, c)} />
      </div>
      {view === "payday" ? (
        <ByPayday history={history} pay={pay} range={range} label={label} open={open} toggle={toggle}
                  now={now} onCsv={onCsv} />
      ) : (
        <ByCompany history={history} pay={pay} companies={companies} client={client} onClient={setPicked}
                   range={range} label={label} open={open} toggle={toggle} now={now} onCsv={onCsv} />
      )}
    </div>
  );
}
