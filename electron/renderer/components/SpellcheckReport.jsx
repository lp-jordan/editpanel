function SpellcheckReport({ report, totals = { items: 0, misspellings: 0 } }) {
  if (!report || report.length === 0) {
    return (
      <div className="spell-report">
        <h3>Spellcheck Report</h3>
        <div>No text found.</div>
      </div>
    );
  }

  let globalIdx = 0;
  return (
    <div className="spell-report">
      <h3>Spellcheck Report</h3>
      <div className="spell-summary">
        {totals.items} items scanned, {totals.misspellings} issues found
      </div>
      {report.map((group, gidx) => (
        <div key={gidx} className="spell-group">
          <div className="group-header">
            Track {group.track} | Clip: {group.clip}
          </div>
          {group.entries.map((row, idx) => {
            globalIdx += 1;
            return (
              <div
                key={idx}
                className={row.misspelled && row.misspelled.length ? 'misspelled' : ''}
              >
                <div>
                  [{String(globalIdx).padStart(3, '0')}] Comp: {row.comp} | Tool: {row.tool}
                </div>
                <div>Text: {row.text}</div>
                {row.misspelled && row.misspelled.length ? (
                  <div>Misspelled: {row.misspelled.join(', ')}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
