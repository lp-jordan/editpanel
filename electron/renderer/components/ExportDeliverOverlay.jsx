/**
 * ExportDeliverOverlay — destination picker for the LP Base Export.
 *
 * Stage 1 — configure: pick a target folder (pushed into Resolve as TargetDir),
 *                       optionally toggle "Upload to LPOS" and choose a project.
 * Stage 2 — running:   queuing render jobs / starting the render.
 * Stage 3 — done:      summary of queued jobs + render-start state.
 *
 * EditPanel owns the whole queue setup here: it matches the EXPORT bin to
 * timelines (lp_base_export), overrides the per-timeline destination via
 * SetRenderSettings(TargetDir/CustomName), then kicks off StartRendering.
 *
 * NOTE: the "Upload to LPOS" branch is UI-complete (project picker works via
 * window.lposAPI.listProjects) but the actual post-render upload pipeline is
 * the next phase — see docs. The chosen project is persisted as intent and the
 * summary makes the deferred behaviour explicit.
 *
 * Props:
 *   open            — boolean
 *   onClose         — () => void
 *   connected       — boolean (Resolve connection)
 *   resolveProject  — string
 *   lposReady       — boolean (signed in + reachable; gates the upload toggle)
 *   onLog           — (msg: string) => void
 *   onOpenJobs      — () => void  (close overlay + open the Jobs panel)
 */
function ExportDeliverOverlay({ open, onClose, connected, resolveProject, lposReady, onLog, onOpenJobs }) {
  const DEFAULT_PRESET = 'General LP Export';
  const DEFAULT_BIN = 'EXPORT';

  // ── Stage ──────────────────────────────────────────────
  const [stage, setStage] = React.useState('configure'); // 'configure' | 'preflight' | 'confirm' | 'running' | 'done'

  // ── Configure state ────────────────────────────────────
  const [targetDir, setTargetDir]   = React.useState('');
  const [presetName, setPresetName] = React.useState(DEFAULT_PRESET);
  const [exportBin, setExportBin]   = React.useState(DEFAULT_BIN);

  // ── Upload-to-LPOS state ───────────────────────────────
  const [uploadToLpos, setUploadToLpos]       = React.useState(false);
  const [projects, setProjects]               = React.useState([]);
  const [projectsLoaded, setProjectsLoaded]   = React.useState(false);
  const [projectsLoading, setProjectsLoading] = React.useState(false);
  const [projectsError, setProjectsError]     = React.useState(null);
  const [selectedProjectId, setSelectedProjectId] = React.useState('');

  // ── Run state ──────────────────────────────────────────
  const [busy, setBusy]     = React.useState(false);
  const [result, setResult] = React.useState(null); // { jobs, targetDir, started, project, warning, error }
  const [conflicts, setConflicts]     = React.useState([]);   // timeline names that already exist in the project
  const [pendingStart, setPendingStart] = React.useState(true); // startRender flag held across the confirm step

  // Reset + seed from preferences when the overlay opens
  React.useEffect(() => {
    if (!open) return;
    setStage('configure');
    setUploadToLpos(false);
    setProjectsError(null);
    setBusy(false);
    setResult(null);
    setConflicts([]);
    setPendingStart(true);

    if (!window.electronAPI?.getPreferences) {
      setTargetDir('');
      setPresetName(DEFAULT_PRESET);
      setExportBin(DEFAULT_BIN);
      setSelectedProjectId('');
      return;
    }
    window.electronAPI.getPreferences()
      .then((res) => {
        const prefs = res?.data || {};
        setTargetDir(prefs.lastExportDir || '');
        setPresetName(prefs.lastExportPreset || DEFAULT_PRESET);
        setExportBin(prefs.lastExportBin || DEFAULT_BIN);
        setSelectedProjectId(prefs.lastExportProjectId || '');
      })
      .catch(() => {
        setTargetDir('');
        setPresetName(DEFAULT_PRESET);
        setExportBin(DEFAULT_BIN);
      });
  }, [open]);

  // Escape-to-close (matches AtemIngestOverlay / ResultOverlay)
  React.useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onClose?.();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, busy]);

  // ── Helpers ─────────────────────────────────────────────

  function persistPrefs(patch) {
    if (!window.electronAPI?.updatePreferences) return;
    window.electronAPI.updatePreferences(patch).catch(() => {});
  }

  const groupedProjects = React.useMemo(() => {
    const map = new Map();
    for (const p of projects) {
      if (p.archived) continue;
      const client = p.clientName || 'Unassigned';
      if (!map.has(client)) map.set(client, []);
      map.get(client).push(p);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [projects]);

  const selectedProject = React.useMemo(
    () => projects.find((p) => p.projectId === selectedProjectId) || null,
    [projects, selectedProjectId]
  );

  // ── Actions ─────────────────────────────────────────────

  async function loadProjects() {
    if (!window.lposAPI?.listProjects) {
      setProjectsError('LPOS API unavailable');
      return;
    }
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const res = await window.lposAPI.listProjects();
      if (res?.ok) {
        setProjects(res.data?.projects || []);
        setProjectsLoaded(true);
      } else {
        setProjectsError(res?.error || 'Could not load projects');
      }
    } catch (err) {
      setProjectsError(err?.message || String(err));
    } finally {
      setProjectsLoading(false);
    }
  }

  function handleToggleUpload() {
    if (!lposReady) return;
    const next = !uploadToLpos;
    setUploadToLpos(next);
    if (next && !projectsLoaded && !projectsLoading) loadProjects();
  }

  async function handlePickFolder() {
    if (!window.dialogAPI) return;
    const res = await window.dialogAPI.pickFolder();
    if (!res.canceled && res.folderPath) {
      setTargetDir(res.folderPath);
      persistPrefs({ lastExportDir: res.folderPath });
    }
  }

  // Strip extension + normalise for a forgiving name comparison.
  function baseName(s) {
    return String(s || '').replace(/\.[^.]+$/, '').trim().toLowerCase();
  }

  function computeConflicts(names, assets) {
    const existing = new Set();
    for (const a of (assets || [])) {
      if (a.originalFilename) existing.add(baseName(a.originalFilename));
      if (a.name) existing.add(baseName(a.name));
    }
    return (names || []).filter(n => existing.has(baseName(n)));
  }

  // Entry point for both footer buttons. When uploading to LPOS, run a
  // name-based pre-export check against the chosen project first; otherwise go
  // straight to the export.
  function beginExport(startRender) {
    if (uploadToLpos && selectedProjectId) {
      runPreflight(startRender);
    } else {
      doStart(startRender);
    }
  }

  async function runPreflight(startRender) {
    if (busy) return;
    setBusy(true);
    setStage('preflight');
    setPendingStart(startRender);
    try {
      const [namesRes, assetsRes] = await Promise.all([
        window.leaderpassAPI.call('export_preflight', { export_bin_name: exportBin }),
        window.lposAPI.listProjectAssets(selectedProjectId)
      ]);
      const names  = namesRes?.data?.names || [];
      const assets = assetsRes?.ok ? (assetsRes.data?.assets || []) : [];
      const found  = computeConflicts(names, assets);
      if (found.length > 0) {
        setConflicts(found);
        setBusy(false);
        setStage('confirm');
        return;
      }
    } catch (err) {
      // Fail open — a flaky pre-check shouldn't block the export.
      const msg = err?.error?.message || err?.error || err?.message || String(err);
      onLog?.(`[export] Version pre-check skipped: ${msg}`);
    }
    setBusy(false);
    doStart(startRender);
  }

  async function doStart(startRender) {
    if (busy) return;
    setBusy(true);
    setStage('running');
    onLog?.(`[export] ${startRender ? 'Queue & render' : 'Queue'}${targetDir ? ` → ${targetDir}` : ' (preset location)'}…`);

    // Save selections for next time
    persistPrefs({
      lastExportDir: targetDir,
      lastExportPreset: presetName,
      lastExportBin: exportBin,
      ...(uploadToLpos && selectedProjectId ? { lastExportProjectId: selectedProjectId } : {})
    });

    try {
      // The main process owns the queue + render + status polling, so the
      // export keeps running (and reporting to the Jobs panel) even if this
      // overlay is closed.
      const res = await window.exportsAPI.start({
        targetDir: targetDir || undefined,
        presetName,
        exportBin,
        startRender,
        projectId:   uploadToLpos && selectedProjectId ? selectedProjectId : undefined,
        projectName: uploadToLpos && selectedProject  ? selectedProject.name : undefined
      });

      if (!res?.ok) {
        setResult({ error: res?.error || 'Export failed to start' });
        setStage('done');
        return;
      }
      if (res.empty) {
        setResult({
          warning: `No matching timelines found. Check that the "${exportBin}" bin contains clips whose names match your timelines.`
        });
        setStage('done');
        onLog?.('[export] No matching timelines for the EXPORT bin.');
        return;
      }

      const jobs = Array.isArray(res.jobs) ? res.jobs : [];
      onLog?.(`[export] Queued ${jobs.length} render job${jobs.length !== 1 ? 's' : ''}${res.started ? ' and started rendering.' : '.'}`);

      setResult({
        jobs,
        targetDir: targetDir || null,
        started: Boolean(res.started),
        project: uploadToLpos ? selectedProject : null
      });
      setStage('done');
    } catch (err) {
      const msg = err?.error?.message || err?.error || err?.message || String(err);
      onLog?.(`[export] Error: ${msg}`);
      setResult({ error: msg });
      setStage('done');
    } finally {
      setBusy(false);
    }
  }

  // ── Render stages ───────────────────────────────────────

  function renderConfigure() {
    return (
      <div className="atem-configure">
        {/* Preset + bin */}
        <div className="export-field-row">
          <div className="atem-dest-section" style={{ flex: 1 }}>
            <p className="atem-field-label">Render preset</p>
            <input
              className="settings-input"
              type="text"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder={DEFAULT_PRESET}
            />
          </div>
          <div className="atem-dest-section" style={{ flex: 1 }}>
            <p className="atem-field-label">Export bin</p>
            <input
              className="settings-input"
              type="text"
              value={exportBin}
              onChange={(e) => setExportBin(e.target.value)}
              placeholder={DEFAULT_BIN}
            />
          </div>
        </div>

        {/* Destination folder */}
        <div className="atem-dest-section">
          <p className="atem-field-label">Destination folder</p>
          <div className="atem-dest-row">
            <span className={`atem-dest-path${targetDir ? '' : ' placeholder'}`}>
              {targetDir || "Using preset's saved location"}
            </span>
            {targetDir && (
              <button className="export-clear-btn" onClick={() => { setTargetDir(''); persistPrefs({ lastExportDir: '' }); }} title="Clear">
                Clear
              </button>
            )}
            <button className="btn-secondary" onClick={handlePickFolder}>Choose…</button>
          </div>
          <p className="atem-dest-hint">
            EditPanel writes this into Resolve's render settings (TargetDir) for every matched timeline, named after the timeline. Leave empty to keep the preset's location.
          </p>
        </div>

        {/* Upload-to-LPOS toggle */}
        <div className={`atem-resolve-toggle${lposReady ? '' : ' disabled'}`}>
          <div className="atem-resolve-toggle-inner">
            <div>
              <p className="atem-field-label">Upload to LPOS on completion</p>
              <p className="atem-resolve-sub">
                {lposReady
                  ? 'Send the finished renders into an LPOS project.'
                  : 'Sign in to LPOS in Settings to enable.'}
              </p>
            </div>
            <button
              type="button"
              className={`export-switch${uploadToLpos ? ' on' : ''}`}
              role="switch"
              aria-checked={uploadToLpos}
              disabled={!lposReady}
              onClick={handleToggleUpload}
            >
              <span className="export-switch-knob" />
            </button>
          </div>

          {uploadToLpos && (
            <div className="export-project-area">
              {projectsLoading && (
                <div className="atem-loading">
                  <span className="status-bar-spinner" style={{ width: 14, height: 14 }} />
                  <span>Loading projects…</span>
                </div>
              )}
              {projectsError && <p className="atem-error">{projectsError}</p>}
              {!projectsLoading && !projectsError && groupedProjects.length === 0 && (
                <p className="atem-empty">No projects found in LPOS.</p>
              )}
              {!projectsLoading && !projectsError && groupedProjects.length > 0 && (
                <div className="atem-session-list export-project-list">
                  {groupedProjects.map(([client, list]) => (
                    <div key={client} className="export-project-group">
                      <p className="export-client-name">{client}</p>
                      {list.map((p) => (
                        <label
                          key={p.projectId}
                          className={`atem-session-row${selectedProjectId === p.projectId ? ' selected' : ''}`}
                        >
                          <input
                            type="radio"
                            name="lpos-project"
                            className="atem-session-checkbox"
                            checked={selectedProjectId === p.projectId}
                            onChange={() => setSelectedProjectId(p.projectId)}
                          />
                          <div className="atem-session-info">
                            <span className="atem-session-name">{p.name}</span>
                            {p.phase && <span className="atem-session-meta">{p.phase}</span>}
                          </div>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              <p className="export-lpos-note">
                When each render finishes, EditPanel uploads it into this LPOS project automatically. Watch progress in Jobs.
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderRunning() {
    return (
      <div className="atem-loading" style={{ padding: '32px 0' }}>
        <span className="status-bar-spinner" style={{ width: 18, height: 18 }} />
        <span>Setting up the render queue…</span>
      </div>
    );
  }

  function renderPreflight() {
    return (
      <div className="atem-loading" style={{ padding: '32px 0' }}>
        <span className="status-bar-spinner" style={{ width: 18, height: 18 }} />
        <span>Checking {selectedProject?.name || 'the project'} for existing versions…</span>
      </div>
    );
  }

  function renderConfirm() {
    return (
      <div className="atem-configure">
        <div className="atem-summary-card">
          <p className="atem-summary-line">
            <strong>{conflicts.length}</strong> of these already exist
          </p>
          <p className="atem-summary-line">in <strong>{selectedProject?.name || 'the project'}</strong></p>
        </div>
        <p className="atem-dest-hint" style={{ fontSize: '0.84rem', color: 'var(--text)' }}>
          These will upload as <strong>new versions</strong> of existing assets when their renders finish.
          LPOS makes the final call at upload time (new version, or skipped if identical).
        </p>
        <div className="atem-session-list export-project-list">
          {conflicts.map((n) => (
            <div key={n} className="atem-session-row">
              <div className="atem-session-info">
                <span className="atem-session-name">{n}</span>
                <span className="atem-session-meta">existing asset</span>
              </div>
              <span className="atem-coming-soon-badge" style={{ background: 'var(--accent-blue-soft)' }}>New version</span>
            </div>
          ))}
        </div>
        <p className="export-lpos-note">
          This is a name match only — nothing has rendered or uploaded yet. Continue to export anyway, or go back to change the project or toggle off upload.
        </p>
      </div>
    );
  }

  function renderDone() {
    if (result?.error) {
      return <p className="atem-error">Export failed: {result.error}</p>;
    }
    if (result?.warning) {
      return (
        <div className="atem-done-state">
          <p className="atem-done-title">Nothing queued</p>
          <p className="atem-done-sub">{result.warning}</p>
        </div>
      );
    }
    const jobs = result?.jobs || [];
    return (
      <div className="atem-progress-view">
        <div className="atem-done-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--success)' }}>
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <p className="atem-done-title">{result?.started ? 'Export started' : 'Jobs queued'}</p>
          <p className="atem-done-sub">
            {result?.started
              ? `${jobs.length} timeline${jobs.length !== 1 ? 's' : ''} rendering in the background — track progress in Jobs.`
              : `${jobs.length} timeline${jobs.length !== 1 ? 's' : ''} queued in Resolve (not started).`}
          </p>
        </div>

        {result?.targetDir && (
          <div className="atem-dest-section">
            <p className="atem-field-label">Destination</p>
            <div className="atem-dest-row">
              <span className="atem-dest-path">{result.targetDir}</span>
            </div>
          </div>
        )}

        {jobs.length > 0 && (
          <div className="atem-file-list">
            {jobs.map((job, i) => {
              const name = Array.isArray(job) ? job[0] : (job?.name || job);
              const id = Array.isArray(job) ? job[1] : (job?.job_id || job?.id || '');
              return (
                <div key={i} className="atem-file-row done">
                  <span className="atem-file-state-icon">✓</span>
                  <span className="atem-file-name">{name}</span>
                  {id && <span className="atem-file-cam">Job {id}</span>}
                </div>
              );
            })}
          </div>
        )}

        {result?.project && result?.started && (
          <p className="export-lpos-note">
            After rendering, each file uploads to <strong>{result.project.name}</strong> ({result.project.clientName || 'Unassigned'}) automatically — watch progress in Jobs.
          </p>
        )}
      </div>
    );
  }

  if (!open) return null;

  const canRun = connected && !busy;

  return (
    <div className="result-overlay atem-overlay" role="dialog" aria-label="LP Base Export">
      {/* Header */}
      <header className="result-overlay-header">
        <button className="result-overlay-back" onClick={() => { if (!busy) onClose?.(); }} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <span className="result-overlay-title">LP Base Export</span>
        <div className="atem-stage-pills">
          {['configure', 'running', 'done'].map((s, i) => (
            <span key={s} className={`atem-stage-pill${stage === s ? ' active' : ''}`}>{i + 1}</span>
          ))}
        </div>
      </header>

      {/* Body */}
      <div className="atem-overlay-body">
        {!connected && stage === 'configure' && (
          <p className="atem-error">Resolve is not connected — open your project first.</p>
        )}
        {stage === 'configure' && renderConfigure()}
        {stage === 'preflight' && renderPreflight()}
        {stage === 'confirm'   && renderConfirm()}
        {stage === 'running'   && renderRunning()}
        {stage === 'done'      && renderDone()}
      </div>

      {/* Footer */}
      <footer className="result-overlay-actions">
        {stage === 'configure' && (
          <>
            <button className="btn-secondary" disabled={!canRun} onClick={() => beginExport(false)}>
              Queue only
            </button>
            <button className="btn" disabled={!canRun} onClick={() => beginExport(true)}>
              Queue &amp; Render
            </button>
          </>
        )}
        {stage === 'confirm' && (
          <>
            <button className="btn-secondary" onClick={() => setStage('configure')}>Back</button>
            <button className="btn" onClick={() => doStart(pendingStart)}>
              {pendingStart ? 'Continue & Render' : 'Continue & Queue'}
            </button>
          </>
        )}
        {stage === 'done' && (
          <>
            {result?.started && onOpenJobs && (
              <button className="btn" onClick={onOpenJobs}>View in Jobs</button>
            )}
            <button className={result?.started && onOpenJobs ? 'btn-secondary' : 'btn'} onClick={onClose}>
              Done
            </button>
          </>
        )}
      </footer>
    </div>
  );
}
