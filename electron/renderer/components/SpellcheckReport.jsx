function SpellcheckReport({
  report,
  totals = { items: 0, words: 0, issues: 0, ignored: 0 }
}) {
  const [menu, setMenu] = React.useState({
    visible: false,
    x: 0,
    y: 0,
    suggestions: [],
    target: null
  });

  const handleContextMenu = async e => {
    e.preventDefault();
    const word = e.target.textContent;
    let suggestions = [];
    try {
      suggestions =
        (await window.spellcheckAPI?.suggestions(word)) || [];
    } catch (err) {
      suggestions = [];
    }
    setMenu({
      visible: true,
      x: e.pageX,
      y: e.pageY,
      suggestions,
      target: e.target
    });
  };

  React.useEffect(() => {
    if (!menu.visible) return;
    const handleClick = e => {
      if (menu.target && !menu.target.contains(e.target)) {
        setMenu(prev => ({ ...prev, visible: false }));
      }
    };
    const handleKey = e => {
      if (e.key === 'Escape') {
        setMenu(prev => ({ ...prev, visible: false }));
      }
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menu.visible, menu.target]);

  const chooseSuggestion = suggestion => {
    if (menu.target) {
      menu.target.textContent = suggestion;
      menu.target.classList.remove('misspelled');
    }
    setMenu(prev => ({ ...prev, visible: false }));
  };

  const renderText = (text, misspelled) => {
    if (!misspelled || misspelled.length === 0) return text;
    const missSet = new Set(misspelled.map(w => w.toLowerCase()));
    return text.split(/(\W+)/).map((part, idx) => {
      if (/\w/.test(part) && missSet.has(part.toLowerCase())) {
        return (
          <span
            key={idx}
            className="misspelled"
            onContextMenu={handleContextMenu}
          >
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
      {menu.visible && (
        <ul
          className="suggestion-menu"
          style={{ top: menu.y, left: menu.x }}
        >
          {menu.suggestions.length ? (
            menu.suggestions.map(s => (
              <li key={s} onClick={() => chooseSuggestion(s)}>
                {s}
              </li>
            ))
          ) : (
            <li className="no-suggestion">No suggestions</li>
          )}
        </ul>
      )}
    </div>
  );
}
