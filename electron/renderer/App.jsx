const SESSION_STATUS_CODES = new Set([
  'CONNECTED',
  'DISCONNECTED',
  'PROJECT_CLOSED',
  'TIMELINE_CLOSED',
  'ERROR'
]);

const SESSION_NEGATIVE_STATUS_CODES = new Set(['DISCONNECTED', 'PROJECT_CLOSED', 'TIMELINE_CLOSED', 'ERROR']);

const NAV_ITEMS = [
  { route: '/prep', label: 'Prep' },
  { route: '/edit', label: 'Edit' },
  { route: '/deliver', label: 'Deliver' }
];

const ROUTE_LABELS = {
  '/prep': 'Prep',
  '/edit': 'Edit',
  '/deliver': 'Deliver',
  '/settings': 'Settings'
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

function GearIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
        <span className="navbar-sep" />
        <button
          type="button"
          className={`navbar-gear${route === '/settings' ? ' active' : ''}`}
          aria-label="Settings"
          onClick={() => onNavigate('/settings')}
        >
          <GearIcon />
        </button>
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
  const [workerAvailability, setWorkerAvailability] = React.useState({ resolve: true, media: true, platform: true });
  const [dashboard, setDashboard] = React.useState({ jobs: [], logs_by_job_step: {} });
  const [jobPanelOpen, setJobPanelOpen] = React.useState(false);
  const [activeResultJobId, setActiveResultJobId] = React.useState(null);

  // Settings state
  const [settingsDraft, setSettingsDraft] = React.useState({ displayName: '', lposUrl: '' });
  const [settingsSaved, setSettingsSaved] = React.useState(false);
  const [lposUrl, setLposUrl] = React.useState('');
  // 'unconfigured' | 'ok' | 'error' | 'no-secret'
  const [lposStatus, setLposStatus] = React.useState('unconfigured');

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

  // Load preferences
  React.useEffect(() => {
    if (!window.electronAPI?.getPreferences) return;
    window.electronAPI.getPreferences()
      .then((result) => {
        const prefs = result?.data || {};
        const name = prefs.displayName || '';
        // Stored under lposBaseUrl (the canonical key written on save)
        const url = prefs.lposBaseUrl || 'https://lpos.tail856ed3.ts.net';
        setSettingsDraft({ displayName: name, lposUrl: url });
        setLposUrl(url);
      })
      .catch(() => null);
  }, []);

  // Poll LPOS health every 30 s — drives the status bar indicator
  React.useEffect(() => {
    if (!window.lposAPI) return;

    async function checkLpos() {
      if (!lposUrl) {
        setLposStatus('unconfigured');
        return;
      }
      try {
        const result = await window.lposAPI.health();
        if (result?.ok) {
          setLposStatus('ok');
        } else if (result?.error === 'LPOS not configured') {
          setLposStatus('no-secret');
        } else {
          setLposStatus('error');
        }
      } catch {
        setLposStatus('error');
      }
    }

    checkLpos();
    const timer = setInterval(checkLpos, 30_000);
    return () => clearInterval(timer);
  }, [lposUrl]);

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
    appendLog('Spellcheck started…');

    window.leaderpassAPI.call('spellcheck').then(async (res) => {
      const clips = (res.data && res.data.items) || [];
      const resultItems = [];

      for (const [clipIdx, entry] of clips.entries()) {
        const result = misspell
          ? await misspell(entry.text)
          : { misspelled: [] };

        for (const [wordIdx, word] of (result.misspelled || []).entries()) {
          resultItems.push({
            key: `${clipIdx}_${wordIdx}_${word}`,
            data: {
              word,
              clipText:    entry.text,
              track:       entry.track       ?? null,
              tool:        entry.tool        ?? null,
              timecode:    entry.timecode    ?? null,
              start_frame: entry.start_frame ?? null,
              tool_name:   entry.tool_name   ?? null
            }
          });
        }
      }

      appendLog(`Spellcheck complete — ${resultItems.length} issue(s) found`);

      if (resultItems.length === 0) return;

      // Store result items and open the result overlay
      const runId = crypto.randomUUID();
      await window.resultsAPI?.init(runId, 'spellcheck', 'Spellcheck', resultItems).catch(() => {});
      setActiveResultJobId(runId);

    }).catch((err) => appendLog(`Spellcheck error: ${err?.error || err}`));
  }, [appendLog]);

  const handleSaveSettings = React.useCallback(() => {
    if (!window.electronAPI?.updatePreferences) return;
    window.electronAPI.updatePreferences({
      displayName: settingsDraft.displayName,
      lposBaseUrl: settingsDraft.lposUrl   // canonical key expected by main.js
    }).then(() => {
      setLposUrl(settingsDraft.lposUrl);
      setLposStatus('unconfigured');        // will re-check on next poll cycle
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    }).catch(() => null);
  }, [settingsDraft]);

  const workspaceConfig = React.useMemo(() => ({
    '/prep': {
      tasks: [
        {
          key: 'atem-ingest',
          label: 'ATEM Footage',
          description: 'Ingest footage from ATEM ISO Extreme SDI over FTP, with automatic folder organisation and naming.',
          actionLabel: 'Coming Soon',
          onClick: () => {},
          requiresResolve: false,
          comingSoon: true
        },
        {
          key: 'r2-manager',
          label: 'R2 Backup Manager',
          description: 'Browse, preview, and manage project backups stored on Cloudflare R2.',
          actionLabel: 'Coming Soon',
          onClick: () => {},
          requiresResolve: false,
          comingSoon: true
        }
      ]
    },
    '/edit': {
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

  const currentWorkspace = workspaceConfig[route];

  function renderStatusBar() {
    const runningJobs = dashboard.jobs.filter(j => j.state === 'running');
    const runningJob  = runningJobs[0] ?? null;
    const hasJobs     = runningJobs.length > 0 || dashboard.jobs.length > 0;

    return (
      <footer className="status-bar">
        {/* Left: Resolve */}
        <div className="status-bar-group">
          <span className={`status-dot ${connected ? 'ok' : 'bad'}`} />
          <span className="status-bar-label">Resolve</span>
          {connected ? (
            <>
              <span className="status-bar-chip ok">Connected</span>
              {project && <span className="status-bar-chip">{project}</span>}
              {timeline && <span className="status-bar-chip dim">{timeline}</span>}
            </>
          ) : (
            <span className="status-bar-chip bad">Offline</span>
          )}
        </div>

        <div className="status-bar-divider" />

        {/* LPOS */}
        <div className="status-bar-group">
          <span className={`status-dot ${lposStatus === 'ok' ? 'ok' : lposStatus === 'error' ? 'bad' : 'neutral'}`} />
          <span className="status-bar-label">LPOS</span>
          {lposStatus === 'ok' && <span className="status-bar-chip ok">Connected</span>}
          {lposStatus === 'error' && <span className="status-bar-chip bad">Unreachable</span>}
          {lposStatus === 'no-secret' && <span className="status-bar-chip bad">No secret</span>}
          {lposStatus === 'unconfigured' && <span className="status-bar-chip">{lposUrl ? 'Connecting…' : 'Not configured'}</span>}
        </div>

        {/* Right: Job widget */}
        <div className="status-bar-right">
          {runningJob && (
            <button
              className="status-bar-jobs-btn running"
              onClick={() => setJobPanelOpen(true)}
            >
              <span className="status-bar-spinner" />
              <span className="status-bar-job-label">
                {runningJob.preset_id || 'Job'}
                {runningJob.steps_total > 0
                  ? ` ${runningJob.steps_done}/${runningJob.steps_total}`
                  : ''}
              </span>
            </button>
          )}
          {!runningJob && hasJobs && (
            <button
              className="status-bar-jobs-btn"
              onClick={() => setJobPanelOpen(true)}
            >
              Jobs
            </button>
          )}
        </div>
      </footer>
    );
  }

  function renderWorkspacePage() {
    if (!currentWorkspace) return null;

    return (
      <div className="app-inner">
        <HoverNav route={route} onNavigate={navigateTo} />

        <main className="app-content">
          <div className="task-grid">
            {currentWorkspace.tasks.map((task) => {
              const disabled = (task.requiresResolve && !connected) || task.comingSoon;
              return (
                <article
                  key={task.key}
                  className={`task-card${task.comingSoon ? ' soon' : ''}`}
                >
                  <h3 className="task-card-title">{task.label}</h3>
                  <p className="task-card-desc">{task.description}</p>
                  <button
                    type="button"
                    className="btn"
                    disabled={disabled}
                    onClick={() => { if (!task.comingSoon) task.onClick(); }}
                  >
                    {task.actionLabel}
                  </button>
                </article>
              );
            })}
          </div>
        </main>
      </div>
    );
  }

  function renderSettingsPage() {
    return (
      <div className="app-inner">
        <HoverNav route={route} onNavigate={navigateTo} />
        <Breadcrumbs route={route} onNavigate={navigateTo} />

        <main className="app-content">
          <div className="page-stack settings-stack">
            <section className="panel page-hero">
              <p className="eyebrow">Configuration</p>
              <h1 className="page-title">Settings</h1>
              <p className="page-copy">Instance identity and connection configuration for this EditPanel machine.</p>
            </section>

            <section className="panel settings-section">
              <div className="list-header">
                <p className="eyebrow">Instance</p>
                <h2 className="section-title">Identity</h2>
                <p className="section-copy">How this machine appears on the LPOS workstation page.</p>
              </div>
              <div className="settings-field">
                <label className="settings-label" htmlFor="display-name">Display Name</label>
                <input
                  id="display-name"
                  type="text"
                  className="settings-input"
                  placeholder="My Edit Station"
                  value={settingsDraft.displayName}
                  onChange={(e) => setSettingsDraft((prev) => ({ ...prev, displayName: e.target.value }))}
                />
                <p className="settings-hint">Overrides the machine hostname shown on the LPOS workstation page. Leave blank to use the hostname.</p>
              </div>
            </section>

            <section className="panel settings-section">
              <div className="list-header">
                <p className="eyebrow">Connection</p>
                <h2 className="section-title">LPOS</h2>
                <p className="section-copy">Connection settings for your LeaderPass instance.</p>
              </div>
              <div className="settings-field">
                <label className="settings-label" htmlFor="lpos-url">Base URL</label>
                <input
                  id="lpos-url"
                  type="text"
                  className="settings-input"
                  placeholder="https://your-lpos-instance.com"
                  value={settingsDraft.lposUrl}
                  onChange={(e) => setSettingsDraft((prev) => ({ ...prev, lposUrl: e.target.value }))}
                />
                <p className="settings-hint">Client credentials are managed via Doppler and are not configurable here.</p>
              </div>
            </section>

            <div className="settings-actions">
              <button type="button" className="btn" onClick={handleSaveSettings}>
                {settingsSaved ? 'Saved' : 'Save Settings'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => window.electronAPI?.quit?.()}
              >
                Quit EditPanel
              </button>
            </div>
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
            <button type="button" className="home-tile" onClick={() => navigateTo('/prep')}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span className="home-tile-label">Prep</span>
            </button>
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

  const pageContent = route === '/'
    ? renderHomePage()
    : route === '/settings'
    ? renderSettingsPage()
    : renderWorkspacePage();

  return (
    <div className="app-shell">
      <div key={route} className="page-enter">
        {pageContent}
      </div>
      {renderStatusBar()}
      <JobPanel
        open={jobPanelOpen}
        onClose={() => setJobPanelOpen(false)}
        dashboard={dashboard}
        onViewResults={(runId) => {
          setJobPanelOpen(false);
          setActiveResultJobId(runId);
        }}
      />
      {activeResultJobId && (
        <ResultOverlay
          jobId={activeResultJobId}
          onClose={() => setActiveResultJobId(null)}
        />
      )}
      <SlideoutConsole log={log} open={consoleOpen} onToggle={setConsoleOpen} />
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
