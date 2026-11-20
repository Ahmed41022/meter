import {
  PERIOD, WEEKDAYS, describePeriod, knownZone, nextClose, paydayFor,
} from "../../domain/payPeriod.js";
import { HERE, QUOTED_ZONES, ZONES } from "./zones.js";

/**
 * The schedule controls themselves: how a client pays, the boxes for each
 * kind, the cutoff's time and clock, and the schedule read back in words.
 * Shared by the project's Settings panel and by the Companies list in the
 * Settings tab, so a schedule is edited the same way wherever it is edited.
 *
 * `paysOnAcceptance` is the one thing that depends on a project: whether work
 * is paid once accepted (true) or as handed in (false). `null` means there is
 * no project in front of the reader, only a client whose projects may pay
 * either way, and the read-back then says only what does not depend on it.
 */
export default function PayScheduleFields({
  period, setPeriod, rule, now, target, onKey, paysOnAcceptance,
}) {
  const example = describePeriod(rule);
  // A date on the rule's own clock, printed as that date. Converted through
  // this device's clock, a payday in a zone east of here read a day early.
  const nextOne = rule ? paydayFor(rule, now) : null;
  /**
   * The cutoff instant on this device's clock, where that is worth saying.
   *
   * Only when another zone is named and it is not this one: "19:00 your time
   * is 19:00 your time" is noise, and the whole point of printing it is the
   * cases where seven in the evening is two in the morning. Never for a zone
   * this browser cannot read, whose hour it has no way to convert.
   */
  const zoneUnknown = period.zone !== "" && knownZone(period.zone) === null;
  const closesHere = period.zone && period.zone !== HERE && !zoneUnknown
    ? nextClose(rule, now) : null;

  const nextDay = nextOne === null ? null
    : new Date(`${nextOne.date}T00:00:00Z`).toLocaleDateString(undefined, {
      timeZone: "UTC", weekday: "long", day: "numeric", month: "long",
    });

  return (
    <>
      <div className="modes" role="tablist" aria-label="How this client pays">
        {[["none", "No schedule"], [PERIOD.WEEKLY, "Weekly"], [PERIOD.MONTHLY, "Monthly"]]
          .map(([key, label]) => (
            <button key={key} role="tab" aria-selected={period.kind === key}
                    className={"seg-btn" + (period.kind === key ? " on" : "")}
                    onClick={() => setPeriod({ kind: key })}>
              {label}
            </button>
          ))}
      </div>

      {period.kind === PERIOD.WEEKLY && (
        <div className="pair" style={{ marginTop: 14 }}>
          <label className="field">
            <span className="eyebrow">Work in before</span>
            <select className="inp" value={period.weeklyCutoff}
                    onChange={(e) => setPeriod({ weeklyCutoff: Number(e.target.value) })}>
              {WEEKDAYS.map(([n, label]) => <option key={n} value={n}>{label}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="eyebrow">Is paid on</span>
            <select className="inp" value={period.weeklyPayday}
                    onChange={(e) => setPeriod({ weeklyPayday: Number(e.target.value) })}>
              {WEEKDAYS.map(([n, label]) => <option key={n} value={n}>{label}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="eyebrow">Which one</span>
            <select className="inp" value={period.after}
                    onChange={(e) => setPeriod({ after: Number(e.target.value) })}>
              <option value={0}>The following one</option>
              <option value={1}>A week after that</option>
              <option value={2}>Two weeks after that</option>
            </select>
          </label>
        </div>
      )}

      {period.kind === PERIOD.MONTHLY && (
        <div className="pair" style={{ marginTop: 14 }}>
          <label className="field">
            <span className="eyebrow">Work in before the</span>
            <input className="inp" type="number" min="1" max="31" step="1"
                   value={period.monthlyCutoff} onKeyDown={onKey}
                   onChange={(e) => setPeriod({ monthlyCutoff: e.target.value })} />
          </label>
          <label className="field">
            <span className="eyebrow">Is paid on the</span>
            <input className="inp" type="number" min="1" max="31" step="1"
                   value={period.monthlyPayday} onKeyDown={onKey}
                   onChange={(e) => setPeriod({ monthlyPayday: e.target.value })} />
          </label>
          <label className="field">
            <span className="eyebrow">Which one</span>
            <select className="inp" value={period.after}
                    onChange={(e) => setPeriod({ after: Number(e.target.value) })}>
              <option value={0}>The next one</option>
              <option value={1}>A month after that</option>
              <option value={2}>Two months after that</option>
            </select>
          </label>
        </div>
      )}

      {/* When in the day the period shuts, and on whose clock.
          Shared by both kinds, because both have the same problem:
          "closes Sunday 7pm Eastern" is an instant, and read on the
          wrong clock it is hours out — which for a cutoff is not
          hours, it is a whole payday. */}
      {period.kind !== "none" && (
        <div className="pair" style={{ marginTop: 14 }}>
          <label className="field">
            <span className="eyebrow">Closing at</span>
            <input className="inp" type="time" value={period.closesAt}
                   onChange={(e) => setPeriod({ closesAt: e.target.value })} />
          </label>
          <label className="field">
            <span className="eyebrow">By which clock</span>
            <select className="inp" value={period.zone}
                    onChange={(e) => setPeriod({ zone: e.target.value })}>
              <option value="">Mine{HERE ? ` — ${HERE}` : ""}</option>
              {/* The zone saved, where neither list has it: without
                  an option of its own the box would show "Mine" and
                  the next Save would erase it. */}
              {period.zone && !QUOTED_ZONES.includes(period.zone)
                && !ZONES.includes(period.zone) && (
                <option value={period.zone}>
                  {zoneUnknown ? `${period.zone} (not known here)` : period.zone}
                </option>
              )}
              <optgroup label="Commonly quoted">
                {QUOTED_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </optgroup>
              <optgroup label="Everywhere else">
                {ZONES.filter((z) => !QUOTED_ZONES.includes(z))
                  .map((z) => <option key={z} value={z}>{z}</option>)}
              </optgroup>
            </select>
          </label>
        </div>
      )}
      {/* Kept, not dropped: it is still the client's clock, and the
          device that set it may know it. Saying so is the difference
          between a payday an hour out and one nobody can explain. */}
      {period.kind !== "none" && zoneUnknown && (
        <div className="hint warn">
          {period.zone} isn&apos;t known to this browser, so paydays are worked out on
          this device&apos;s clock until it is. It stays saved as it is unless you pick
          another clock.
        </div>
      )}

      {/* Read back in words, with a real date against it. A schedule
          you cannot check is a schedule you cannot tell you have set
          up backwards, and the two weekday boxes are easy to swap. */}
      <div className="hint">
        {example ? (
          <>
            <strong>{example}</strong>{" "}
            {/* Dated as Upcoming payments dates it: by the ANSWER where
                this project pays once accepted, by the hand-in where it
                pays as worked and nothing waits on an answer. */}
            {nextOne !== null && (
              paysOnAcceptance === null
                // A client's schedule seen on its own, with no project to say which
                // way its projects pay: the date alone, which is the same for all.
                ? <>The next payday on this schedule is <strong>{nextDay}</strong>.{" "}</>
                : <>{paysOnAcceptance ? "A task accepted" : "Work handed in"} right
                  now would be paid on{" "}
                  <strong>{nextDay}</strong>.{" "}</>
            )}
            {paysOnAcceptance === null ? null : paysOnAcceptance
              ? "This project pays once accepted, so a task is paid in the run for the "
                + "period its answer fell in, hours and acceptance reward together — one "
                + "accepted after its own period shut rides the next run. Work nobody has "
                + "reviewed yet has no date at all, only the soonest it could arrive."
              : "This project pays as worked, so a task is paid in the run for the "
                + "period it was handed in, answered or not. A rejection takes it back."}
            {closesHere !== null && (
              <>
                {" "}The cutoff is read in {period.zone}, so the period you are in
                now shuts at{" "}
                <strong>{new Date(closesHere).toLocaleString(undefined, {
                  weekday: "long", hour: "2-digit", minute: "2-digit",
                })}</strong>{" "}
                your time — that instant, not the hour you typed.
              </>
            )}
          </>
        ) : (
          <>
            No schedule, so nothing is forecast for {target}. Set one and the Overview
            will say what lands and when.
          </>
        )}
      </div>
    </>
  );
}
