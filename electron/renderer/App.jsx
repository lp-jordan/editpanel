function App() {
  const [project, setProject] = React.useState('');
  const [timeline, setTimeline] = React.useState('');
  const [log, setLog] = React.useState([]);
  const [connected, setConnected] = React.useState(false);
  const [consoleOpen, setConsoleOpen] = React.useState(false);
  const [currentCategory, setCurrentCategory] = React.useState(null);
  const [spellReport, setSpellReport] = React.useState([]);
  const [spellTotals, setSpellTotals] = React.useState({
    items: 0,
    words: 0,
    issues: 0,
    ignored: 0
  });
  const [spellHistory, setSpellHistory] = React.useState([]);

  const appendLog = msg => {
    setLog(prev => {
      const next = [...prev, msg];
      return next.slice(-20);
    });
  };

  React.useEffect(() => {
    if (!window.electronAPI) {
      return;
    }

    const unsubscribeStatus = window.electronAPI.onHelperStatus(status => {
      const msg = `Status: ${status.code}${status.error ? ' - ' + status.error : ''}`;
      appendLog(msg);
      if (status.code === 'CONNECTED' && status.ok) {
        setConnected(true);
        if (status.data) {
          if (status.data.project) {
            setProject(status.data.project);
          }
          if (status.data.timeline) {
            setTimeline(status.data.timeline);
          }
        }
      } else {
        setConnected(false);
        setProject('');
        setTimeline('');
      }
    });

    const unsubscribeMessage = window.electronAPI.onHelperMessage(payload => {
      const entry = typeof payload === 'string' ? payload : JSON.stringify(payload);
      appendLog(entry);
    });

    return () => {
      unsubscribeStatus && unsubscribeStatus();
      unsubscribeMessage && unsubscribeMessage();
    };
  }, []);

  const logAction = action => {
    appendLog(`${action} clicked`);
  };

  const cacheSpellcheck = () => {
    if (
      spellReport.length ||
      spellTotals.items ||
      spellTotals.words ||
      spellTotals.issues ||
      spellTotals.ignored
    ) {
      setSpellHistory(prev => [
        ...prev,
        { report: spellReport, totals: spellTotals, timestamp: Date.now() }
      ]);
      appendLog('Spellcheck report cached to history');
    }
    setSpellReport([]);
    setSpellTotals({ items: 0, words: 0, issues: 0, ignored: 0 });
  };

  const handleConnect = () => {
    cacheSpellcheck();
    if (!window.leaderpassAPI) {
      appendLog('Leaderpass API not available; cannot connect');
      return;
    }
    window.leaderpassAPI
      .call('connect')
      .then(() => appendLog('Connect success'))
      .catch(err => appendLog(`Connect error: ${err?.error || err}`));
  };

  const handleNewProjectBins = () => {
    cacheSpellcheck();
    appendLog('New Project Bins clicked');
    if (!window.leaderpassAPI) {
      appendLog('Leaderpass API not available; cannot create project bins');
      return;
    }
    window.leaderpassAPI
      .call('create_project_bins')
      .then(() => appendLog('Project bin creation command sent'))
      .catch(err => appendLog(`Project bin creation error: ${err?.error || err}`));
  };

  const handleLPBaseExport = () => {
    cacheSpellcheck();
    appendLog('LP Base Export clicked');
    if (!window.leaderpassAPI) {
      appendLog('Leaderpass API not available; cannot export LP Base');
      return;
    }
    window.leaderpassAPI
      .call('lp_base_export')
      .then(() => appendLog('LP Base Export command sent'))
      .catch(err =>
        appendLog(`LP Base Export error: ${err?.error || err}`)
      );
  };

  const handleSpellcheck = () => {
    cacheSpellcheck();
    appendLog('Spellcheck started');
    if (!window.leaderpassAPI) {
      appendLog('Leaderpass API not available; cannot run spellcheck');
      return;
    }
    const misspell = window.spellcheckAPI?.misspellings;
    if (!misspell) {
      appendLog('Spellcheck API not available; using fallback');
    }
    window.leaderpassAPI
      .call('spellcheck')
      .then(async res => {
        const items = (res.data && res.data.items) || [];
        const rows = [];
        let totalItems = 0;
        let totalWords = 0;
        let totalIssues = 0;
        let totalIgnored = 0;
        for (const entry of items) {
          const result = misspell
            ? await misspell(entry.text)
            : { words: entry.text.split(/\W+/).filter(Boolean).length, misspelled: [], ignored: 0 };
          totalItems += 1;
          totalWords += result.words;
          totalIssues += result.misspelled.length;
          totalIgnored += result.ignored;
          if (result.misspelled.length > 0) {
            rows.push({
              track: entry.track,
              tool: entry.tool,
              timecode: entry.timecode,
              text: entry.text,
              start_frame: entry.start_frame,
              tool_name: entry.tool_name,
              misspelled: result.misspelled
            });
          }
        }
        setSpellReport(rows);
        setSpellTotals({
          items: totalItems,
          words: totalWords,
          issues: totalIssues,
          ignored: totalIgnored
        });
        appendLog('Spellcheck complete');
      })
      .catch(err => appendLog(`Spellcheck error: ${err?.error || err}`));
  };

  const categories = ['SETUP', 'EDIT', 'AUDIO', 'DELIVER'];

  const actions = {
    SETUP: [
      { label: 'New Project Bins', icon: '🗂️', onClick: handleNewProjectBins }
    ],
    EDIT: [
      { label: 'Spellcheck', icon: '📝', onClick: handleSpellcheck }
    ],
    AUDIO: [],
    DELIVER: [
      { label: 'LP Base Export', icon: '📤', onClick: handleLPBaseExport }
    ]
  };

  return (
    <div className="app-container" style={{ paddingBottom: consoleOpen ? '240px' : '40px' }}>
      <header>{project || 'No Project'}</header>
      {connected ? (
        <>
          {currentCategory === null ? (
            <div className="function-grid folder-grid">
              {categories.map(cat => (
                <button
                  key={cat}
                  className="folder-button"
                  onClick={() => setCurrentCategory(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
          ) : (
            <div className="category-view">
              <button
                className="back-button"
                onClick={() => {
                  cacheSpellcheck();
                  setCurrentCategory(null);
                }}
              >
                Back
              </button>
              <div className="function-grid">
                {actions[currentCategory].map(action => (
                  <button
                    key={action.label}
                    className="task-button"
                    onClick={action.onClick}
                  >
                    <span className="icon">{action.icon}</span>
                    <span>{action.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="dashboard">
            <h2>Dashboard</h2>
            <div>Active Timeline: {timeline || 'None'}</div>
            <SpellcheckReport
              report={spellReport}
              totals={spellTotals}
              onLog={appendLog}
            />
          </div>
        </>
      ) : (
        <div className="connect-container">
          <button
            className="connect-button"
            onClick={handleConnect}
            disabled={!window.leaderpassAPI}
          >
            Connect
          </button>
        </div>
      )}
      <SlideoutConsole log={log} open={consoleOpen} onToggle={setConsoleOpen} />
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
