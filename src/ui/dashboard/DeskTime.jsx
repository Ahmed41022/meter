import { SplitBar } from "../charts.jsx";

/** Billed against idle time for the period. */
export default function DeskTime({ current, share }) {
  return (
    <div className="sec">
      <div className="sec-head"><span className="eyebrow">Time at the desk</span></div>
      <div className="panel">
        <SplitBar billedMs={current.billedMs} idleMs={current.idleMs} share={share} />
      </div>
    </div>
  );
}
