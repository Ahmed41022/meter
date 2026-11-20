/**
 * The "Sort" row above a list: one button per order, the one in force marked,
 * and a second click on it turning it round. Quiet until used, because the
 * sort is a tool you reach for rather than a figure to read.
 *
 * Controlled: the list owns `order` and `desc`, because what a pick means (and
 * how long it lasts) is the list's business. `onChange(order, desc)` is called
 * with the new pair; picking a different order opens it in that order's own
 * natural direction, given by `opensDesc`.
 */
export default function SortBar({
  label, orders, order, desc, onChange, opensDesc = () => true,
}) {
  return (
    <div className="sortbar" role="group" aria-label={label}>
      <span className="eyebrow">Sort</span>
      {orders.map(([key, text]) => (
        <button key={key} className={"sortbtn" + (order === key ? " on" : "")}
                aria-pressed={order === key}
                onClick={() => (order === key ? onChange(key, !desc) : onChange(key, opensDesc(key)))}>
          {text}
          {order === key && <span aria-hidden="true">{desc ? " ↓" : " ↑"}</span>}
        </button>
      ))}
    </div>
  );
}
