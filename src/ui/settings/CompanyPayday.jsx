import { companiesIn, isOffClock } from "../../domain/projects.js";
import { paysOnAcceptance } from "../../domain/earnings.js";
import { describePeriod } from "../../domain/payPeriod.js";
import PayScheduleFields from "./PayScheduleFields.jsx";

/**
 * The client half of the panel: which company a project is for and when that
 * company pays. The payday is the company's, not the project's, so this is
 * kept as one piece with the company box that decides whose schedule it is.
 */
export default function CompanyPayday({
  project, projects, company, setCompany, onKey, target, clash, theirName, theirs, useTheirs,
  period, setPeriod, rule, now, onOpenSettings,
}) {
  return (
    <>
      {/* Off the clock has no client. A company on sleep would be a category
          error, and it would then turn up in the revenue breakdown. */}
      {!isOffClock(project) && (
        <>
          <label className="field">
            <span className="eyebrow">Company</span>
            <input className="inp" value={company} list="meter-companies"
                   placeholder="who it's for — optional" onKeyDown={onKey}
                   onChange={(e) => setCompany(e.target.value)} />
          </label>
          {/* Suggestions from what you have already typed: the list is what
              stops "Northwind" and "northwind" becoming two clients. */}
          <datalist id="meter-companies">
            {companiesIn(projects).map((c) => <option key={c} value={c} />)}
          </datalist>
          <div className="hint">
            Projects sharing a company are totalled together on the Overview — what each
            one earned, the hours, and what an hour actually came to across all of them.
          </div>

          <div className="sec-head" style={{ marginTop: 22 }}>
            <span className="eyebrow">Payday</span>
            {target && <span className="eyebrow">{target}</span>}
          </div>
          {!target ? (
            <div className="hint" style={{ marginTop: 0 }}>
              A payday belongs to the client, not to one project, so name the company above
              — then its schedule can be set here and every project under it will use the
              same one.
            </div>
          ) : (
            <>
              {/* Said before Save, because the schedule is shared: saving
                  would change the paydays of every project under that
                  company, not only this one. */}
              {clash && (
                <div className="hint warn" style={{ marginTop: 0 }}>
                  {theirName} already has a payday of its own:{" "}
                  <strong>{describePeriod(theirs)}</strong> It is shared by every {theirName}{" "}
                  project, so saving puts the schedule below in its place for all of them.{" "}
                  <button className="linkish" onClick={useTheirs}>
                    Use {theirName}&apos;s instead
                  </button>
                </div>
              )}
              <PayScheduleFields period={period} setPeriod={setPeriod} rule={rule} now={now}
                                 target={target} onKey={onKey}
                                 paysOnAcceptance={paysOnAcceptance(project)} />
            </>
          )}
          {/* Where all of them are side by side. Only where there is a way to
              get there: the panel is also rendered without one. */}
          {onOpenSettings && (
            <div className="hint">
              Every client&apos;s payday is also listed in{" "}
              <button className="linkish" onClick={onOpenSettings}>Settings</button>.
            </div>
          )}
        </>
      )}
    </>
  );
}
