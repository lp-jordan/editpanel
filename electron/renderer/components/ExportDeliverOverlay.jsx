/**
 * ExportDeliverOverlay — destination picker for the LP Base Export.
 *
 * Stages: configure → (preflight → confirm) → running → done.
 *   configure: pick a target folder (pushed into Resolve as TargetDir),
 *              optionally toggle "Upload to LPOS" and choose a project.
 *   preflight/confirm: name-match check against the LPOS project and the
 *              burn-in subtitle check; confirm only shows when something hit.
 *   running:   queuing render jobs / starting the render.
 *   done:      names of the queued timelines + render-start state.
 *
 * Chrome uses the shared .tool-overlay family (header / body--form / footer).
 * UI copy follows the export glossary: Export / Exporting / Queued / Upload.
 * Raw errors go to onLog; the screen shows a plain one-line message.
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
  const [projectQuery, setProjectQuery]       = React.useState('');

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
    setProjectQuery('');
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
        const msg = err?.error?.message || err?.error || err?.message || 'Could not load presets';
        setPresetsError(msg);
        onLog?.(`[export] Couldn't load presets: ${msg}`);
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
        const msg = err?.error?.message || err?.error || err?.message || 'Could not load bins';
        setBinsError(msg);
        onLog?.(`[export] Couldn't load bins: ${msg}`);
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
    const q = projectQuery.trim().toLowerCase();
    const map = new Map();
    for (const p of projects) {
      if (p.archived) continue;
      const name   = (p.name || p.projectName || '').toLowerCase();
      const client = (p.clientName || '').toLowerCase();
      if (q && !name.includes(q) && !client.includes(q)) continue;
      const key = p.clientName || 'Unassigned';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [projects, projectQuery]);

  // Post-filter count — drives the "no matches" copy and the match tally.
  const filteredProjectCount = React.useMemo(
    () => groupedProjects.reduce((acc, [, list]) => acc + list.length, 0),
    [groupedProjects]
  );

  // Are there any non-archived projects at all (ignoring the search query)?
  // Lets us tell "nothing in LPOS" apart from "nothing matched your search".
  const hasAnyProjects = React.useMemo(
    () => projects.some((p) => !p.archived),
    [projects]
  );

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
        onLog?.(`[export] Couldn't load LPOS projects: ${res?.error || 'unknown error'}`);
      }
    } catch (err) {
      setProjectsError(err?.message || String(err));
      onLog?.(`[export] Couldn't load LPOS projects: ${err?.message || String(err)}`);
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
        onLog?.(`[export] Error: ${res?.error || 'Export failed to start'}`);
        setResult({ error: res?.error || 'Export failed to start' });
        setStage('done');
        return;
      }
      if (res.empty) {
        setResult({
          warning: `Nothing in the "${exportBin}" bin matches a timeline name.`
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

  // Loading / error hint under a Resolve-sourced dropdown. Nothing in the
  // normal case; the raw error is in the Console and the tooltip.
  function sourceHint(loading, error, noun) {
    if (loading) return <p className="hint">Loading {noun}…</p>;
    if (error) {
      return (
        <p className="hint" title={String(error)}>
          Couldn't load {noun} from Resolve. Using your last setting.
        </p>
      );
    }
    return null;
  }

  function renderConfigure() {
    return (
      <div className="export-form">
        {/* Preset + bin — dropdowns sourced from Resolve when available. The
            persisted value always appears as an option even if the fetched
            list doesn't contain it (offline, fetch error, or a Resolve
            project that doesn't have that preset/bin yet) so the editor can
            still queue and lp_base_export will surface the actual mismatch. */}
        <div className="export-field-row">
          <div className="export-field" style={{ flex: 1 }}>
            <p className="export-field-label">Preset</p>
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
            {sourceHint(presetsLoading, presetsError, 'presets')}
          </div>
          <div className="export-field" style={{ flex: 1 }}>
            <p className="export-field-label">Export bin</p>
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
                  const indent = b.depth > 1 ? '   '.repeat(b.depth - 1) : '';
                  const missing = !paths.includes(b.path) && paths.length > 0;
                  return (
                    <option key={b.path} value={b.path}>
                      {indent}{b.name}{missing ? ' (not in this project)' : ''}
                    </option>
                  );
                });
              })()}
            </select>
            {sourceHint(binsLoading, binsError, 'bins')}
          </div>
        </div>

        {/* Destination folder (written into Resolve's TargetDir per timeline;
            empty keeps the preset's own location). */}
        <div className="export-field">
          <p className="export-field-label">Destination folder</p>
          <div className="export-dest-row">
            <span className={`export-dest-path${targetDir ? '' : ' placeholder'}`} title={targetDir || undefined}>
              {targetDir || "Preset's saved location"}
            </span>
            {targetDir && (
              <button
                type="button"
                className="btn ghost small"
                onClick={() => { setTargetDir(''); persistPrefs({ lastExportDir: '' }); }}
                title="Use the preset's saved location"
              >
                Clear
              </button>
            )}
            <button type="button" className="btn ghost small" onClick={handlePickFolder}>Choose…</button>
          </div>
        </div>

        {/* Auto-start toggle */}
        <div className="export-toggle">
          <div className="export-toggle-inner">
            <div>
              <p className="export-field-label">Start exporting right away</p>
              <p className="export-toggle-sub">When off, start it from Jobs.</p>
            </div>
            <button
              type="button"
              className={`export-switch${autoStart ? ' on' : ''}`}
              role="switch"
              aria-checked={autoStart}
              aria-label="Start exporting right away"
              onClick={() => setAutoStart(v => !v)}
            >
              <span className="export-switch-knob" />
            </button>
          </div>
        </div>

        {/* Burn-in subtitles toggle (swaps to the "<preset> - Subtitles" pair) */}
        <div className={`export-toggle${burnInAvailable ? '' : ' disabled'}`}>
          <div className="export-toggle-inner">
            <div>
              <p className="export-field-label">Burn in subtitles</p>
              {!burnInAvailable && (
                <p className="export-toggle-sub">No "{burnInPresetName}" preset in this project.</p>
              )}
            </div>
            <button
              type="button"
              className={`export-switch${burnIn ? ' on' : ''}`}
              role="switch"
              aria-checked={burnIn}
              aria-label="Burn in subtitles"
              disabled={!burnInAvailable}
              onClick={() => setBurnIn(v => !v)}
            >
              <span className="export-switch-knob" />
            </button>
          </div>
        </div>

        {/* Upload-to-LPOS toggle */}
        <div className={`export-toggle${lposReady ? '' : ' disabled'}`}>
          <div className="export-toggle-inner">
            <div>
              <p className="export-field-label">Upload to LPOS when done</p>
              {!lposReady && (
                <p className="export-toggle-sub">Sign in to LPOS in Settings to turn this on.</p>
              )}
            </div>
            <button
              type="button"
              className={`export-switch${uploadToLpos ? ' on' : ''}`}
              role="switch"
              aria-checked={uploadToLpos}
              aria-label="Upload to LPOS when done"
              disabled={!lposReady}
              onClick={handleToggleUpload}
            >
              <span className="export-switch-knob" />
            </button>
          </div>

          {uploadToLpos && (
            <div className="export-project-area">
              {projectsLoading && (
                <div className="export-loading">
                  <span className="spinner" />
                  <span>Loading projects…</span>
                </div>
              )}
              {projectsError && (
                <div className="notice error" title={String(projectsError)}>
                  <span>Couldn't load LPOS projects.</span>
                  <button type="button" className="btn ghost small notice-action" onClick={loadProjects}>
                    Try again
                  </button>
                </div>
              )}
              {!projectsLoading && !projectsError && !hasAnyProjects && (
                <p className="hint">No projects in LPOS.</p>
              )}
              {!projectsLoading && !projectsError && hasAnyProjects && (
                <div className="export-project-search">
                  <input
                    type="search"
                    className="export-project-search-input"
                    placeholder="Search projects or clients…"
                    value={projectQuery}
                    onChange={(e) => setProjectQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' && projectQuery) {
                        e.preventDefault();
                        e.stopPropagation();
                        setProjectQuery('');
                      }
                    }}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  {projectQuery && (
                    <span className="export-project-search-meta">
                      {filteredProjectCount} match{filteredProjectCount !== 1 ? 'es' : ''}
                    </span>
                  )}
                </div>
              )}
              {!projectsLoading && !projectsError && hasAnyProjects && filteredProjectCount === 0 && (
                <p className="hint">No projects match “{projectQuery.trim()}”.</p>
              )}
              {!projectsLoading && !projectsError && groupedProjects.length > 0 && (
                <div className="export-project-list">
                  {groupedProjects.map(([client, list]) => (
                    <div key={client} className="export-project-group">
                      <p className="export-client-name">{client}</p>
                      {list.map((p) => (
                        <label
                          key={p.projectId}
                          className={`export-project-row${selectedProjectId === p.projectId ? ' selected' : ''}`}
                        >
                          <input
                            type="radio"
                            name="lpos-project"
                            className="export-project-radio"
                            checked={selectedProjectId === p.projectId}
                            onChange={() => setSelectedProjectId(p.projectId)}
                          />
                          <span className="export-project-row-name">{p.name}</span>
                          {p.phase && <span className="export-project-row-meta">{p.phase}</span>}
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderRunning() {
    return (
      <div className="export-loading export-loading--stage">
        <span className="spinner" />
        <span>Setting up the export…</span>
      </div>
    );
  }

  function renderPreflight() {
    return (
      <div className="export-loading export-loading--stage">
        <span className="spinner" />
        <span>
          {uploadToLpos && selectedProjectId
            ? `Checking ${selectedProject?.name || 'the project'} for existing versions…`
            : 'Checking timelines…'}
        </span>
      </div>
    );
  }

  // Pre-export warning: per issue one heading, one sentence, names only.
  function renderConfirm() {
    return (
      <div className="export-form">
        {/* Burn-in: timelines with no subtitle track would export uncaptioned. */}
        {subtitleGaps.length > 0 && (
          <section className="export-check">
            <h3 className="export-check-title">
              {subtitleGaps.length === 1
                ? '1 timeline has no subtitles'
                : `${subtitleGaps.length} timelines have no subtitles`}
            </h3>
            <p className="export-check-text">
              Burn-in is on, so {subtitleGaps.length === 1 ? 'it' : 'they'} will export without captions.
              Add a subtitle track in Resolve, or export anyway.
            </p>
            <ul className="export-name-list">
              {subtitleGaps.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </section>
        )}

        {/* LPOS upload: name collisions become new versions. */}
        {conflicts.length > 0 && (
          <section className="export-check">
            <h3 className="export-check-title">
              {conflicts.length === 1 ? '1 timeline is' : `${conflicts.length} timelines are`} already
              in {selectedProject?.name || 'the project'}
            </h3>
            <p className="export-check-text">
              {conflicts.length === 1 ? 'It' : 'They'} will upload as a new version.
            </p>
            <ul className="export-name-list">
              {conflicts.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </section>
        )}
      </div>
    );
  }

  function renderDone() {
    if (result?.error) {
      return (
        <div className="notice error" title={String(result.error)}>
          <span>Couldn't start the export. Details are in the Console.</span>
        </div>
      );
    }
    if (result?.warning) {
      return (
        <div className="export-done">
          <p className="export-done-title">Nothing to export</p>
          <p className="export-done-sub">{result.warning}</p>
        </div>
      );
    }
    const jobs = result?.jobs || [];
    const n = jobs.length;
    const noun = `${n} timeline${n !== 1 ? 's' : ''}`;
    return (
      <div className="export-form">
        <div className="export-done">
          <p className="export-done-title">{result?.started ? 'Exporting' : 'Queued'}</p>
          <p className="export-done-sub">
            {result?.started
              ? `${noun} exporting. Track progress in Jobs.`
              : `${noun} queued. Start ${n === 1 ? 'it' : 'them'} from Jobs.`}
          </p>
          {burnIn && (
            <p className="export-done-sub">Subtitles are burned in.</p>
          )}
          {result?.project && (
            <p className="export-done-sub">
              Each file uploads to <strong>{result.project.name}</strong> when it's done.
            </p>
          )}
        </div>

        {result?.targetDir && (
          <div className="export-field">
            <p className="export-field-label">Destination</p>
            <div className="export-dest-row">
              <span className="export-dest-path" title={result.targetDir}>{result.targetDir}</span>
            </div>
          </div>
        )}

        {n > 0 && (
          <ul className="export-name-list">
            {jobs.map((job, i) => {
              const name = Array.isArray(job) ? job[0] : (job?.name || job);
              return <li key={i}>{typeof name === 'string' && name ? name : 'Untitled timeline'}</li>;
            })}
          </ul>
        )}
      </div>
    );
  }

  if (!open) return null;

  const canRun = connected && !busy;

  return (
    <div className="tool-overlay export-overlay" role="dialog" aria-label="Export">
      <header className="tool-header">
        <h2 className="tool-title">Export</h2>
        {resolveProject && <span className="tool-subtitle">{resolveProject}</span>}
        <button
          type="button"
          className="tool-close"
          onClick={() => { if (!busy) onClose?.(); }}
          disabled={busy}
          aria-label="Close"
          title="Close"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <div className="tool-body tool-body--form">
        {!connected && stage === 'configure' && (
          <div className="notice error"><span>Resolve not connected.</span></div>
        )}
        {stage === 'configure' && renderConfigure()}
        {stage === 'preflight' && renderPreflight()}
        {stage === 'confirm'   && renderConfirm()}
        {stage === 'running'   && renderRunning()}
        {stage === 'done'      && renderDone()}
      </div>

      <footer className="tool-footer tool-footer--form">
        {(stage === 'configure' || stage === 'preflight' || stage === 'running') && (
          <button
            className="btn primary"
            disabled={!canRun || stage !== 'configure'}
            onClick={() => beginExport(autoStart)}
          >
            Export
          </button>
        )}
        {stage === 'confirm' && (
          <>
            <button className="btn ghost" onClick={() => setStage('configure')}>Back</button>
            <button className="btn primary" onClick={() => doStart(pendingStart)}>
              Export anyway
            </button>
          </>
        )}
        {stage === 'done' && (() => {
          const tracked = result && !result.error && !result.warning;
          return (
            <>
              <button className={tracked && onOpenJobs ? 'btn ghost' : 'btn primary'} onClick={onClose}>
                Done
              </button>
              {tracked && onOpenJobs && (
                <button className="btn primary" onClick={onOpenJobs}>View in Jobs</button>
              )}
            </>
          );
        })()}
      </footer>
    </div>
  );
}
