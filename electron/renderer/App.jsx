const SESSION_STATUS_CODES = new Set([
  'CONNECTED',
  'DISCONNECTED',
  'PROJECT_CLOSED',
  'TIMELINE_CLOSED',
  'ERROR'
]);

const SESSION_NEGATIVE_STATUS_CODES = new Set(['DISCONNECTED', 'PROJECT_CLOSED', 'TIMELINE_CLOSED', 'ERROR']);

function App() {
  const [project, setProject] = React.useState('');
  const [timeline, setTimeline] = React.useState('');
  const [log, setLog] = React.useState([]);
  const [connected, setConnected] = React.useState(false);
  const [consoleOpen, setConsoleOpen] = React.useState(false);
  const [spellReport, setSpellReport] = React.useState([]);
  const [spellTotals, setSpellTotals] = React.useState({ items: 0, words: 0, issues: 0, ignored: 0 });
  const [workerAvailability, setWorkerAvailability] = React.useState({ resolve: true, media: true, platform: true });
  const [dashboard, setDashboard] = React.useState({ jobs: [], logs_by_job_step: {} });

  const [selectedCategory, setSelectedCategory] = React.useState('EDIT');
  const [selectedTask, setSelectedTask] = React.useState('project-setup');
  const [footerExpanded, setFooterExpanded] = React.useState(false);

  const [transcribeSource, setTranscribeSource] = React.useState('');
  const [transcribeBusy, setTranscribeBusy] = React.useState(false);
  const [transcribeProgress, setTranscribeProgress] = React.useState({
    total: 0,
    completed: 0,
    failed: 0,
    currentSource: '',
    startedAt: null,
    updatedAt: null,
    lastDurationSeconds: null
  });

  const appendLog = React.useCallback(msg => {
    setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-250));
  }, []);

  const formatDuration = React.useCallback(milliseconds => {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '—';
    const seconds = Math.round(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    if (minutes > 0) return `${minutes}m ${remSeconds}s`;
    return `${remSeconds}s`;
  }, []);

  React.useEffect(() => {
    if (!window.electronAPI) return;

    // Worker availability logs are canonicalized through onHelperStatus.
    // If helper messages introduce equivalent availability text (for example,
    // "<worker> worker unavailable"), filter them here to avoid duplicate UI logs.
    const workerUnavailableMessagePattern = /worker unavailable$/i;

    const unsubscribeStatus = window.electronAPI.onHelperStatus(status => {
      if (status?.code === 'WORKER_AVAILABLE' || status?.code === 'WORKER_UNAVAILABLE') {
        setWorkerAvailability(prev => ({ ...prev, [status?.worker || 'resolve']: Boolean(status.ok) }));
      }

      if (status?.worker && status.worker !== 'resolve' && status.code !== 'CONNECTED') return;

      // Worker availability and Resolve session status are distinct channels.
      if (!SESSION_STATUS_CODES.has(status?.code) && !status?.error) return;

      appendLog(`Status: ${status.code}${status.error ? ` - ${status.error}` : ''}`);
      if (status.code === 'CONNECTED' && status.ok) {
        setConnected(true);
        if (status.data?.project) setProject(status.data.project);
        if (status.data?.timeline) setTimeline(status.data.timeline);
      } else if (SESSION_NEGATIVE_STATUS_CODES.has(status.code) || status?.error) {
        setConnected(false);
        setProject('');
        setTimeline('');
      }
    });

    const unsubscribeMessage = window.electronAPI.onHelperMessage(payload => {
      const entry = typeof payload === 'string' ? payload : JSON.stringify(payload);
      if (workerUnavailableMessagePattern.test(entry)) return;
      appendLog(entry);
    });

    const unsubscribeWorkerEvents = window.electronAPI.onWorkerEvent?.(event => {
      if (!event || typeof event !== 'object') return;

      if (event.type === 'log' && event.message) {
        appendLog(`[${event.worker || 'worker'}] ${event.message}`);
        return;
      }

      if (event.type === 'status' && (event.code || event.error)) {
        appendLog(`[${event.worker || 'worker'}] ${event.code || 'STATUS'}${event.error ? ` - ${event.error}` : ''}`);
        return;
      }

      if (event.type === 'progress') {
        const progressText = event.data?.message || event.code || 'progress';
        appendLog(`[${event.worker || 'worker'}] ${progressText}`);
      }
    });

    const unsubscribeJobEvents = window.electronAPI.onJobEvent(event => {
      if (event?.type === 'step_progress' && event?.worker === 'media') {
        const statusLabel = event.state || 'progress';
        const timingLabel = Number.isFinite(event?.timing_ms) ? ` (${formatDuration(event.timing_ms)})` : '';
        const errorLabel = event?.error?.message ? ` - ${event.error.message}` : '';
        appendLog(`[media-step] ${event.step_id || 'unknown'} ${statusLabel}${timingLabel}${errorLabel}`);
      }

      if (event?.type === 'job_state') {
        const transcribeJobId = event?.job_id || '';
        if (transcribeJobId) {
          appendLog(`[job] ${transcribeJobId} -> ${event.state}`);
        }
      }

      window.electronAPI.dashboardSnapshot()
        .then(result => setDashboard(result?.data || { jobs: [], logs_by_job_step: {} }))
        .catch(() => null);
    });

    return () => {
      unsubscribeStatus && unsubscribeStatus();
      unsubscribeMessage && unsubscribeMessage();
      unsubscribeJobEvents && unsubscribeJobEvents();
      unsubscribeWorkerEvents && unsubscribeWorkerEvents();
    };
  }, [appendLog, formatDuration]);

  React.useEffect(() => {
    if (!window.electronAPI?.dashboardSnapshot) return;

    window.electronAPI.dashboardSnapshot()
      .then(result => setDashboard(result?.data || { jobs: [], logs_by_job_step: {} }))
      .catch(() => null);

    const timer = setInterval(() => {
      window.electronAPI.dashboardSnapshot()
        .then(result => setDashboard(result?.data || { jobs: [], logs_by_job_step: {} }))
        .catch(() => null);
    }, 2000);

    return () => clearInterval(timer);
  }, []);

  const handleConnect = React.useCallback(() => {
    if (!window.leaderpassAPI) {
      appendLog('Leaderpass API not available; cannot connect');
      return;
    }
    window.leaderpassAPI.call('connect')
      .then(() => appendLog('Connect success'))
      .catch(err => appendLog(`Connect error: ${err?.error || err}`));
  }, [appendLog]);

  const handleNewProjectBins = React.useCallback(() => {
    if (!window.leaderpassAPI) return appendLog('Leaderpass API not available; cannot create project bins');
    window.leaderpassAPI.call('create_project_bins')
      .then(() => appendLog('Project bin creation command sent'))
      .catch(err => appendLog(`Project bin creation error: ${err?.error || err}`));
  }, [appendLog]);

  const handleLPBaseExport = React.useCallback(() => {
    if (!window.leaderpassAPI) return appendLog('Leaderpass API not available; cannot export LP Base');
    window.leaderpassAPI.call('lp_base_export')
      .then(() => appendLog('LP Base Export command sent'))
      .catch(err => appendLog(`LP Base Export error: ${err?.error || err}`));
  }, [appendLog]);

  const handleSpellcheck = React.useCallback(() => {
    if (!window.leaderpassAPI) return appendLog('Leaderpass API not available; cannot run spellcheck');
    const misspell = window.spellcheckAPI?.misspellings;
    window.leaderpassAPI.call('spellcheck').then(async res => {
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
          rows.push({ ...entry, misspelled: result.misspelled });
        }
      }
      setSpellReport(rows);
      setSpellTotals({ items: totalItems, words: totalWords, issues: totalIssues, ignored: totalIgnored });
      appendLog('Spellcheck complete');
    }).catch(err => appendLog(`Spellcheck error: ${err?.error || err}`));
  }, [appendLog]);

  const pickFolder = React.useCallback(async setter => {
    if (!window.dialogAPI?.pickFolder) {
      appendLog('Folder picker unavailable in this environment');
      return;
    }
    const result = await window.dialogAPI.pickFolder();
    if (!result?.canceled && result?.folderPath) {
      setter(result.folderPath);
    }
  }, [appendLog]);

  const handleLaunchTranscribe = React.useCallback(async () => {
    if (!window.electronAPI?.transcribeFolder) return;
    if (!transcribeSource) {
      appendLog('Transcribe requires a source folder.');
      return;
    }

    try {
      setTranscribeBusy(true);
      setTranscribeProgress({
        total: 0,
        completed: 0,
        failed: 0,
        currentSource: 'Processing folder…',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        lastDurationSeconds: null
      });
      const response = await window.electronAPI.transcribeFolder(transcribeSource, {
        useGpu: false,
        engine: 'local'
      });
      const outputs = Array.isArray(response?.data?.outputs) ? response.data.outputs : [];
      const failures = Array.isArray(response?.data?.failures) ? response.data.failures : [];
      const completed = outputs.length + failures.length;
      const currentSource = outputs[outputs.length - 1]?.file || failures[failures.length - 1]?.file || '';
      setTranscribeProgress(prev => ({
        ...prev,
        total: completed,
        completed,
        failed: failures.length,
        currentSource,
        updatedAt: Date.now(),
        lastDurationSeconds: prev.startedAt ? Math.max(0, (Date.now() - prev.startedAt) / 1000) : null
      }));
      appendLog(`Transcribe completed. Files processed: ${response?.data?.files_processed ?? 'unknown'}`);
    } catch (err) {
      setTranscribeProgress(prev => ({
        ...prev,
        updatedAt: Date.now()
      }));
      appendLog(`Transcribe error: ${err?.error?.message || err?.message || JSON.stringify(err)}`);
    } finally {
      setTranscribeBusy(false);
    }
  }, [appendLog, transcribeSource]);

  const categories = React.useMemo(() => ([
    {
      key: 'EDIT',
      tasks: [
        { key: 'project-setup', label: 'Project Setup', description: 'Create baseline bins and structure in Resolve.', actionLabel: 'Run Project Setup', onClick: handleNewProjectBins, requiresResolve: true },
        { key: 'spellcheck', label: 'Spellcheck', description: 'Scan timeline text and review misspellings.', actionLabel: 'Run Spellcheck', onClick: handleSpellcheck, requiresResolve: true },
        { key: 'deliver-export', label: 'Deliver / Export', description: 'Queue LP base export jobs.', actionLabel: 'Run LP Base Export', onClick: handleLPBaseExport, requiresResolve: true }
      ]
    },
    {
      key: 'PREP',
      tasks: [
        { key: 'transcribe', label: 'Transcribe', description: 'Batch transcribe media files from a source folder.', actionLabel: transcribeBusy ? 'Transcribing…' : 'Start Transcribe', onClick: handleLaunchTranscribe, requiresResolve: false }
      ]
    },
    {
      key: 'PLATFORM',
      tasks: [
        { key: 'platform-status', label: 'Platform Status', description: 'Review workers, job queue, and platform activity.', actionLabel: 'Refresh Status', onClick: () => window.electronAPI.dashboardSnapshot().then(result => setDashboard(result?.data || { jobs: [], logs_by_job_step: {} })), requiresResolve: false }
      ]
    }
  ]), [handleLaunchTranscribe, handleLPBaseExport, handleNewProjectBins, handleSpellcheck, transcribeBusy]);

  const selectedCategoryData = categories.find(c => c.key === selectedCategory) || categories[0];
  const selectedTaskData = selectedCategoryData.tasks.find(t => t.key === selectedTask) || selectedCategoryData.tasks[0];

  React.useEffect(() => {
    if (!selectedCategoryData.tasks.some(t => t.key === selectedTask)) {
      setSelectedTask(selectedCategoryData.tasks[0]?.key || '');
    }
  }, [selectedCategoryData, selectedTask]);

  const activeJob = (dashboard.jobs || []).find(job => ['queued', 'running'].includes(job.state)) || dashboard.jobs?.[0] || null;
  const recentEvents = React.useMemo(() => {
    return Object.entries(dashboard.logs_by_job_step || {})
      .flatMap(([jobId, steps]) => Object.entries(steps).flatMap(([stepId, entries]) =>
        entries.map(entry => ({ jobId, stepId, type: entry.type, state: entry.state || entry.code || 'event' }))))
      .slice(-12)
      .reverse();
  }, [dashboard]);

  const elapsedMs = transcribeProgress.startedAt
    ? (((transcribeBusy ? Date.now() : (transcribeProgress.updatedAt || Date.now())) - transcribeProgress.startedAt))
    : null;
  const remainingItems = Math.max(0, (transcribeProgress.total || 0) - (transcribeProgress.completed || 0));
  const estimatedRemainingMs = transcribeProgress.completed > 0 && elapsedMs
    ? Math.round((elapsedMs / transcribeProgress.completed) * remainingItems)
    : null;
  const completedLabel = transcribeProgress.total
    ? `${Math.min(transcribeProgress.completed, transcribeProgress.total)}/${transcribeProgress.total}`
    : '0/0';
  const transcribeProgressPercent = transcribeProgress.total > 0
    ? Math.round((Math.min(transcribeProgress.completed, transcribeProgress.total) / transcribeProgress.total) * 100)
    : (transcribeBusy ? 1 : 0);
  const selectedTaskProgressPercent = selectedTaskData?.key === 'transcribe'
    ? transcribeProgressPercent
    : (activeJob && ['queued', 'running'].includes(activeJob.state) ? 50 : 0);

  const renderTaskDetail = () => {
    if (!selectedTaskData) return null;

    if (selectedTaskData.key === 'spellcheck') {
      return (
        <div className="task-detail-block">
          <SpellcheckReport report={spellReport} totals={spellTotals} onLog={appendLog} />
        </div>
      );
    }

    if (selectedTaskData.key === 'transcribe') {
      return (
        <div className="task-detail-block transcribe-detail">
          <div className="path-row">
            <label>Source folder</label>
            <div>
              <input value={transcribeSource} onChange={e => setTranscribeSource(e.target.value)} placeholder="Select source media folder" />
              <button onClick={() => pickFolder(setTranscribeSource)}>Browse</button>
            </div>
          </div>
          <div className="path-row">
            <label>Output folder</label>
            <div>
              <input value="Same folder as source media" readOnly />
            </div>
          </div>
          <div className="transcribe-stats-grid">
            <div><span>Current item</span><strong>{transcribeProgress.currentSource || 'Waiting for active media item'}</strong></div>
            <div><span>Estimated time remaining</span><strong>{formatDuration(estimatedRemainingMs)}</strong></div>
            <div><span>Total batch progress</span><strong>{completedLabel}</strong></div>
            <div><span>Process status</span><strong>{transcribeBusy ? 'running' : 'idle'}</strong></div>
            <div><span>Total elapsed time</span><strong>{formatDuration(elapsedMs)}</strong></div>
            <div><span>Files failed</span><strong>{transcribeProgress.failed}</strong></div>
          </div>
        </div>
      );
    }

    if (selectedTaskData.key === 'platform-status') {
      return (
        <div className="task-detail-block">
          <div className="platform-grid">
            {['resolve', 'media', 'platform'].map(worker => (
              <div key={worker} className="metric-card">
                <span>{worker}</span>
                <strong>{workerAvailability[worker] ? 'Available' : 'Unavailable'}</strong>
              </div>
            ))}
            <div className="metric-card">
              <span>Jobs in queue</span>
              <strong>{dashboard.jobs?.filter(job => ['queued', 'running'].includes(job.state)).length || 0}</strong>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="task-detail-block muted-detail">
        <p>{selectedTaskData.description}</p>
      </div>
    );
  };

  return (
    <div className="app-shell">
      <header className="top-status-bar">
        <button className="connect-pill" onClick={handleConnect} disabled={!window.leaderpassAPI}>Connect Resolve</button>
        <div className="status-indicators">
          <span className={connected ? 'ok' : 'bad'}>● Resolve Connection</span>
          <span className={project ? 'ok' : 'bad'}>● Project Open</span>
          <span className={timeline ? 'ok' : 'bad'}>● Timeline Open</span>
        </div>
      </header>

      <div className="workspace-layout">
        <aside className="left-sidebar">
          <h2>Categories</h2>
          {categories.map(category => (
            <button
              key={category.key}
              className={`category-link ${selectedCategory === category.key ? 'active' : ''}`}
              onClick={() => {
                setSelectedCategory(category.key);
                setSelectedTask(category.tasks[0]?.key || '');
              }}
            >
              {category.key}
            </button>
          ))}
        </aside>

        <main className="main-panel">
          <div className="panel-header">
            <h1>{selectedCategoryData.key}</h1>
            <p>{project || 'No active project'} {timeline ? `• ${timeline}` : ''}</p>
          </div>

          <section className="action-cards">
            {selectedCategoryData.tasks.map(task => {
              const active = task.key === selectedTask;
              const disabled = (task.requiresResolve && !connected) || (task.key === 'transcribe' && transcribeBusy);
              return (
                <article key={task.key} className={`action-card ${active ? 'selected' : ''}`} onClick={() => setSelectedTask(task.key)}>
                  <h3>{task.label}</h3>
                  <p>{task.description}</p>
                  <button
                    disabled={disabled}
                    onClick={event => {
                      event.stopPropagation();
                      task.onClick();
                    }}
                  >
                    {task.actionLabel}
                  </button>
                </article>
              );
            })}
          </section>

          <section className="task-info-panel">
            <div className="task-progress-line">
              <span>{selectedTaskData?.label || 'Task'} Progress</span>
              <strong>{selectedTaskProgressPercent}%</strong>
            </div>
            {renderTaskDetail()}
          </section>
        </main>
      </div>

      <footer className={`activity-footer ${footerExpanded ? 'expanded' : ''}`}>
        <div className="footer-summary" onClick={() => setFooterExpanded(value => !value)}>
          <strong>Active job:</strong>
          <span>{activeJob ? `${activeJob.job_id} (${activeJob.state})` : 'No active jobs'}</span>
        </div>
        {footerExpanded ? (
          <div className="footer-history">
            {recentEvents.length === 0 ? <div>No activity history yet.</div> : recentEvents.map((entry, index) => (
              <div key={`${entry.jobId}-${entry.stepId}-${index}`}>
                {entry.jobId} / {entry.stepId}: {entry.type} → {entry.state}
              </div>
            ))}
          </div>
        ) : null}
      </footer>

      <SlideoutConsole log={log} open={consoleOpen} onToggle={setConsoleOpen} />
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
