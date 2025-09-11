function SpellcheckReport({
  report,
  totals = { items: 0, words: 0, issues: 0, ignored: 0 }
}) {

  const renderText = (text, misspelled) => {
    if (!misspelled || misspelled.length === 0) return text;
    const missSet = new Set(misspelled.map(w => w.toLowerCase()));
    return text.split(/(\W+)/).map((part, idx) => {
      if (/\w/.test(part) && missSet.has(part.toLowerCase())) {
        return (
          <span key={idx} className="misspelled">
            {part}
          </span>
        );
      }
      return part;
    });
  };

  return (
    <div className="spell-report">
      <h3>Spellcheck Report</h3>
      {report && report.length ? (
        <table>
          <thead>
            <tr>
              <th>Track</th>
              <th>Tool</th>
              <th>Timecode</th>
              <th>Text</th>
            </tr>
          </thead>
          <tbody>
            {report.map((row, idx) => (
              <tr key={idx}>
                <td>{row.track}</td>
                <td>{row.tool}</td>
                <td>{row.timecode}</td>
                <td>{renderText(row.text, row.misspelled)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div>No issues found.</div>
      )}
      <div className="spell-summary">
        <div>Total text items scanned: {totals.items}</div>
        <div>Total words scanned: {totals.words}</div>
        <div>Issues found: {totals.issues}</div>
        <div>Dictionary hits ignored: {totals.ignored}</div>
      </div>
    </div>
  );
}
