function SpellcheckReport({ report }) {
  if (!report || report.length === 0) {
    return (
      <div className="spell-report">
        <h3>Spellcheck Report</h3>
        <div>No text found.</div>
      </div>
    );
  }

  return (
    <div className="spell-report">
      <h3>Spellcheck Report</h3>
      {report.map((row, idx) => (
        <div
          key={idx}
          className={row.misspelled && row.misspelled.length ? 'misspelled' : ''}
        >
          <div>
            [{String(idx + 1).padStart(3, '0')}] Track {row.track} | Clip: {row.clip} | Comp: {row.comp} | Tool: {row.tool}
          </div>
          <div>Text: {row.text}</div>
          {row.misspelled && row.misspelled.length ? (
            <div>Misspelled: {row.misspelled.join(', ')}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
