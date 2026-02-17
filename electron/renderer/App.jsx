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
  const [gpuEnabled, setGpuEnabled] = React.useState(() => window.localStorage.getItem('transcribe.gpuEnabled') === 'true');
  const [transcribeStatus, setTranscribeStatus] = React.useState({
    total: 0,
    completed: 0,
    failed: 0,
    currentFile: ''
  });

  const appendTranscribeProgress = React.useCallback(message => {
    setTranscribeProgress(prev => [...prev, message].slice(-200));
  }, []);

  const parseTranscribeProgress = React.useCallback(entry => {
    const queuedMatch = entry.match(/Transcribe: queued (\d+) file\(s\)/);
    if (queuedMatch) {
      const total = Number(queuedMatch[1]) || 0;
      setTranscribeStatus(prev => ({ ...prev, total }));
      return;
    }

    const processingMatch = entry.match(/Transcribe: \[(\d+)\/(\d+)\] processing (.+)$/);
    if (processingMatch) {
      const total = Number(processingMatch[2]) || 0;
      setTranscribeStatus(prev => ({
        ...prev,
        total,
        currentFile: processingMatch[3]
      }));
      return;
    }

    const doneMatch = entry.match(/Transcribe: done /);
    if (doneMatch) {
      setTranscribeStatus(prev => ({ ...prev, completed: prev.completed + 1 }));
      return;
    }

    const failedMatch = entry.match(/Transcribe: failed /);
    if (failedMatch) {
      setTranscribeStatus(prev => ({ ...prev, failed: prev.failed + 1 }));
      return;
    }
  }, []);

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
      if (entry.includes('Transcribe:')) {
        appendTranscribeProgress(entry);
        parseTranscribeProgress(entry);
      }
    });

    return () => {
      unsubscribeStatus && unsubscribeStatus();
      unsubscribeMessage && unsubscribeMessage();
    };
  }, []);


  React.useEffect(() => {
    window.localStorage.setItem('transcribe.gpuEnabled', gpuEnabled ? 'true' : 'false');
  }, [gpuEnabled]);
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
    if (transcribeBusy) {
      appendLog('Transcribe already running; ignoring duplicate request');
      return;
    }

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
    setTranscribeStatus({ total: 0, completed: 0, failed: 0, currentFile: '' });
    setTranscribeProgress([`Transcription started for ${folderPath}`]);
    appendLog(`Transcribe started: ${folderPath}`);

    try {
      const result = await window.electronAPI.transcribeFolder(folderPath, { useGpu: gpuEnabled });
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
      const total = typeof result?.data?.files_processed === 'number'
        ? result.data.files_processed + failures.length
        : outputs.length + failures.length;

      const message = `Transcription complete: ${completed}/${total} succeeded, ${failures.length} failed`;
      appendTranscribeProgress(message);
      setTranscribeSummary({
        success: true,
        completed,
        total,
        failed: failures.length,
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
      appendTranscribeProgress(`Transcription failed: ${errorMsg}`);
      setTranscribeSummary({
        success: false,
        message: `Transcription failed: ${errorMsg}`,
        failures: []
      });
    } finally {
      setTranscribeBusy(false);
    }
  };

  const handleCancelTranscribe = async () => {
    if (!transcribeBusy) {
      return;
    }
    if (!window.electronAPI?.cancelTranscribe) {
      appendLog('Cancel API not available; cannot cancel transcription');
      return;
    }
    try {
      const result = await window.electronAPI.cancelTranscribe();
      const message = result?.message || 'Transcription canceled';
      appendLog(message);
      appendTranscribeProgress(`Transcribe: ${message}`);
    } catch (err) {
      appendLog(`Cancel transcription error: ${err?.error || err?.message || err}`);
    }
  };


  const handleTestGpu = async () => {
    if (!window.electronAPI?.testGpu) {
      appendLog('GPU test API not available');
      return;
    }
    appendLog('Testing CUDA/GPU initialization...');
    try {
      const result = await window.electronAPI.testGpu();
      const data = result?.data || result;
      if (data?.ok) {
        setGpuEnabled(true);
        appendLog('GPU test passed. GPU acceleration enabled.');
      } else {
        const reason = data?.reason || 'unknown CUDA initialization error';
        setGpuEnabled(false);
        appendLog(`GPU test failed: ${reason}`);
      }
    } catch (err) {
      setGpuEnabled(false);
      appendLog(`GPU test error: ${err?.error || err?.message || err}`);
    }
  };

  const categories = ['SETUP', 'EDIT', 'AUDIO', 'DELIVER'];

  const actions = {
    SETUP: [
      { label: 'New Project Bins', icon: '🗂️', onClick: handleNewProjectBins, resolveRequired: true }
    ],
    EDIT: [
      { label: 'Spellcheck', icon: '📝', onClick: handleSpellcheck, resolveRequired: true }
    ],
    AUDIO: [
      { label: 'Transcribe Folder', icon: '🎙️', onClick: handleTranscribe }
    ],
    DELIVER: [
      { label: 'LP Base Export', icon: '📤', onClick: handleLPBaseExport, resolveRequired: true }
    ]
  };

  return (
    <div className="app-container" style={{ paddingBottom: consoleOpen ? '240px' : '40px' }}>
      <header>{project || 'No Project'}</header>
      <div className="connect-container" style={{ justifyContent: 'flex-start', gap: 8 }}>
        <button
          className="connect-button"
          onClick={handleConnect}
          disabled={!window.leaderpassAPI}
        >
          Connect
        </button>
        <span>
          Resolve status: {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
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
            {actions[currentCategory].map(action => {
              const disabled =
                (action.resolveRequired && !connected) ||
                (action.label === 'Transcribe Folder' && transcribeBusy);
              const disabledReason = action.resolveRequired && !connected
                ? 'Connect to Resolve to use this action.'
                : undefined;

              return (
                <button
                  key={action.label}
                  className="task-button"
                  onClick={action.onClick}
                  disabled={disabled}
                  title={disabledReason}
                >
                  <span className="icon">{action.icon}</span>
                  <span>{action.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {!connected ? <div>Resolve-only actions are disabled until connection is established.</div> : null}
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
            <button
              onClick={handleCancelTranscribe}
              disabled={!transcribeBusy}
              style={{ marginLeft: 8 }}
            >
              Cancel
            </button>
            <button
              onClick={handleTestGpu}
              disabled={transcribeBusy}
              style={{ marginLeft: 8 }}
            >
              Test GPU
            </button>
            <span style={{ marginLeft: 8 }}>Mode: {gpuEnabled ? 'GPU (CUDA)' : 'CPU (int8)'}</span>
            {transcribeBusy ? <span style={{ marginLeft: 8 }}>⏳ In progress…</span> : null}
          </div>
          {transcribeBusy || transcribeStatus.total > 0 ? (
            <div>
              Progress: {transcribeStatus.completed + transcribeStatus.failed}/{transcribeStatus.total || '?'}
              {' '}({transcribeStatus.completed} succeeded, {transcribeStatus.failed} failed)
              {transcribeStatus.currentFile ? (
                <div>Current file: {transcribeStatus.currentFile}</div>
              ) : null}
            </div>
          ) : null}
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
              {typeof transcribeSummary.total === 'number' ? (
                <div>
                  Summary: {transcribeSummary.completed} succeeded / {transcribeSummary.failed} failed / {transcribeSummary.total} total
                </div>
              ) : null}
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
      <SlideoutConsole log={log} open={consoleOpen} onToggle={setConsoleOpen} />
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
