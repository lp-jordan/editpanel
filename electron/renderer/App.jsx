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
  const [workerAvailability, setWorkerAvailability] = React.useState({ resolve: true, media: true });
  const [dashboard, setDashboard] = React.useState({ jobs: [], logs_by_job_step: {} });
  const [jobPanelOpen, setJobPanelOpen] = React.useState(false);
  const [activeResultJobId, setActiveResultJobId] = React.useState(null);
  const [atemIngestOpen, setAtemIngestOpen]   = React.useState(false);
  const [exportOpen, setExportOpen]           = React.useState(false);
  const [activeExport, setActiveExport]       = React.useState(null);
  // Phase 3.5: bumps when the Jobs-tab "exports awaiting assignment" pill is
  // clicked. ExportsPanel observes the change and expands itself filtered to
  // 'unassigned'. We use a counter instead of a boolean so successive clicks
  // re-trigger the focus effect cleanly.
  const [exportsFocusToken, setExportsFocusToken] = React.useState(0);
  const [exportVersion, setExportVersion]     = React.useState(0);
  // Sticky Resolve-worker advisory (e.g. external scripting disabled, crash
  // loop). Driven by `resolve-advisory` IPC; null when nothing actionable.
  const [resolveAdvisory, setResolveAdvisory] = React.useState(null);
  // User-dismissed advisory: hides the banner until a new advisory.code or
  // a CONNECTED status comes through. Track by code so re-emitting the same
  // condition doesn't re-show what the user already chose to silence.
  const [dismissedAdvisoryCode, setDismissedAdvisoryCode] = React.useState(null);
  // r2ManagerOpen removed 2026-05-27 — cold-storage management lives in LPOS now.

  // Settings state
  const [settingsDraft, setSettingsDraft] = React.useState({ displayName: '', lposUrl: '', atemHost: '' });
  const [settingsSaved, setSettingsSaved] = React.useState(false);
  const [lposUrl, setLposUrl] = React.useState('');
  // 'unconfigured' | 'ok' | 'error' | 'signed-out'
  const [lposStatus, setLposStatus] = React.useState('unconfigured');
  // Identity of the currently signed-in LPOS user on this machine
  const [epUserEmail, setEpUserEmail] = React.useState('');
  const [epMachineName, setEpMachineName] = React.useState('');
  const [signinBusy, setSigninBusy] = React.useState(false);
  const [signinMessage, setSigninMessage] = React.useState('');

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

  // Load preferences (including ep sign-in identity)
  const loadPreferences = React.useCallback(() => {
    if (!window.electronAPI?.getPreferences) return;
    window.electronAPI.getPreferences()
      .then((result) => {
        const prefs = result?.data || {};
        const name = prefs.displayName || '';
        // Stored under lposBaseUrl (the canonical key written on save)
        const url = prefs.lposBaseUrl || 'https://lpos.tail856ed3.ts.net';
        const atem = prefs.atemFtpHost || '172.20.10.241';
        setSettingsDraft({ displayName: name, lposUrl: url, atemHost: atem });
        setLposUrl(url);
        setEpUserEmail(prefs.epUserEmail || '');
        setEpMachineName(prefs.epMachineName || '');
      })
      .catch(() => null);
  }, []);

  React.useEffect(() => {
    loadPreferences();
  }, [loadPreferences]);

  // Listen for the SSO callback result — fires after the user approves on /ep/link.
  React.useEffect(() => {
    if (!window.lposAPI?.onLinkResult) return;
    const unsubscribe = window.lposAPI.onLinkResult((payload) => {
      setSigninBusy(false);
      if (payload?.ok) {
        setSigninMessage(`Signed in as ${payload.user || 'LPOS user'}`);
        appendLog(`LPOS sign-in succeeded for ${payload.user || 'user'}`);
        loadPreferences();
        // Force an immediate health re-check
        setLposStatus('unconfigured');
      } else {
        const err = payload?.error || 'unknown';
        setSigninMessage(`Sign-in ${err === 'denied' ? 'cancelled' : 'failed'} (${err})`);
        appendLog(`LPOS sign-in failed: ${err}`);
      }
      setTimeout(() => setSigninMessage(''), 4000);
    });
    return unsubscribe;
  }, [appendLog, loadPreferences]);

  const handleSigninStart = React.useCallback(async () => {
    if (!window.lposAPI?.signinStart) return;
    setSigninBusy(true);
    setSigninMessage('Opening browser…');
    try {
      const result = await window.lposAPI.signinStart();
      if (!result?.ok) {
        setSigninBusy(false);
        setSigninMessage(`Could not open browser: ${result?.error || 'unknown'}`);
      }
      // Otherwise stay busy until onLinkResult fires
    } catch (err) {
      setSigninBusy(false);
      setSigninMessage(`Could not open browser: ${err?.message || err}`);
    }
  }, []);

  const handleSignout = React.useCallback(async () => {
    if (!window.lposAPI?.signout) return;
    try {
      await window.lposAPI.signout();
      setEpUserEmail('');
      setEpMachineName('');
      setSigninMessage('Signed out');
      setLposStatus('signed-out');
      setTimeout(() => setSigninMessage(''), 3000);
      appendLog('LPOS signed out');
    } catch (err) {
      setSigninMessage(`Sign-out failed: ${err?.message || err}`);
    }
  }, [appendLog]);

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
        } else if (result?.error && /not signed in|not configured/i.test(result.error)) {
          setLposStatus('signed-out');
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

  // Background export tracking — drives the Jobs panel "Exports" section and
  // the floating Jobs pill. The render runs in the main process, so progress
  // keeps flowing even after the picker overlay is closed.
  React.useEffect(() => {
    if (!window.exportsAPI) return;
    window.exportsAPI.getActive().then((r) => setActiveExport(r?.data || null)).catch(() => {});
    const offProgress = window.exportsAPI.onProgress((snap) => setActiveExport(snap));
    const offComplete = window.exportsAPI.onComplete((snap) => {
      setActiveExport(null);
      setExportVersion((v) => v + 1);
      if (snap?.state) {
        const uploaded = (snap.jobs || []).filter((j) => j.uploadStatus === 'uploaded').length;
        const uploadNote = snap.projectName ? ` · ${uploaded} uploaded to ${snap.projectName}` : '';
        appendLog(`[export] ${snap.state}${snap.error ? ` — ${snap.error}` : ''} · ${snap.jobs?.length || 0} timeline(s)${uploadNote}`);
      }
    });
    return () => { offProgress && offProgress(); offComplete && offComplete(); };
  }, [appendLog]);

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

    const unsubscribeAdvisory = window.electronAPI.onResolveAdvisory?.((advisory) => {
      // null payload = main cleared (e.g. CONNECTED arrived). Reset the
      // dismiss-code too so a future advisory shows up fresh.
      if (!advisory) {
        setResolveAdvisory(null);
        setDismissedAdvisoryCode(null);
        return;
      }
      setResolveAdvisory(advisory);
      // A new code overrides any prior dismiss.
      setDismissedAdvisoryCode((prev) => (prev === advisory.code ? prev : null));
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
      unsubscribeAdvisory && unsubscribeAdvisory();
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
    // Click on the Offline chip respawns the resolve worker rather than
    // re-sending `cmd: connect` to the existing one. The Python-side
    // DaVinciResolveScript module can cache a failed scriptapp() state in
    // a way that subsequent connect calls in the same process keep failing —
    // killing the worker forces a clean module reload, which is the only
    // recovery short of restarting Resolve itself. The main-process IPC
    // handler resets resolveAutoConnectDone before killing, so the new
    // worker's spawn event auto-fires connect against the fresh process.
    if (!window.electronAPI?.reconnectResolve) {
      appendLog('Reconnect API not available');
      return;
    }
    appendLog('Reconnecting to Resolve…');
    window.electronAPI.reconnectResolve()
      .then((res) => {
        if (res?.ok) appendLog('Resolve worker respawned; reattaching…');
        else         appendLog(`Reconnect failed: ${res?.error || 'unknown error'}`);
      })
      .catch((err) => appendLog(`Reconnect error: ${err?.error || err}`));
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
    // Opens the destination picker; the overlay drives lp_base_export +
    // start_render once the operator has chosen a target folder.
    setExportOpen(true);
  }, [appendLog]);

  // Phase 5c.3 + 5c.5 (2026-06-02): pull Frame.io comments → Resolve markers.
  // No project picker, no name match — the main process auto-discovers which
  // LPOS project(s) the current Resolve project's timelines were uploaded to
  // by walking timelineUids through the editorial_links tether. Editor clicks
  // once, system figures out the rest.
  const handlePullComments = React.useCallback(async () => {
    if (!window.lposAPI?.pullComments) {
      appendLog('LPOS API not available — sign in to LPOS in Settings');
      return;
    }
    if (!project) {
      appendLog('No active Resolve project — connect to Resolve first');
      return;
    }
    appendLog(`Pull comments → matching timelines in "${project}" against LPOS uploads…`);

    let res;
    try {
      // null projectId triggers discover mode (server-side fan-out by uid).
      res = await window.lposAPI.pullComments(null, {});
    } catch (err) {
      appendLog(`Pull comments error: ${err?.message || err}`);
      return;
    }
    if (!res?.ok) {
      appendLog(`Pull comments failed: ${res?.error || 'unknown'}`);
      return;
    }

    const d = res.data || {};
    if (d.message) {
      appendLog(d.message);
    } else {
      const tlCount = (d.timelines || []).length;
      const projects = Array.isArray(d.involvedProjectNames) ? d.involvedProjectNames : [];
      const projectLabel = projects.length === 0
        ? ''
        : projects.length === 1
          ? ` (LPOS: ${projects[0]})`
          : ` (LPOS: ${projects.length} projects)`;
      appendLog(
        `Pull comments → ${d.totalPlaced || 0} placed, ${d.totalRemoved || 0} removed, ` +
        `${d.totalKept || 0} kept across ${tlCount} timeline${tlCount === 1 ? '' : 's'}${projectLabel}.`
      );
      if (d.flaggedCount > 0) {
        appendLog(`  • Flagged ${d.flaggedCount} timeline${d.flaggedCount === 1 ? '' : 's'} ${d.flagColor || 'Sand'} — sort the bin by Flag in Resolve to find them.`);
      }
      const tlErrors = (d.timelines || []).filter((t) => t.error);
      for (const t of tlErrors) {
        appendLog(`  • ${t.timelineName || t.timelineUid}: ${t.error}`);
      }
      const tlSkipped = (d.timelines || []).filter((t) => Array.isArray(t.skipped) && t.skipped.length);
      for (const t of tlSkipped) {
        appendLog(`  • ${t.timelineName || t.timelineUid}: ${t.skipped.length} marker(s) not placed (see Jobs panel for details)`);
      }
    }
    if (d.jobId) setJobPanelOpen(true);
  }, [appendLog, project, setJobPanelOpen]);

  const handleSpellcheck = React.useCallback(() => {
    if (!window.leaderpassAPI) {
      appendLog('Leaderpass API not available; cannot run spellcheck');
      return;
    }

    const misspell = window.spellcheckAPI?.misspellings;
    // Capture the Resolve context at the moment the user kicks off the scan.
    // This pins the resulting run to a specific project/timeline so later
    // resolution actions can refuse to apply against a different project.
    const scopeProject  = project;
    const scopeTimeline = timeline;
    appendLog(`Spellcheck started — project=${scopeProject || '?'} / timeline=${scopeTimeline || '?'}`);

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
      await window.resultsAPI?.init(runId, 'spellcheck', 'Spellcheck', resultItems, {
        projectName:  scopeProject  || null,
        timelineName: scopeTimeline || null
      }).catch(() => {});
      setActiveResultJobId(runId);

    }).catch((err) => appendLog(`Spellcheck error: ${err?.error || err}`));
  }, [appendLog, project, timeline]);

  const handleSaveSettings = React.useCallback(() => {
    if (!window.electronAPI?.updatePreferences) return;
    window.electronAPI.updatePreferences({
      displayName: settingsDraft.displayName,
      lposBaseUrl: settingsDraft.lposUrl,
      atemFtpHost: settingsDraft.atemHost
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
          description: 'Ingest footage from ATEM ISO Extreme SDI over FTP, organised by session and camera.',
          actionLabel: 'Browse ATEM',
          onClick: () => setAtemIngestOpen(true),
          requiresResolve: false,
          comingSoon: false
        },
        // B2 Backup Manager task card removed 2026-05-27 — see LPOS /settings/storage.
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
        },
        {
          // Phase 5c.4 (2026-06-02): Frame.io comments → Resolve markers.
          // Matches the current Resolve project to its LPOS counterpart by
          // name, then fans across every editpanel-uploaded timeline,
          // placing Red markers for unresolved comments and removing
          // markers whose comments are now resolved upstream.
          key: 'pull-comments',
          label: 'Pull Comments',
          description: 'Fetch LPOS comments and place into project.',
          actionLabel: 'Pull Comments',
          onClick: handlePullComments,
          requiresResolve: true
        }
      ]
    },
    '/deliver': {
      tasks: [
        {
          key: 'deliver-export',
          label: 'LP Base Export',
          description: 'Choose a destination, set up the render queue from the EXPORT bin, and start the export.',
          actionLabel: 'Set Up Export',
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
  }), [handleLPBaseExport, handleNewProjectBins, handleSpellcheck, handlePullComments]);

  const currentWorkspace = workspaceConfig[route];

  function renderStatusBar() {
    const runningJobs = dashboard.jobs.filter(j => j.state === 'running');
    const runningJob  = runningJobs[0] ?? null;
    const exportRendering = activeExport && activeExport.state === 'rendering';
    const exportUploading = activeExport && activeExport.state === 'uploading';
    const exportQueued    = activeExport && activeExport.state === 'queued';
    const exportRunning = exportRendering || exportUploading;
    const showBusy = Boolean(runningJob) || exportRunning;
    const showAdvisory = Boolean(resolveAdvisory) &&
      !connected &&
      resolveAdvisory.code !== dismissedAdvisoryCode;

    return (
      <React.Fragment>
        {/* Sticky Resolve advisory banner — sits just above the status bar.
            Surfaces actionable failure modes (external scripting disabled,
            crash loop) that would otherwise only appear as WORKER_UNAVAILABLE
            scrolling past in the console. */}
        {showAdvisory && (
          <div className="resolve-advisory" role="alert">
            <div className="resolve-advisory-icon" aria-hidden="true">⚠</div>
            <div className="resolve-advisory-body">
              <div className="resolve-advisory-title">{resolveAdvisory.title}</div>
              <div className="resolve-advisory-text">{resolveAdvisory.body}</div>
              {resolveAdvisory.hint && (
                <div className="resolve-advisory-hint">{resolveAdvisory.hint}</div>
              )}
            </div>
            <div className="resolve-advisory-actions">
              <button
                type="button"
                className="resolve-advisory-btn primary"
                onClick={handleConnect}
              >
                Reconnect
              </button>
              <button
                type="button"
                className="resolve-advisory-btn"
                onClick={() => setDismissedAdvisoryCode(resolveAdvisory.code)}
                title="Hide until the next advisory"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Floating Jobs pill — bottom-right, above status bar */}
        <div className="floating-jobs-area">
          <button
            className={`floating-jobs-btn${showBusy ? ' running' : ''}`}
            onClick={() => setJobPanelOpen(prev => !prev)}
          >
            {showBusy && <span className="status-bar-spinner" />}
            <span className="floating-jobs-label">
              {exportUploading
                ? `Upload ${activeExport.uploadPercent ?? 0}%`
                : exportRendering
                ? `Export ${activeExport.percent}%`
                : runningJob
                ? `${runningJob.preset_id || 'Job'}${runningJob.steps_total > 0 ? ` ${runningJob.steps_done}/${runningJob.steps_total}` : ''}`
                : exportQueued
                ? 'Export ready ▶'
                : 'Jobs'}
            </span>
          </button>
        </div>

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
              <button
                type="button"
                className="status-bar-chip bad status-bar-chip-btn"
                onClick={handleConnect}
                title="Click to retry Resolve connection"
              >
                Offline
              </button>
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

          {/* Right: Console toggle */}
          <div className="status-bar-right">
            <button
              type="button"
              className="status-bar-console-btn"
              onClick={() => setConsoleOpen(v => !v)}
            >
              {consoleOpen ? 'Hide' : 'Console'}
            </button>
          </div>
        </footer>
      </React.Fragment>
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

          {/* Phase 3.5 — Exports history on the Delivery page only. The divider
              button keeps the page silhouette unchanged when collapsed; expand
              to browse every render (editpanel-queued + reconciled orphans).
              focusToken lets the Jobs-tab pill (above) snap the panel open +
              filter to Unassigned in one motion. */}
          {route === '/deliver' && <ExportsPanel focusToken={exportsFocusToken} />}
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
                <p className="settings-hint">Save the URL before signing in. The token below is bound to whichever instance you sign in against.</p>
              </div>

              <div className="settings-field">
                <label className="settings-label">Sign-in</label>
                {epUserEmail ? (
                  <>
                    <p className="settings-hint" style={{ marginTop: 0 }}>
                      Signed in as <strong>{epUserEmail}</strong>
                      {epMachineName ? <> on <strong>{epMachineName}</strong></> : null}.
                      {' '}This machine has a long-lived token; revoke from LPOS Settings → Connected EditPanel devices.
                    </p>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={handleSignout}
                      style={{ marginTop: 8, alignSelf: 'flex-start' }}
                    >
                      Sign out of LPOS
                    </button>
                  </>
                ) : (
                  <>
                    <p className="settings-hint" style={{ marginTop: 0 }}>
                      Not signed in. Click below to open LPOS in your browser and approve this machine.
                    </p>
                    <button
                      type="button"
                      className="btn"
                      onClick={handleSigninStart}
                      disabled={signinBusy}
                      style={{ marginTop: 8, alignSelf: 'flex-start' }}
                    >
                      {signinBusy ? 'Waiting for browser…' : 'Sign in to LPOS'}
                    </button>
                  </>
                )}
                {signinMessage && (
                  <p className="settings-hint" style={{ marginTop: 8, color: 'var(--accent)' }}>
                    {signinMessage}
                  </p>
                )}
              </div>
            </section>

            <section className="panel settings-section">
              <div className="list-header">
                <p className="eyebrow">Ingest</p>
                <h2 className="section-title">ATEM</h2>
                <p className="section-copy">Connection settings for the ATEM ISO Extreme SDI FTP server.</p>
              </div>
              <div className="settings-field">
                <label className="settings-label" htmlFor="atem-host">FTP IP Address</label>
                <input
                  id="atem-host"
                  type="text"
                  className="settings-input"
                  placeholder="172.20.10.241"
                  value={settingsDraft.atemHost}
                  onChange={(e) => setSettingsDraft((prev) => ({ ...prev, atemHost: e.target.value }))}
                />
                <p className="settings-hint">The local IP address of the ATEM ISO Extreme SDI. Only needs changing if your network layout differs.</p>
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
        <button
          type="button"
          className="home-settings-btn"
          aria-label="Settings"
          onClick={() => navigateTo('/settings')}
        >
          <GearIcon />
        </button>
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
      {/* Thin drag strip at the top — lets the user move the frameless window.
          Kept below the overlay z-index so it never blocks overlay headers. */}
      <div className="window-drag-handle" aria-hidden="true" />
      <div key={route} className="page-enter">
        {pageContent}
      </div>
      {renderStatusBar()}
      <JobPanel
        open={jobPanelOpen}
        onClose={() => setJobPanelOpen(false)}
        dashboard={dashboard}
        activeExport={activeExport}
        exportVersion={exportVersion}
        onViewResults={(runId) => {
          setJobPanelOpen(false);
          setActiveResultJobId(runId);
        }}
        onReviewExports={() => {
          // Pill click: close Jobs, jump to Delivery, ask ExportsPanel to expand
          // + snap its filter to 'unassigned' via the focus token.
          setJobPanelOpen(false);
          navigateTo('/deliver');
          setExportsFocusToken(t => t + 1);
        }}
      />
      {activeResultJobId && (
        <ResultOverlay
          jobId={activeResultJobId}
          onClose={() => setActiveResultJobId(null)}
          resolveProject={project}
          resolveConnected={connected}
        />
      )}
      {atemIngestOpen && (
        <AtemIngestOverlay
          open={atemIngestOpen}
          onClose={() => setAtemIngestOpen(false)}
          atemHost={settingsDraft.atemHost || '172.20.10.241'}
          resolveConnected={connected}
          resolveProject={project}
          onLog={appendLog}
        />
      )}
      {exportOpen && (
        <ExportDeliverOverlay
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          connected={connected}
          resolveProject={project}
          lposReady={lposStatus === 'ok'}
          onLog={appendLog}
          onOpenJobs={() => { setExportOpen(false); setJobPanelOpen(true); }}
        />
      )}
      <SlideoutConsole log={log} open={consoleOpen} onToggle={setConsoleOpen} />
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
