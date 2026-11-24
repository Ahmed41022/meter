const NOTES = "https://github.com/Ahmed41022/meter/releases/tag/v";

/**
 * What an update brought, said once when it arrives and again whenever the
 * version at the foot of the page is pressed. Not a dialog: an update lands
 * whenever it lands, and nothing about it is worth standing between somebody
 * and the meter.
 */
export default function WhatsNew({ releases, onClose }) {
  if (releases.length === 0) return null;
  return (
    <section className="whatsnew print-hide" role="status" aria-label="What's new">
      <div className="whatsnew-head">
        <span className="eyebrow">What&apos;s new</span>
        <button className="x" aria-label="Close what's new" onClick={onClose}>×</button>
      </div>
      {releases.map((r) => (
        <div className="whatsnew-release" key={r.version}>
          <p className="whatsnew-title">Meter {r.version}</p>
          <ul>
            {r.news.map(([title, text]) => <li key={title}><strong>{title}.</strong> {text}</li>)}
          </ul>
          <a className="linkish" href={`${NOTES}${r.version}`} target="_blank" rel="noopener noreferrer">
            Everything in {r.version}
          </a>
        </div>
      ))}
      <div className="controls">
        <button className="btn primary" onClick={onClose}>Got it</button>
      </div>
    </section>
  );
}
