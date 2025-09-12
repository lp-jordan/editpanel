function SpellcheckReport({
  report,
  totals = { items: 0, words: 0, issues: 0, ignored: 0 },
  onLog = () => {}
}) {
  const [menu, setMenu] = React.useState({
    visible: false,
    x: 0,
    y: 0,
    suggestions: [],
    target: null,
    row: null
  });

  const handleContextMenu = async (e, row) => {
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
      target: e.target,
      row
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
    if (window.leaderpassAPI && menu.row) {
      const { track, start_frame, tool_name } = menu.row;
      window.leaderpassAPI
        .call('update_text', {
          track,
          start_frame,
          tool_name,
          text: suggestion
        })
        .catch(() => {});
    }
    setMenu(prev => ({ ...prev, visible: false }));
  };

  const jumpToTimecode = (row, word) => {
    const tc = row.timecode;
    onLog(`Misspelling "${word}" clicked at ${tc}`);
    if (!window.leaderpassAPI) {
      onLog('Leaderpass API not available; cannot navigate');
      return;
    }
    onLog(`Requesting playhead move to ${tc}`);
    window.leaderpassAPI
      .call('goto', { timecode: tc })
      .then(() => onLog(`Playhead moved to ${tc}`))
      .catch(err => onLog(`Goto error: ${err?.error || err}`));
  };

  const renderText = (row, text, misspelled) => {
    if (!misspelled || misspelled.length === 0) return text;
    const missSet = new Set(misspelled.map(w => w.toLowerCase()));
    return text.split(/(\W+)/).map((part, idx) => {
      if (/\w/.test(part) && missSet.has(part.toLowerCase())) {
        return (
          <span
            key={idx}
            className="misspelled"
            onContextMenu={e => handleContextMenu(e, row)}
            onClick={() => jumpToTimecode(row, part)}
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
                <td>{renderText(row, row.text, row.misspelled)}</td>
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
