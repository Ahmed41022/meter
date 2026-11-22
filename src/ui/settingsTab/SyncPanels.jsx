import RelayPanel from "./relay/RelayPanel.jsx";

/**
 * What the Settings tab shows under "Sync & backup": Meter Sync, and Google
 * Drive beside it while Drive still exists.
 *
 * With no Meter Sync account on this device the Drive panel is exactly what it
 * has always been, and Meter Sync is offered above it. Once there is an account
 * the roles swap: Meter Sync leads, and Drive moves below under its own heading,
 * only if it was ever set up, because it is being phased out and a new user has
 * no reason to see it.
 */
export default function SyncPanels({ relay, intent, onIntentUsed, hasData, drive, driveConfigured }) {
  return (
    <>
      <RelayPanel relay={relay} intent={intent} onIntentUsed={onIntentUsed} hasData={hasData} />
      {relay.active ? (
        driveConfigured && (
          <div className="rl-drive">
            <h3 className="rl-h2">Google Drive (being replaced)</h3>
            <p className="sync-note">
              Now that this device has a Meter Sync account, Drive no longer syncs by itself here. It
              will be removed in a later update.
            </p>
            {drive}
          </div>
        )
      ) : drive}
    </>
  );
}
