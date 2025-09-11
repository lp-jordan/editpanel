function SpellcheckReport({ report, totals = { items: 0, misspellings: 0 } }) {
  if (!report || report.length === 0) {
    return (
      <div className="spell-report">
        <h3>Spellcheck Report</h3>
        <div>No text found.</div>
      </div>
    );
  }

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
      <table>
        <thead>
          <tr>
            <th>Track</th>
            <th>Clip</th>
            <th>Comp</th>
            <th>Tool</th>
            <th>Text</th>
            <th>Misspelled</th>
          </tr>
        </thead>
        <tbody>
          {report.map((group, gidx) =>
            group.entries.map((row, idx) => (
              <tr key={`${gidx}-${idx}`}>
                <td>{group.track}</td>
                <td>{group.clip}</td>
                <td>{row.comp}</td>
                <td>{row.tool}</td>
                <td>{renderText(row.text, row.misspelled)}</td>
                <td>{row.misspelled && row.misspelled.length ? row.misspelled.join(', ') : ''}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
