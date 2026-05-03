const SESSION_STATUS_CODES = new Set([
  'CONNECTED',
  'DISCONNECTED',
  'PROJECT_CLOSED',
  'TIMELINE_CLOSED',
  'ERROR'
]);

const SESSION_NEGATIVE_STATUS_CODES = new Set(['DISCONNECTED', 'PROJECT_CLOSED', 'TIMELINE_CLOSED', 'ERROR']);

const NAV_ITEMS = [
  { route: '/edit', label: 'Edit' },
  { route: '/deliver', label: 'Deliver' }
];

const ROUTE_LABELS = {
  '/edit': 'Edit',
  '/deliver': 'Deliver'
};

function getRouteFromHash() {
  const hash = window.location.hash || '#/';
  const route = hash.replace(/^#/, '') || '/';
  return ROUTE_LABELS[route] ? route : '/';
}

function navigateTo(route) {
  window.location.hash = route === '/' ? '#/' : `#${route}`;
}

function HomeIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
    </svg>
  );
}

function HoverNav({ route, onNavigate }) {
  return (
    <nav className="navbar">
      <div className="navbar-pill">
        <button type="button" className="navbar-home" aria-label="Home" onClick={() => onNavigate('/')}>
          <HomeIcon />
        </button>
        <span className="navbar-sep" />
        {NAV_ITEMS.map((item) => (
          <button
            key={item.route}
            type="button"
            className={`navbar-link${route === item.route ? ' active' : ''}`}
            onClick={() => onNavigate(item.route)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </nav>
  );
}

function Breadcrumbs({ route, onNavigate }) {
  if (route === '/') return null;

  const crumbs = route
    .split('/')
    .filter(Boolean)
    .map((segment, index, segments) => {
      const href = '/' + segments.slice(0, index + 1).join('/');
      return {
        href,
        label: ROUTE_LABELS[href] || segment,
        isLast: index === segments.length - 1
      };
    });

  return (
    <nav className="breadcrumb-bar" aria-label="Breadcrumb">
      <button
        type="button"
        className="breadcrumb-back"
        onClick={() => window.history.length > 1 ? window.history.back() : onNavigate('/')}
        aria-label="Go back"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <button type="button" className="breadcrumb-home" aria-label="Home" onClick={() => onNavigate('/')}>
        <HomeIcon size={13} />
      </button>
      {crumbs.map((crumb) => (
        <span key={crumb.href} className="breadcrumb-item">
          <span className="breadcrumb-sep">/</span>
          {crumb.isLast ? (
            <span className="breadcrumb-current">{crumb.label}</span>
          ) : (
            <button type="button" className="breadcrumb-link" onClick={() => onNavigate(crumb.href)}>
              {crumb.label}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}

function App() {
  const [route, setRoute] = React.useState(() => getRouteFromHash());
  const [project, setProject] = React.useState('');
  const [timeline, setTimeline] = React.useState('');
  const [log, setLog] = React.useState([]);
  const [connected, setConnected] = React.useState(false);
  const [consoleOpen, setConsoleOpen] = React.useState(false);
  const [spellReport, setSpellReport] = React.useState([]);
  const [spellTotals, setSpellTotals] = React.useState({ items: 0, words: 0, issues: 0, ignored: 0 });
  const [workerAvailability, setWorkerAvailability] = React.useState({ resolve: true, media: true, platform: true });
  const [dashboard, setDashboard] = React.useState({ jobs: [], logs_by_job_step: {} });
  const [selectedTaskByRoute, setSelectedTaskByRoute] = React.useState({
    '/edit': 'project-setup',
    '/deliver': 'deliver-export'
  });

  const appendLog = React.useCallback((msg) => {
    setLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-250));
  }, []);

  const formatDuration = React.useCallback((milliseconds) => {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '-';
    const seconds = Math.round(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    if (minutes > 0) return `${minutes}m ${remSeconds}s`;
    return `${remSeconds}s`;
  }, []);

  React.useEffect(() => {
    const onHashChange = () => setRoute(getRouteFromHash());
    window.addEventListener('hashchange', onHashChange);
    onHashChange();
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  React.useEffect(() => {
    if (!window.electronAPI) return;

    const workerUnavailableMessagePattern = /worker unavailable$/i;

    const unsubscribeStatus = window.electronAPI.onHelperStatus((status) => {
      if (status?.code === 'WORKER_AVAILABLE' || status?.code === 'WORKER_UNAVAILABLE') {
        setWorkerAvailability((prev) => ({ ...prev, [status?.worker || 'resolve']: Boolean(status.ok) }));
      }

      if (status?.worker && status.worker !== 'resolve' && status.code !== 'CONNECTED') return;
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

    const unsubscribeMessage = window.electronAPI.onHelperMessage((payload) => {
      const entry = typeof payload === 'string' ? payload : JSON.stringify(payload);
      if (workerUnavailableMessagePattern.test(entry)) return;
      appendLog(entry);
    });

    const unsubscribeWorkerEvents = window.electronAPI.onWorkerEvent?.((event) => {
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
        appendLog(`[${event.worker || 'worker'}] ${event.data?.message || event.code || 'progress'}`);
      }
    });

    const unsubscribeJobEvents = window.electronAPI.onJobEvent((event) => {
      if (event?.type === 'step_progress' && event?.worker === 'media') {
        const timingLabel = Number.isFinite(event?.timing_ms) ? ` (${formatDuration(event.timing_ms)})` : '';
        const errorLabel = event?.error?.message ? ` - ${event.error.message}` : '';
        appendLog(`[media-step] ${event.step_id || 'unknown'} ${event.state || 'progress'}${timingLabel}${errorLabel}`);
      }

      if (event?.type === 'job_state' && event?.job_id) {
        appendLog(`[job] ${event.job_id} -> ${event.state}`);
      }

      window.electronAPI.dashboardSnapshot()
        .then((result) => setDashboard(result?.data || { jobs: [], logs_by_job_step: {} }))
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
      .then((result) => setDashboard(result?.data || { jobs: [], logs_by_job_step: {} }))
      .catch(() => null);

    const timer = setInterval(() => {
      window.electronAPI.dashboardSnapshot()
        .then((result) => setDashboard(result?.data || { jobs: [], logs_by_job_step: {} }))
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
      .catch((err) => appendLog(`Connect error: ${err?.error || err}`));
  }, [appendLog]);

  const handleNewProjectBins = React.useCallback(() => {
    if (!window.leaderpassAPI) {
      appendLog('Leaderpass API not available; cannot create project bins');
      return;
    }

    window.leaderpassAPI.call('create_project_bins')
      .then(() => appendLog('Project bin creation command sent'))
      .catch((err) => appendLog(`Project bin creation error: ${err?.error || err}`));
  }, [appendLog]);

  const handleLPBaseExport = React.useCallback(() => {
    if (!window.leaderpassAPI) {
      appendLog('Leaderpass API not available; cannot export LP Base');
      return;
    }

    window.leaderpassAPI.call('lp_base_export')
      .then(() => appendLog('LP Base Export command sent'))
      .catch((err) => appendLog(`LP Base Export error: ${err?.error || err}`));
  }, [appendLog]);

  const handleSpellcheck = React.useCallback(() => {
    if (!window.leaderpassAPI) {
      appendLog('Leaderpass API not available; cannot run spellcheck');
      return;
    }

    const misspell = window.spellcheckAPI?.misspellings;
    window.leaderpassAPI.call('spellcheck').then(async (res) => {
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
        if (result.misspelled.length > 0) rows.push({ ...entry, misspelled: result.misspelled });
      }

      setSpellReport(rows);
      setSpellTotals({ items: totalItems, words: totalWords, issues: totalIssues, ignored: totalIgnored });
      appendLog('Spellcheck complete');
    }).catch((err) => appendLog(`Spellcheck error: ${err?.error || err}`));
  }, [appendLog]);

  const workspaceConfig = React.useMemo(() => ({
    '/edit': {
      eyebrow: 'Resolve Workspace',
      title: 'Edit',
      copy: 'Operator setup and timeline QA in a stripped-back Resolve companion shell.',
      tasks: [
        {
          key: 'project-setup',
          label: 'Project Setup',
          description: 'Create baseline bins and project structure in Resolve.',
          actionLabel: 'Run Project Setup',
          onClick: handleNewProjectBins,
          requiresResolve: true
        },
        {
          key: 'spellcheck',
          label: 'Spellcheck',
          description: 'Scan timeline text and review misspellings before handoff.',
          actionLabel: 'Run Spellcheck',
          onClick: handleSpellcheck,
          requiresResolve: true
        }
      ]
    },
    '/deliver': {
      eyebrow: 'Output Workspace',
      title: 'Deliver',
      copy: 'Export operations and platform visibility for finishing and handoff.',
      tasks: [
        {
          key: 'deliver-export',
          label: 'LP Base Export',
          description: 'Queue LP Base export jobs from the active Resolve session.',
          actionLabel: 'Run LP Base Export',
          onClick: handleLPBaseExport,
          requiresResolve: true
        },
        {
          key: 'platform-status',
          label: 'Platform Status',
          description: 'Review workers, active jobs, and recent processing activity.',
          actionLabel: 'Refresh Status',
          onClick: () => window.electronAPI?.dashboardSnapshot?.().then((result) => {
            setDashboard(result?.data || { jobs: [], logs_by_job_step: {} });
          }),
          requiresResolve: false
        }
      ]
    }
  }), [handleLPBaseExport, handleNewProjectBins, handleSpellcheck]);

  const activeJob = (dashboard.jobs || []).find((job) => ['queued', 'running'].includes(job.state)) || dashboard.jobs?.[0] || null;

  const recentEvents = React.useMemo(() => {
    return Object.entries(dashboard.logs_by_job_step || {})
      .flatMap(([jobId, steps]) => Object.entries(steps).flatMap(([stepId, entries]) =>
        entries.map((entry) => ({ jobId, stepId, type: entry.type, state: entry.state || entry.code || 'event' }))))
      .slice(-8)
      .reverse();
  }, [dashboard]);

  const currentWorkspace = workspaceConfig[route];
  const selectedTaskKey = currentWorkspace ? selectedTaskByRoute[route] || currentWorkspace.tasks[0].key : null;
  const selectedTask = currentWorkspace ? currentWorkspace.tasks.find((task) => task.key === selectedTaskKey) || currentWorkspace.tasks[0] : null;

  React.useEffect(() => {
    if (!currentWorkspace || !selectedTask) return;
    if (!currentWorkspace.tasks.some((task) => task.key === selectedTask.key)) {
      setSelectedTaskByRoute((prev) => ({ ...prev, [route]: currentWorkspace.tasks[0].key }));
    }
  }, [currentWorkspace, selectedTask, route]);

  function setSelectedTask(routeKey, taskKey) {
    setSelectedTaskByRoute((prev) => ({ ...prev, [routeKey]: taskKey }));
  }

  function renderStatusRow() {
    return (
      <div className="status-row">
        <span className={`status-chip ${connected ? 'ok' : 'bad'}`}>Resolve {connected ? 'Connected' : 'Offline'}</span>
        <span className={`status-chip ${project ? 'ok' : 'bad'}`}>{project || 'No Project Open'}</span>
        <span className={`status-chip ${timeline ? 'ok' : 'bad'}`}>{timeline || 'No Timeline Open'}</span>
      </div>
    );
  }

  function renderTaskDetail() {
    if (!selectedTask) return null;

    if (selectedTask.key === 'spellcheck') {
      return <SpellcheckReport report={spellReport} totals={spellTotals} onLog={appendLog} />;
    }

    if (selectedTask.key === 'platform-status') {
      return (
        <div className="detail-stack">
          <div className="stats-grid">
            {['resolve', 'media', 'platform'].map((worker) => (
              <div key={worker} className="stat-card">
                <span className="stat-label">{worker}</span>
                <strong className="stat-value">{workerAvailability[worker] ? 'Available' : 'Unavailable'}</strong>
              </div>
            ))}
            <div className="stat-card">
              <span className="stat-label">Active Jobs</span>
              <strong className="stat-value">{dashboard.jobs?.filter((job) => ['queued', 'running'].includes(job.state)).length || 0}</strong>
            </div>
          </div>
          <div className="panel-list">
            <div className="list-header">
              <h3 className="section-title">Recent Activity</h3>
              <p className="section-copy">Latest platform events from the current job queue.</p>
            </div>
            {recentEvents.length === 0 ? (
              <div className="list-item muted">No activity history yet.</div>
            ) : recentEvents.map((entry, index) => (
              <div key={`${entry.jobId}-${entry.stepId}-${index}`} className="list-item">
                <strong>{entry.jobId}</strong>
                <span>{entry.stepId}</span>
                <span>{entry.type}</span>
                <span>{entry.state}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="detail-stack">
        <p className="section-copy">{selectedTask.description}</p>
        <div className="panel-note">
          <strong>Session</strong>
          <span>{project || 'No active project'}{timeline ? ` | ${timeline}` : ''}</span>
        </div>
        {activeJob ? (
          <div className="panel-note">
            <strong>Active Job</strong>
            <span>{activeJob.job_id} ({activeJob.state})</span>
          </div>
        ) : null}
      </div>
    );
  }

  function renderWorkspacePage() {
    if (!currentWorkspace || !selectedTask) return null;

    return (
      <div className="app-inner">
        <HoverNav route={route} onNavigate={navigateTo} />
        <Breadcrumbs route={route} onNavigate={navigateTo} />

        <main className="app-content">
          <div className="page-stack">
            <section className="panel page-hero">
              <p className="eyebrow">{currentWorkspace.eyebrow}</p>
              <h1 className="page-title">{currentWorkspace.title}</h1>
              <p className="page-copy">{currentWorkspace.copy}</p>
              <div className="actions-row">
                <button type="button" className="btn" onClick={handleConnect} disabled={!window.leaderpassAPI}>
                  Connect Resolve
                </button>
              </div>
              {renderStatusRow()}
            </section>

            <section className="task-grid">
              {currentWorkspace.tasks.map((task) => {
                const disabled = task.requiresResolve && !connected;
                return (
                  <article
                    key={task.key}
                    className={`task-card${selectedTask.key === task.key ? ' active' : ''}`}
                    onClick={() => setSelectedTask(route, task.key)}
                  >
                    <div>
                      <p className="eyebrow">Task</p>
                      <h3 className="section-title">{task.label}</h3>
                      <p className="section-copy">{task.description}</p>
                    </div>
                    <button
                      type="button"
                      className={task.key === 'platform-status' ? 'btn-secondary' : 'btn'}
                      disabled={disabled}
                      onClick={(event) => {
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

            <section className="panel detail-panel">
              <div className="list-header">
                <p className="eyebrow">Detail</p>
                <h2 className="section-title">{selectedTask.label}</h2>
                <p className="section-copy">{selectedTask.description}</p>
              </div>
              {renderTaskDetail()}
            </section>
          </div>
        </main>
      </div>
    );
  }

  function renderHomePage() {
    return (
      <div className="app-home">
        <div className="home-hero">
          <div className="home-brand">
            <h1 className="home-title">EditPanel</h1>
            <p className="home-subtitle">Your Resolve Companion</p>
          </div>

          <div className="home-tiles">
            <button type="button" className="home-tile" onClick={() => navigateTo('/edit')}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
              <span className="home-tile-label">Edit</span>
            </button>
            <button type="button" className="home-tile" onClick={() => navigateTo('/deliver')}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span className="home-tile-label">Deliver</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {route === '/' ? renderHomePage() : renderWorkspacePage()}
      <SlideoutConsole log={log} open={consoleOpen} onToggle={setConsoleOpen} />
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
