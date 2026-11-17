/**
 * Today's objectives across every project, so what is left to do is visible
 * from the Overview whichever period is on screen.
 */
export default function TodayFocus({ focus, finished, onToggleObjective, onOpenProject, nameOf }) {
  return (
    <div className="sec" style={{ marginTop: 0, marginBottom: 26 }}>
      <div className="sec-head">
        <span className="eyebrow">Today</span>
        <span className="eyebrow">
          {finished.length > 0 && `${finished.length} done`}
          {finished.length > 0 && focus.length > 0 && " · "}
          {focus.length > 0 && `${focus.length} left`}
        </span>
      </div>
      <div className="panel">
        {focus.length === 0 ? (
          <div className="empty">Everything you picked for today is done.</div>
        ) : focus.map((o) => (
          <div className="obj" key={o.id}>
            <label className="obj-check">
              <input type="checkbox" checked={false}
                     onChange={() => onToggleObjective(o.id)}
                     aria-label={`Mark ${o.text} done`} />
              <span className="obj-text">{o.text}</span>
            </label>
            <div className="obj-meta">
              <button className="linkish" onClick={() => onOpenProject(o.projectId)}>
                {nameOf(o.projectId)}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
