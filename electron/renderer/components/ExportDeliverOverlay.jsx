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
  // Burn-in works by selecting a paired preset whose only difference is the
  // Deliver-page "Burn into video" subtitle setting (which the Resolve scripting
  // API can't toggle directly). The editor keeps matching pairs named
  // "<preset>" and "<preset> - Subtitles"; flipping the toggle just swaps which
  // name we queue with. One constant so the convention lives in a single place.
  const BURN_IN_SUFFIX = ' - Subtitles';

  // ── Stage ──────────────────────────────────────────────
  const [stage, setStage] = React.useState('configure'); // 'configure' | 'preflight' | 'confirm' | 'running' | 'done'

  // ── Configure state ────────────────────────────────────
  const [targetDir, setTargetDir]   = React.useState('');
  const [presetName, setPresetName] = React.useState(DEFAULT_PRESET);
  const [exportBin, setExportBin]   = React.useState(DEFAULT_BIN);
  // Off (default) = queue only, start from Jobs later. On = render immediately.
  const [autoStart, setAutoStart]   = React.useState(false);
  // Burn subtitles into the video by queuing the "<preset> - Subtitle" pair.
  const [burnIn, setBurnIn]         = React.useState(false);

  // ── Preset / bin dropdown sources ──────────────────────
  // Fetched from Resolve when the overlay opens (and we're connected). Empty
  // arrays mean "not loaded / not available" — the dropdown still renders the
  // persisted value as the sole option so the editor can always queue.
  const [presets, setPresets]               = React.useState([]);
  const [presetsLoading, setPresetsLoading] = React.useState(false);
  const [presetsError, setPresetsError]     = React.useState(null);
  const [bins, setBins]                     = React.useState([]);
  // Hierarchical view of `bins`: [{ path, name, depth }] so the dropdown can
  // indent sub-bins. Falls back to `bins` when list_media_bins is older/empty.
  const [binTree, setBinTree]               = React.useState([]);
  const [binsLoading, setBinsLoading]       = React.useState(false);
  const [binsError, setBinsError]           = React.useState(null);

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
  const [subtitleGaps, setSubtitleGaps] = React.useState([]); // matched timelines with no subtitle track (burn-in only)
  const [pendingStart, setPendingStart] = React.useState(true); // startRender flag held across the confirm step

  // Reset + seed from preferences when the overlay opens
  React.useEffect(() => {
    if (!open) return;
    setStage('configure');
    setUploadToLpos(false);
    setAutoStart(false);
    setBurnIn(false);
    setProjectsError(null);
    setBusy(false);
    setResult(null);
    setConflicts([]);
    setSubtitleGaps([]);
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

  // Fetch the current Resolve project's render-preset list and top-level bins
  // so the preset/bin pickers become dropdowns instead of free-text inputs.
  // Re-runs every time the overlay opens (cheap) so a freshly-added preset or
  // bin shows up without having to restart editpanel.
  //
  // Both fetches are best-effort — on disconnect / error we leave the
  // dropdown with just the persisted value as its sole option so the editor
  // can still queue. (Fail open: the actual lp_base_export call already errors
  // loudly if the preset or bin name doesn't exist in Resolve.)
  React.useEffect(() => {
    if (!open) return;
    if (!connected) {
      setPresets([]); setPresetsError(null); setPresetsLoading(false);
      setBins([]);    setBinTree([]);        setBinsError(null);    setBinsLoading(false);
      return;
    }
    let cancelled = false;

    setPresetsLoading(true);
    setPresetsError(null);
    window.leaderpassAPI.call('list_render_presets')
      .then((res) => {
        if (cancelled) return;
        setPresets(Array.isArray(res?.data?.presets) ? res.data.presets : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setPresets([]);
        setPresetsError(err?.error?.message || err?.error || err?.message || 'Could not load presets');
      })
      .finally(() => { if (!cancelled) setPresetsLoading(false); });

    setBinsLoading(true);
    setBinsError(null);
    window.leaderpassAPI.call('list_media_bins')
      .then((res) => {
        if (cancelled) return;
        setBins(Array.isArray(res?.data?.bins) ? res.data.bins : []);
        setBinTree(Array.isArray(res?.data?.bin_tree) ? res.data.bin_tree : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setBins([]); setBinTree([]);
        setBinsError(err?.error?.message || err?.error || err?.message || 'Could not load bins');
      })
      .finally(() => { if (!cancelled) setBinsLoading(false); });

    return () => { cancelled = true; };
  }, [open, connected]);

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

  // The burn-in counterpart for the currently-selected preset, and whether it
  // actually exists. When the preset list loaded and the pair is absent we know
  // burn-in can't work, so the toggle is disabled. When the list couldn't load
  // (offline / fetch error) we can't prove the pair is missing, so we fail open
  // and let the toggle through — lp_base_export logs loudly if the name is bad.
  const burnInPresetName = `${presetName}${BURN_IN_SUFFIX}`;
  const burnInAvailable  = presets.length === 0 || presets.includes(burnInPresetName);

  // If the selected preset has no burn-in pair, force the toggle back off so we
  // can never queue a burn-in export against a preset that can't deliver it.
  React.useEffect(() => {
    if (!burnInAvailable && burnIn) setBurnIn(false);
  }, [burnInAvailable, burnIn]);

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

  // Mirror LPOS's canonical-asset key (lib/store/canonical-asset-store.ts:
  // normalizeAssetKey + stripVersionSuffix) so the pre-export check flags the
  // same name collisions LPOS would version, e.g. "Episode 12" vs "Episode_12"
  // vs "Episode_12_v2". Version-stripping both sides errs toward flagging, which
  // is the safe default for an advisory heads-up.
  function canonicalKey(s) {
    const noExt = String(s || '').replace(/\.[^.]+$/, '');
    const norm = noExt
      .trim()
      .toUpperCase()
      .replace(/[_\s-]+/g, '_')
      .replace(/[^A-Z0-9_]/g, '');
    return norm.replace(/_?V\d+$/, '');
  }

  function computeConflicts(names, assets) {
    const existing = new Set();
    for (const a of (assets || [])) {
      if (a.originalFilename) existing.add(canonicalKey(a.originalFilename));
      if (a.name) existing.add(canonicalKey(a.name));
    }
    existing.delete('');
    return (names || []).filter(n => existing.has(canonicalKey(n)));
  }

  // Entry point for both footer buttons. When uploading to LPOS, run a
  // name-based pre-export check against the chosen project first; otherwise go
  // straight to the export.
  function beginExport(startRender) {
    // Run the pre-export check whenever there's something to verify: the LPOS
    // version-conflict check (upload) and/or the subtitle-track check (burn-in).
    if ((uploadToLpos && selectedProjectId) || burnIn) {
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
    const wantVersionCheck = uploadToLpos && selectedProjectId;
    try {
      const [pfRes, assetsRes] = await Promise.all([
        window.leaderpassAPI.call('export_preflight', { export_bin_name: exportBin }),
        wantVersionCheck ? window.lposAPI.listProjectAssets(selectedProjectId) : Promise.resolve(null)
      ]);
      const names          = pfRes?.data?.names || [];
      const subtitleTracks = pfRes?.data?.subtitle_tracks || {};

      const found = wantVersionCheck
        ? computeConflicts(names, (assetsRes?.ok ? (assetsRes.data?.assets || []) : []))
        : [];
      // Burn-in onto a timeline with no subtitle track silently produces an
      // uncaptioned video, so flag those timelines before queuing.
      const gaps = burnIn
        ? names.filter((n) => !(Number(subtitleTracks[n]) > 0))
        : [];

      if (found.length > 0 || gaps.length > 0) {
        setConflicts(found);
        setSubtitleGaps(gaps);
        setBusy(false);
        setStage('confirm');
        return;
      }
    } catch (err) {
      // Fail open — a flaky pre-check shouldn't block the export.
      const msg = err?.error?.message || err?.error || err?.message || String(err);
      onLog?.(`[export] Pre-export check skipped: ${msg}`);
    }
    setBusy(false);
    doStart(startRender);
  }

  async function doStart(startRender) {
    if (busy) return;
    setBusy(true);
    setStage('running');
    // When burning in, queue the paired "<preset> - Subtitle" preset instead.
    const effectivePreset = burnIn ? burnInPresetName : presetName;
    onLog?.(`[export] ${startRender ? 'Queue & render' : 'Queue'}${burnIn ? ' (burn-in subtitles)' : ''}${targetDir ? ` → ${targetDir}` : ' (preset location)'}…`);

    // Save selections for next time. Persist the BASE preset the editor picked,
    // not the burn-in variant — burn-in is a per-export toggle, not a default.
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
        presetName: effectivePreset,
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
        {/* Preset + bin — dropdowns sourced from Resolve when available. The
            persisted value always appears as an option even if the fetched
            list doesn't contain it (offline, fetch error, or a Resolve
            project that doesn't have that preset/bin yet) so the editor can
            still queue and lp_base_export will surface the actual mismatch. */}
        <div className="export-field-row">
          <div className="atem-dest-section" style={{ flex: 1 }}>
            <p className="atem-field-label">Render preset</p>
            <select
              className="settings-input"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              disabled={presetsLoading}
            >
              {(() => {
                const options = [...presets];
                if (presetName && !options.includes(presetName)) options.unshift(presetName);
                if (options.length === 0) options.push(DEFAULT_PRESET);
                return options.map((name) => (
                  <option key={name} value={name}>
                    {name}{!presets.includes(name) && presets.length > 0 ? ' (not in this project)' : ''}
                  </option>
                ));
              })()}
            </select>
            <p className="atem-dest-hint" style={{ marginTop: 6 }}>
              {presetsLoading
                ? 'Loading presets from Resolve…'
                : presetsError
                  ? `Couldn't load presets — using your last setting. (${presetsError})`
                  : presets.length === 0
                    ? 'No presets detected — using your last setting.'
                    : `${presets.length} preset${presets.length === 1 ? '' : 's'} from the current Resolve project.`}
            </p>
          </div>
          <div className="atem-dest-section" style={{ flex: 1 }}>
            <p className="atem-field-label">Export bin</p>
            <select
              className="settings-input"
              value={exportBin}
              onChange={(e) => setExportBin(e.target.value)}
              disabled={binsLoading}
            >
              {(() => {
                // Prefer the hierarchical tree (indented sub-bins); fall back
                // to the flat path list. `value` is always the full bin path.
                const tree = binTree.length
                  ? binTree
                  : bins.map((p) => ({ path: p, name: p, depth: 1 }));
                const paths = tree.map((b) => b.path);
                const options = [...tree];
                if (exportBin && !paths.includes(exportBin)) {
                  options.unshift({ path: exportBin, name: exportBin, depth: 1 });
                }
                if (options.length === 0) options.push({ path: DEFAULT_BIN, name: DEFAULT_BIN, depth: 1 });
                return options.map((b) => {
                  const indent = b.depth > 1 ? '   '.repeat(b.depth - 1) : '';
                  const missing = !paths.includes(b.path) && paths.length > 0;
                  return (
                    <option key={b.path} value={b.path}>
                      {indent}{b.name}{missing ? ' (not in this project)' : ''}
                    </option>
                  );
                });
              })()}
            </select>
            <p className="atem-dest-hint" style={{ marginTop: 6 }}>
              {binsLoading
                ? 'Loading bins from Resolve…'
                : binsError
                  ? `Couldn't load bins — using your last setting. (${binsError})`
                  : bins.length === 0
                    ? 'No bins detected — using your last setting.'
                    : `${bins.length} bin${bins.length === 1 ? '' : 's'} (incl. sub-bins) from the current Resolve project.`}
            </p>
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

        {/* Auto-start toggle */}
        <div className="atem-resolve-toggle">
          <div className="atem-resolve-toggle-inner">
            <div>
              <p className="atem-field-label">Start rendering automatically</p>
              <p className="atem-resolve-sub">
                {autoStart
                  ? 'The render begins as soon as the queue is built.'
                  : "Off: jobs are queued and you press Start in Jobs when you're ready."}
              </p>
            </div>
            <button
              type="button"
              className={`export-switch${autoStart ? ' on' : ''}`}
              role="switch"
              aria-checked={autoStart}
              onClick={() => setAutoStart(v => !v)}
            >
              <span className="export-switch-knob" />
            </button>
          </div>
        </div>

        {/* Burn-in subtitles toggle */}
        <div className={`atem-resolve-toggle${burnInAvailable ? '' : ' disabled'}`}>
          <div className="atem-resolve-toggle-inner">
            <div>
              <p className="atem-field-label">Burn in subtitles</p>
              <p className="atem-resolve-sub">
                {!burnInAvailable
                  ? `No "${burnInPresetName}" preset in this project — burn-in needs a matching pair.`
                  : burnIn
                    ? `Queues "${burnInPresetName}" so each timeline's subtitle track is baked into the video.`
                    : `Renders the subtitle track into the picture using the "${burnInPresetName}" preset.`}
              </p>
            </div>
            <button
              type="button"
              className={`export-switch${burnIn ? ' on' : ''}`}
              role="switch"
              aria-checked={burnIn}
              disabled={!burnInAvailable}
              onClick={() => setBurnIn(v => !v)}
            >
              <span className="export-switch-knob" />
            </button>
          </div>
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
        <span>
          {uploadToLpos && selectedProjectId
            ? `Checking ${selectedProject?.name || 'the project'} for existing versions…`
            : 'Checking timelines before export…'}
        </span>
      </div>
    );
  }

  function renderConfirm() {
    return (
      <div className="atem-configure">
        {/* Burn-in: timelines with no subtitle track would render uncaptioned. */}
        {subtitleGaps.length > 0 && (
          <>
            <div className="atem-summary-card">
              <p className="atem-summary-line">
                <strong>{subtitleGaps.length}</strong> of these {subtitleGaps.length === 1 ? 'timeline has' : 'timelines have'} no subtitle track
              </p>
              <p className="atem-summary-line">but burn-in is on</p>
            </div>
            <p className="atem-dest-hint" style={{ fontSize: '0.84rem', color: 'var(--text)' }}>
              With burn-in enabled, {subtitleGaps.length === 1 ? 'this timeline' : 'these timelines'} will render
              as <strong>uncaptioned video</strong> — there's no subtitle track to bake in. Add a subtitle track in
              Resolve first, or continue to render {subtitleGaps.length === 1 ? 'it' : 'them'} without captions.
            </p>
            <div className="atem-session-list export-project-list">
              {subtitleGaps.map((n) => (
                <div key={n} className="atem-session-row">
                  <div className="atem-session-info">
                    <span className="atem-session-name">{n}</span>
                    <span className="atem-session-meta">no subtitle track</span>
                  </div>
                  <span className="atem-coming-soon-badge" style={{ background: 'var(--accent-gold-soft, var(--accent-blue-soft))' }}>Uncaptioned</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* LPOS upload: name collisions become new versions. */}
        {conflicts.length > 0 && (
          <>
            <div className="atem-summary-card">
              <p className="atem-summary-line">
                <strong>{conflicts.length}</strong> of these already exist
              </p>
              <p className="atem-summary-line">in <strong>{selectedProject?.name || 'the project'}</strong></p>
            </div>
            <p className="atem-dest-hint" style={{ fontSize: '0.84rem', color: 'var(--text)' }}>
              These will upload as <strong>new versions</strong> of existing assets when their renders finish —
              continuing is your sign-off, so LPOS won't ask again. (Identical files are skipped.)
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
          </>
        )}

        <p className="export-lpos-note">
          This is a name match only — nothing has rendered or uploaded yet. Go back to adjust the preset, project, or toggles.
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
          <p className="atem-done-title">{result?.started ? 'Export started' : 'Queued'}</p>
          <p className="atem-done-sub">
            {result?.started
              ? `${jobs.length} timeline${jobs.length !== 1 ? 's' : ''} rendering in the background — track progress in Jobs.`
              : `${jobs.length} timeline${jobs.length !== 1 ? 's' : ''} queued — press Start in Jobs to begin rendering.`}
          </p>
          {burnIn && (
            <p className="atem-done-sub" style={{ marginTop: 4 }}>
              Subtitles are burned into the picture (<strong>{burnInPresetName}</strong>).
            </p>
          )}
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

        {result?.project && (
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
    <div className="result-overlay atem-overlay" role="dialog" aria-label="Export">
      {/* Header */}
      <header className="result-overlay-header">
        <button className="result-overlay-back" onClick={() => { if (!busy) onClose?.(); }} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <span className="result-overlay-title">Export</span>
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
          <button className="btn" disabled={!canRun} onClick={() => beginExport(autoStart)}>
            {autoStart ? 'Queue & Render' : 'Queue Export'}
          </button>
        )}
        {stage === 'confirm' && (
          <>
            <button className="btn-secondary" onClick={() => setStage('configure')}>Back</button>
            <button className="btn" onClick={() => doStart(pendingStart)}>
              {pendingStart ? 'Continue & Render' : 'Continue & Queue'}
            </button>
          </>
        )}
        {stage === 'done' && (() => {
          const tracked = result && !result.error && !result.warning;
          return (
            <>
              {tracked && onOpenJobs && (
                <button className="btn" onClick={onOpenJobs}>View in Jobs</button>
              )}
              <button className={tracked && onOpenJobs ? 'btn-secondary' : 'btn'} onClick={onClose}>
                Done
              </button>
            </>
          );
        })()}
      </footer>
    </div>
  );
}
