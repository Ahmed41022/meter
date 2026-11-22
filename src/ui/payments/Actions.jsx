/**
 * Print and Export CSV for the view above them. Both are hidden when printing:
 * a button on paper is only noise.
 */
export default function Actions({ onPrint, onCsv, disabled, printLabel }) {
  return (
    <div className="stmt-actions print-hide">
      <button type="button" className="btn ghost" disabled={disabled} onClick={onPrint}>
        {printLabel}
      </button>
      <button type="button" className="btn ghost" disabled={disabled} onClick={onCsv}>
        Export CSV
      </button>
    </div>
  );
}
