function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightText(text, misspelled) {
  if (!misspelled || misspelled.length === 0) {
    return text;
  }
  let highlighted = text;
  misspelled.forEach(word => {
    const regex = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'g');
    highlighted = highlighted.replace(
      regex,
      `<span class="misspelled-word">${word}</span>`
    );
  });
  return highlighted;
}

function SpellcheckReport({ report }) {
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
                <div
                  dangerouslySetInnerHTML={{
                    __html: 'Text: ' + highlightText(row.text, row.misspelled)
                  }}
                />
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
