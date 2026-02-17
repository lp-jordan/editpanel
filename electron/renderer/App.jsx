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
  const [transcribeFolderPath, setTranscribeFolderPath] = React.useState('');
  const [transcribeBusy, setTranscribeBusy] = React.useState(false);
  const [transcribeProgress, setTranscribeProgress] = React.useState([]);
  const [transcribeSummary, setTranscribeSummary] = React.useState(null);

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


  const handleTranscribe = async () => {
    cacheSpellcheck();

    if (!window.electronAPI?.transcribeFolder) {
      appendLog('Transcribe API not available; cannot transcribe folder');
      setTranscribeSummary({
        success: false,
        message: 'Transcribe API not available in preload.',
        failures: []
      });
      return;
    }

    if (!window.dialogAPI?.pickFolder) {
      appendLog('Folder picker API not available; cannot pick folder');
      setTranscribeSummary({
        success: false,
        message: 'Folder picker API not available in preload.',
        failures: []
      });
      return;
    }

    const selection = await window.dialogAPI.pickFolder();
    if (selection?.canceled || !selection?.folderPath) {
      appendLog('Transcribe canceled: no folder selected');
      return;
    }

    const folderPath = selection.folderPath;
    setTranscribeFolderPath(folderPath);

    setTranscribeBusy(true);
    setTranscribeSummary(null);
    setTranscribeProgress([`Transcription started for ${folderPath}`]);
    appendLog(`Transcribe started: ${folderPath}`);

    try {
      const result = await window.electronAPI.transcribeFolder(folderPath);
      const outputs = Array.isArray(result?.data?.outputs)
        ? result.data.outputs
        : Array.isArray(result?.outputs)
          ? result.outputs
          : Array.isArray(result?.data?.files)
            ? result.data.files
            : Array.isArray(result?.files)
              ? result.files
              : [];
      const failures = Array.isArray(result?.data?.failures)
        ? result.data.failures
        : Array.isArray(result?.failures)
          ? result.failures
          : outputs.filter(file => file && (file.error || file.ok === false));
      const completed = typeof result?.data?.files_processed === 'number'
        ? result.data.files_processed
        : typeof result?.data?.completed === 'number'
          ? result.data.completed
          : outputs.length - failures.length;

      const message = `Transcription complete: ${completed} succeeded, ${failures.length} failed`;
      setTranscribeProgress(prev => [...prev, message]);
      setTranscribeSummary({
        success: true,
        message,
        failures
      });
      appendLog(message);

      outputs.forEach(entry => {
        const sourceName = entry?.file || 'unknown source';
        const textOutput = entry?.text_output;
        const paths = Array.isArray(entry?.output_paths)
          ? entry.output_paths
          : [entry?.output].filter(Boolean);
        if (textOutput) {
          appendLog(`Transcript txt for ${sourceName}: ${textOutput}`);
        }
        paths.forEach(pathValue => {
          appendLog(`Transcribe output for ${sourceName}: ${pathValue}`);
        });
      });

      failures.forEach(failure => {
        const name = failure?.file || failure?.path || 'unknown file';
        const error = failure?.error || failure?.reason || 'unknown error';
        appendLog(`Transcribe failure (${name}): ${error}`);
      });
    } catch (err) {
      const errorMsg = err?.error || err?.message || String(err);
      appendLog(`Transcribe error: ${errorMsg}`);
      setTranscribeProgress(prev => [...prev, `Transcription failed: ${errorMsg}`]);
      setTranscribeSummary({
        success: false,
        message: `Transcription failed: ${errorMsg}`,
        failures: []
      });
    } finally {
      setTranscribeBusy(false);
    }
  };

  const categories = ['SETUP', 'EDIT', 'AUDIO', 'DELIVER'];

  const actions = {
    SETUP: [
      { label: 'New Project Bins', icon: '🗂️', onClick: handleNewProjectBins }
    ],
    EDIT: [
      { label: 'Spellcheck', icon: '📝', onClick: handleSpellcheck }
    ],
    AUDIO: [
      { label: 'Transcribe Folder', icon: '🎙️', onClick: handleTranscribe }
    ],
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
                    disabled={action.label === 'Transcribe Folder' && transcribeBusy}
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
            <div className="transcribe-panel">
              <h3>Transcribe</h3>
              <input
                type="text"
                placeholder="Folder path for audio files"
                value={transcribeFolderPath}
                onChange={event => setTranscribeFolderPath(event.target.value)}
                disabled={transcribeBusy}
              />
              <div>
                <button onClick={handleTranscribe} disabled={transcribeBusy}>
                  {transcribeBusy ? 'Transcribing…' : 'Run Transcribe Folder'}
                </button>
              </div>
              {transcribeProgress.length > 0 ? (
                <ul>
                  {transcribeProgress.map((line, index) => (
                    <li key={`${line}-${index}`}>{line}</li>
                  ))}
                </ul>
              ) : null}
              {transcribeSummary ? (
                <div>
                  <strong>{transcribeSummary.message}</strong>
                  {transcribeSummary.failures.length > 0 ? (
                    <ul>
                      {transcribeSummary.failures.map((failure, index) => {
                        const name = failure?.file || failure?.path || `file ${index + 1}`;
                        const error = failure?.error || failure?.reason || 'unknown error';
                        return <li key={`${name}-${index}`}>{name}: {error}</li>;
                      })}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
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
