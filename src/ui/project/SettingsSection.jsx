import { useState } from "react";
import Settings, { unsavedSettings } from "../Settings.jsx";

/**
 * The page's Settings block: the header that opens and closes the panel and
 * says when a draft is waiting, and the panel itself. Whether it is open is
 * this block's own business; nothing else on the page reads it.
 */
export default function SettingsSection({
  project, projects, onPatch, onSetTerms, onDeleteProject, onSetStatus, payPeriod, companies,
  onSetPayPeriod, now, running,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="sec">
      <div className="sec-head">
        <span className="eyebrow">
          Settings
          {/* A draft outlives the closed panel, so the closed panel says it
              is holding one. Nothing else on the page would. */}
          {!settingsOpen && unsavedSettings(project.id) && <span className="tag">Unsaved</span>}
        </span>
        <button className="linkbtn" onClick={() => setSettingsOpen((v) => !v)}>
          {settingsOpen ? "Close" : "Open"}
        </button>
      </div>
      {settingsOpen && (
        <Settings project={project} projects={projects} onPatch={onPatch} onSetTerms={onSetTerms}
                  onDeleteProject={onDeleteProject} onSetStatus={onSetStatus}
                  payPeriod={payPeriod} companies={companies}
                  onSetPayPeriod={onSetPayPeriod} now={now}
                  hasRunningSession={!!running} />
      )}
    </div>
  );
}
