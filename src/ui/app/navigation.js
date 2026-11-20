/**
 * Moving about: opening a project on the tab it belongs to, and taking the
 * reader to one named session. Both only set which screen is showing.
 */
export function navigation({ stateRef, setOpenProjectId, setFocusSession, setTab }) {
  /** Opening a project lands on the tab it belongs to, so the back link
   *  returns somewhere the project is actually listed. */
  const openProject = (id, session = null) => {
    const p = stateRef.current.projects.find((x) => x.id === id);
    setOpenProjectId(id);
    setFocusSession(session);
    setTab(p?.offClock ? "life" : "work");
  };

  /** Takes the reader to one named session, wherever it lives. A warning that
   *  says two records disagree is only actionable if it can hand them over. */
  const showSession = (id) => {
    const found = stateRef.current.sessions.find((x) => x.id === id);
    if (found) openProject(found.projectId, id);
  };

  /** Closes whatever project is open and shows the Settings tab: for a link
   *  that points out of a project to something that is not part of it. */
  const openSettings = () => {
    setOpenProjectId(null);
    setFocusSession(null);
    setTab("settings");
  };

  return { openProject, showSession, openSettings };
}
