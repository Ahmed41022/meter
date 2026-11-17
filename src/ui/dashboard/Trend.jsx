import { TrendChart } from "../charts.jsx";

/** The chart of the period, bucket by bucket. */
export default function Trend({ trend, period, earned, offset }) {
  return (
    <div className="sec">
      <div className="sec-head"><span className="eyebrow">Trend</span></div>
      <div className="panel">
        <TrendChart trend={trend} period={period} currencies={earned.map(([cur]) => cur)}
                    emptyNote={offset === 0 ? "Nothing recorded yet." : "Nothing recorded in this period."} />
      </div>
    </div>
  );
}
