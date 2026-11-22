/**
 * The strip above the views: the app's name, and either the way back out of an
 * open project or the tabs that choose between the screens.
 */
export default function TopBar({ project, tab, setTab, setOpenProjectId, setFocusSession }) {
  return (
    <div className="topbar print-hide">
      <span className="mark">Meter</span>
      {project
        ? <button className="linkbtn"
                  onClick={() => { setOpenProjectId(null); setFocusSession(null); }}>
            ← All projects
          </button>
        : <nav className="tabs" role="tablist" aria-label="Views">
            {[["today", "Today"], ["overview", "Overview"], ["payments", "Payments"], ["work", "Work"], ["life", "Life"], ["settings", "Settings"]].map(([key, label]) => (
              <button key={key} role="tab" aria-selected={tab === key}
                      className={"tab" + (tab === key ? " on" : "")}
                      onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </nav>}
    </div>
  );
}
