import { keepDraft } from "./drafts.js";

/**
 * Deleting a project, behind a second click. It also lets go of any kept
 * draft first, so a deleted project does not leave the window asking about
 * settings nobody can save.
 */
export default function Danger({ project, confirming, setConfirming, onDeleteProject }) {
  return (
    <>
      <div className="sec-head" style={{ marginTop: 22 }}>
        <span className="eyebrow">Danger</span>
      </div>
      {confirming ? (
        <>
          <div className="hint">
            This removes {project.name} and every session recorded against it. You&apos;ll get one chance to undo.
          </div>
          <div className="controls">
            <button className="btn danger" onClick={() => { keepDraft(project.id, null); onDeleteProject(); }}>
              Yes, delete it
            </button>
            <button className="btn ghost" onClick={() => setConfirming(false)}>Keep it</button>
          </div>
        </>
      ) : (
        <div className="controls">
          <button className="btn danger" onClick={() => setConfirming(true)}>Delete project</button>
        </div>
      )}
    </>
  );
}
