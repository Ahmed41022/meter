import { Notice } from "../parts.jsx";

/**
 * The warning for a write that did not reach storage, which unlike the
 * volatile notice can appear and clear during a session.
 */
export default function SaveFailedNotice() {
  return (
    <Notice title="Not saving">
      Changes aren&apos;t reaching storage, so this session won&apos;t survive a reload. Export a backup
      before you close the tab.
    </Notice>
  );
}
