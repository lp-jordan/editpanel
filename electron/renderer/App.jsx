function App() {
  const [project, setProject] = React.useState('');
  const [timeline, setTimeline] = React.useState('');
  const [log, setLog] = React.useState([]);
  const [connected, setConnected] = React.useState(false);
  const [consoleOpen, setConsoleOpen] = React.useState(false);
  const [currentCategory, setCurrentCategory] = React.useState(null);
  const [spellReport, setSpellReport] = React.useState([]);
  const [spellTotals, setSpellTotals] = React.useState({ items: 0, words: 0, issues: 0, ignored: 0 });
  const [spellHistory, setSpellHistory] = React.useState([]);
  const [workerAvailability, setWorkerAvailability] = React.useState({ resolve: true, media: true, platform: true });

  const [recipes, setRecipes] = React.useState([]);
  const [recipeLaunchBusy, setRecipeLaunchBusy] = React.useState(false);
  const [selectedRecipeId, setSelectedRecipeId] = React.useState('');
  const [recipeInputValues, setRecipeInputValues] = React.useState({});

  const [dashboard, setDashboard] = React.useState({ jobs: [], logs_by_job_step: {} });
  const [preferences, setPreferences] = React.useState({
    recipe_defaults: {},
    worker_concurrency: { resolve: 1, media: 2, platform: 2 }
  });

  const appendLog = React.useCallback(msg => {
    setLog(prev => [...prev, msg].slice(-50));
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

    const unsubscribeStatus = window.electronAPI.onHelperStatus(status => {
      if (status?.code === 'WORKER_AVAILABLE' || status?.code === 'WORKER_UNAVAILABLE') {
        setWorkerAvailability(prev => ({ ...prev, [status?.worker || 'resolve']: Boolean(status.ok) }));
      }

      if (status?.worker && status.worker !== 'resolve' && status.code !== 'CONNECTED') return;

      appendLog(`Status: ${status.code}${status.error ? ` - ${status.error}` : ''}`);
      if (status.code === 'CONNECTED' && status.ok) {
        setConnected(true);
        if (status.data?.project) setProject(status.data.project);
        if (status.data?.timeline) setTimeline(status.data.timeline);
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

    const unsubscribeJobEvents = window.electronAPI.onJobEvent(() => {
      window.electronAPI.dashboardSnapshot()
        .then(result => setDashboard(result?.data || { jobs: [], logs_by_job_step: {} }))
        .catch(() => null);
    });

    return () => {
      unsubscribeStatus && unsubscribeStatus();
      unsubscribeMessage && unsubscribeMessage();
      unsubscribeJobEvents && unsubscribeJobEvents();
    };
  }, [appendLog]);

  React.useEffect(() => {
    if (!window.electronAPI) return;

    Promise.all([
      window.electronAPI.listRecipes(),
      window.electronAPI.dashboardSnapshot(),
      window.electronAPI.getPreferences()
    ])
      .then(([recipeResult, dashboardResult, preferenceResult]) => {
        const catalog = Array.isArray(recipeResult?.data) ? recipeResult.data : [];
        setRecipes(catalog);
        if (catalog.length > 0) {
          setSelectedRecipeId(current => current || catalog[0].id);
        }
        setDashboard(dashboardResult?.data || { jobs: [], logs_by_job_step: {} });
        setPreferences(preferenceResult?.data || {
          recipe_defaults: {},
          worker_concurrency: { resolve: 1, media: 2, platform: 2 }
        });
      })
      .catch(err => appendLog(`Bootstrap error: ${err?.error || err?.message || err}`));
  }, [appendLog]);

  React.useEffect(() => {
    const timer = setInterval(() => {
      if (!window.electronAPI?.dashboardSnapshot) return;
      window.electronAPI.dashboardSnapshot()
        .then(result => setDashboard(result?.data || { jobs: [], logs_by_job_step: {} }))
        .catch(() => null);
    }, 2000);

    return () => clearInterval(timer);
  }, []);

  React.useEffect(() => {
    if (!selectedRecipeId) {
      setRecipeInputValues({});
      return;
    }
    const selectedRecipe = recipes.find(recipe => recipe.id === selectedRecipeId);
    if (!selectedRecipe) return;

    const defaultFromRecipe = selectedRecipe.defaults || {};
    const defaultFromPrefs = preferences.recipe_defaults?.[selectedRecipeId] || {};
    setRecipeInputValues({ ...defaultFromRecipe, ...defaultFromPrefs });
  }, [recipes, preferences, selectedRecipeId]);

  const logAction = action => appendLog(`${action} clicked`);

  const cacheSpellcheck = () => {
    if (spellReport.length || spellTotals.items || spellTotals.words || spellTotals.issues || spellTotals.ignored) {
      setSpellHistory(prev => [...prev, { report: spellReport, totals: spellTotals, timestamp: Date.now() }]);
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
    window.leaderpassAPI.call('connect').then(() => appendLog('Connect success')).catch(err => appendLog(`Connect error: ${err?.error || err}`));
  };

  const handleNewProjectBins = () => {
    cacheSpellcheck();
    if (!window.leaderpassAPI) return appendLog('Leaderpass API not available; cannot create project bins');
    window.leaderpassAPI.call('create_project_bins').then(() => appendLog('Project bin creation command sent')).catch(err => appendLog(`Project bin creation error: ${err?.error || err}`));
  };

  const handleLPBaseExport = () => {
    cacheSpellcheck();
    if (!window.leaderpassAPI) return appendLog('Leaderpass API not available; cannot export LP Base');
    window.leaderpassAPI.call('lp_base_export').then(() => appendLog('LP Base Export command sent')).catch(err => appendLog(`LP Base Export error: ${err?.error || err}`));
  };

  const handleSpellcheck = () => {
    cacheSpellcheck();
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
        const result = misspell ? await misspell(entry.text) : { words: entry.text.split(/\W+/).filter(Boolean).length, misspelled: [], ignored: 0 };
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
  };

  const selectedRecipe = React.useMemo(
    () => recipes.find(recipe => recipe.id === selectedRecipeId) || null,
    [recipes, selectedRecipeId]
  );

  const handleRecipeInputChange = React.useCallback((key, value) => {
    setRecipeInputValues(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleLaunchRecipe = React.useCallback(async () => {
    if (!window.electronAPI?.launchRecipe || !selectedRecipe) return;
    try {
      setRecipeLaunchBusy(true);
      const result = await window.electronAPI.launchRecipe(selectedRecipe.id, recipeInputValues);
      appendLog(`Recipe launched: ${selectedRecipe.id} (job ${result?.data?.job_id || 'unknown'})`);
      const snap = await window.electronAPI.dashboardSnapshot();
      setDashboard(snap?.data || { jobs: [], logs_by_job_step: {} });
    } catch (err) {
      appendLog(`Recipe launch error: ${err?.error || err?.message || err}`);
    } finally {
      setRecipeLaunchBusy(false);
    }
  }, [appendLog, recipeInputValues, selectedRecipe]);

  const handlePersistRecipeDefaults = React.useCallback(async () => {
    if (!selectedRecipe?.id || !window.electronAPI?.updatePreferences) return;
    try {
      const result = await window.electronAPI.updatePreferences({
        recipe_defaults: {
          [selectedRecipe.id]: recipeInputValues
        }
      });
      setPreferences(result?.data || preferences);
      appendLog(`Saved defaults for ${selectedRecipe.id}`);
    } catch (err) {
      appendLog(`Save defaults error: ${err?.error || err?.message || err}`);
    }
  }, [appendLog, preferences, recipeInputValues, selectedRecipe]);

  const handleConcurrencyChange = React.useCallback(async (worker, value) => {
    if (!window.electronAPI?.updatePreferences) return;
    const parsed = Math.max(1, Number(value || 1));
    try {
      const result = await window.electronAPI.updatePreferences({
        worker_concurrency: {
          ...preferences.worker_concurrency,
          [worker]: parsed
        }
      });
      setPreferences(result?.data || preferences);
      appendLog(`Updated ${worker} concurrency to ${parsed}`);
    } catch (err) {
      appendLog(`Concurrency update error: ${err?.error || err?.message || err}`);
    }
  }, [appendLog, preferences]);

  const handleJobCancel = React.useCallback(async jobId => {
    try {
      await window.electronAPI.cancelJob(jobId);
      appendLog(`Cancel requested for ${jobId}`);
      const snap = await window.electronAPI.dashboardSnapshot();
      setDashboard(snap?.data || { jobs: [], logs_by_job_step: {} });
    } catch (err) {
      appendLog(`Cancel job error: ${err?.error || err?.message || err}`);
    }
  }, [appendLog]);

  const handleJobRetry = React.useCallback(async jobId => {
    try {
      await window.electronAPI.retryJob(jobId);
      appendLog(`Retry requested for ${jobId}`);
      const snap = await window.electronAPI.dashboardSnapshot();
      setDashboard(snap?.data || { jobs: [], logs_by_job_step: {} });
    } catch (err) {
      appendLog(`Retry job error: ${err?.error || err?.message || err}`);
    }
  }, [appendLog]);

  const categories = ['SETUP', 'EDIT', 'AUDIO', 'DELIVER'];
  const actions = {
    SETUP: [{ label: 'New Project Bins', icon: '🗂️', onClick: handleNewProjectBins, resolveRequired: true }],
    EDIT: [{ label: 'Spellcheck', icon: '📝', onClick: handleSpellcheck, resolveRequired: true }],
    AUDIO: [{ label: 'Launch Transcribe Recipe', icon: '🎙️', onClick: () => { setCurrentCategory(null); logAction('Use dashboard launch'); } }],
    DELIVER: [{ label: 'LP Base Export', icon: '📤', onClick: handleLPBaseExport, resolveRequired: true }]
  };

  return (
    <div className="app-container" style={{ paddingBottom: consoleOpen ? '240px' : '40px' }}>
      <header>{project || 'No Project'}</header>
      <div className="connect-container" style={{ justifyContent: 'flex-start', gap: 8 }}>
        <button className="connect-button" onClick={handleConnect} disabled={!window.leaderpassAPI}>Connect</button>
        <span>Resolve status: {connected ? 'Connected' : 'Disconnected'}</span>
      </div>

      {currentCategory === null ? (
        <div className="function-grid folder-grid">
          {categories.map(cat => (
            <button key={cat} className="folder-button" onClick={() => setCurrentCategory(cat)}>{cat}</button>
          ))}
        </div>
      ) : (
        <div className="category-view">
          <button className="back-button" onClick={() => { cacheSpellcheck(); setCurrentCategory(null); }}>Back</button>
          <div className="function-grid">
            {actions[currentCategory].map(action => {
              const disabled = (action.resolveRequired && !connected);
              return (
                <button key={action.label} className="task-button" onClick={action.onClick} disabled={disabled}>
                  <span className="icon">{action.icon}</span>
                  <span>{action.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="dashboard">
        <h2>Dashboard</h2>
        <div>Active Timeline: {timeline || 'None'}</div>

        <div className="dashboard-grid">
          <div className="panel-block">
            <h3>Recipe Launch</h3>
            <select value={selectedRecipeId} onChange={event => setSelectedRecipeId(event.target.value)} disabled={recipeLaunchBusy || recipes.length === 0}>
              {recipes.map(recipe => <option key={recipe.id} value={recipe.id}>{recipe.id} (v{recipe.version})</option>)}
            </select>
            <button onClick={handleLaunchRecipe} disabled={!selectedRecipe || recipeLaunchBusy} style={{ marginLeft: 8 }}>{recipeLaunchBusy ? 'Launching…' : 'Launch Recipe'}</button>
            {selectedRecipe ? (
              <div>
                {Object.entries(selectedRecipe.inputs || {}).map(([key, definition]) => {
                  const type = definition?.type || 'string';
                  const value = recipeInputValues[key];
                  const displayValue = (type === 'object' || type === 'array') ? (typeof value === 'string' ? value : JSON.stringify(value ?? (type === 'array' ? [] : {}))) : (value ?? '');
                  return (
                    <div key={key} style={{ marginTop: 6 }}>
                      <label>{key} ({type})</label>
                      <input type="text" value={displayValue} onChange={event => handleRecipeInputChange(key, event.target.value)} />
                    </div>
                  );
                })}
                <button onClick={handlePersistRecipeDefaults} style={{ marginTop: 8 }}>Save as default profile</button>
              </div>
            ) : <div>No recipes available.</div>}
          </div>

          <div className="panel-block">
            <h3>Worker Preferences</h3>
            {['resolve', 'media', 'platform'].map(worker => (
              <div key={worker} style={{ marginTop: 6 }}>
                <label>{worker} concurrency</label>
                <input
                  type="number"
                  min="1"
                  value={preferences.worker_concurrency?.[worker] || 1}
                  onChange={event => handleConcurrencyChange(worker, event.target.value)}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="panel-block" style={{ marginTop: 12 }}>
          <h3>Jobs</h3>
          {(dashboard.jobs || []).length === 0 ? <div>No jobs yet.</div> : (
            <table className="jobs-table">
              <thead>
                <tr>
                  <th>Job</th><th>State</th><th>Active Step</th><th>ETA</th><th>Controls</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.jobs.map(job => (
                  <tr key={job.job_id}>
                    <td>{job.job_id}</td>
                    <td>{job.state}</td>
                    <td>{job.active_step ? `${job.active_step.step_id} (${job.active_step.worker})` : '—'}</td>
                    <td>{formatDuration(job.eta_ms)}</td>
                    <td>
                      <button onClick={() => handleJobRetry(job.job_id)}>Retry</button>
                      <button onClick={() => handleJobCancel(job.job_id)} style={{ marginLeft: 6 }}>Cancel</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel-block" style={{ marginTop: 12 }}>
          <h3>Job Logs (job_id + step_id)</h3>
          {(dashboard.jobs || []).slice(0, 3).map(job => {
            const stepLogs = dashboard.logs_by_job_step?.[job.job_id] || {};
            return (
              <div key={`logs-${job.job_id}`} style={{ marginBottom: 8 }}>
                <strong>{job.job_id}</strong>
                {Object.entries(stepLogs).map(([stepId, entries]) => (
                  <div key={`${job.job_id}-${stepId}`} style={{ marginLeft: 8 }}>
                    <div>{stepId}</div>
                    <ul>
                      {entries.slice(-3).map((entry, index) => (
                        <li key={`${stepId}-${index}`}>{entry.type}:{entry.state || entry.code || 'event'}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        <SpellcheckReport report={spellReport} totals={spellTotals} onLog={appendLog} />
      </div>

      <SlideoutConsole log={log} open={consoleOpen} onToggle={setConsoleOpen} />
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
