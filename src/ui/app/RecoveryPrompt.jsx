import { RecoveryBanner } from "../parts.jsx";
import { deleteSession, liveSessions, recoverSession } from "../../domain/sessions.js";

/**
 * Offers to close a meter left running by a crash, wiring the banner's three
 * answers to the ledger. The banner itself stays in parts.jsx; this holds what
 * answering it does.
 */
export default function RecoveryPrompt({ recovering, now, state, projects, commit, onAnswered }) {
  return (
    <RecoveryBanner
      session={recovering} now={now} sessions={liveSessions(state.sessions)}
      project={projects.find((p) => p.id === recovering.projectId)}
      onStopAtLastTick={() => { commit((s) => recoverSession(s, recovering.id)); onAnswered(); }}
      onKeepRunning={onAnswered}
      onDelete={() => { commit((s) => deleteSession(s, recovering.id, Date.now())); onAnswered(); }}
    />
  );
}
