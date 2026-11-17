import { Notice } from "../parts.jsx";

/**
 * What to say when the stored ledger could not be read, and the ways out of
 * it. Held apart from App because it is the longest banner and only the
 * startup load decides whether it shows.
 */
export default function UnreadableBanner({
  unreadable, store, downloadUnreadable, setUnreadable, setOpenProjectId, setFocusSession, setTab,
}) {
  return (
    <Notice title="Your saved ledger couldn't be read">
      What was stored here is damaged or isn&apos;t a Meter ledger, so Meter has opened an
      empty one instead of guessing.{" "}
      {unreadable.keptAs
        ? <>The original is untouched, kept aside in this browser as “{unreadable.keptAs}”.</>
        : unreadable.downloaded
          ? <>The original is in the file you downloaded, so saving has started again.</>
          : <>There is no room to keep a copy of it here, so nothing will be saved over it
            until you download it.</>}
      {" "}<button className="linkish" onClick={downloadUnreadable}>Download it</button>
      {" "}to keep a copy you can repair, or{" "}
      <button className="linkish"
              onClick={() => { setOpenProjectId(null); setFocusSession(null); setTab("work"); }}>
        restore a backup
      </button>.
      {!store.held && (
        <>{" "}<button className="linkish" onClick={() => setUnreadable(null)}>Dismiss</button></>
      )}
    </Notice>
  );
}
