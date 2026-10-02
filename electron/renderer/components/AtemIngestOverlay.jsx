/**
 * AtemIngestOverlay — three-stage ATEM footage ingest flow.
 *
 * Stage 1 — browse:   connect to ATEM FTP, list sessions, user selects which to pull
 * Stage 2 — configure: choose local destination folder, review summary, start
 * Stage 3 — progress:  live per-file progress; cancel; completion state
 *
 * Props:
 *   open           — boolean
 *   onClose        — () => void
 *   atemHost       — string (from preferences, default 172.20.10.241)
 *   resolveConnected — boolean (gates the Import-into-Resolve toggle)
 *   resolveProject   — string  (open project name, shown on the toggle)
 */
const IMPORT_DEFAULT_BIN = 'FOOTAGE / ATEM';

function AtemIngestOverlay({ open, onClose, atemHost, resolveConnected, resolveProject, onLog }) {
  const DEFAULT_HOST = atemHost || '172.20.10.241';

  // ── Stage ──────────────────────────────────────────────
  const [stage, setStage] = React.useState('browse'); // 'browse' | 'configure' | 'progress'

  // ── Browse state ───────────────────────────────────────
  const [host, setHost]         = React.useState(DEFAULT_HOST);
  const [connecting, setConnecting] = React.useState(false);
  const [sessions, setSessions] = React.useState([]);
  const [browseError, setBrowseError] = React.useState(null);
  const [selected, setSelected] = React.useState(new Set());
  const [ingestLogs, setIngestLogs] = React.useState([]); // prior ingest log records

  // ── Configure state ────────────────────────────────────
  const [destination, setDestination] = React.useState('');

  // ── Import-into-Resolve state ──────────────────────────
  const [importToResolve, setImportToResolve] = React.useState(false);
  const [importBin, setImportBin]   = React.useState(IMPORT_DEFAULT_BIN);
  const [bins, setBins]             = React.useState([]);
  const [binTree, setBinTree]       = React.useState([]);
  const [binsLoading, setBinsLoading] = React.useState(false);
  // Local paths + camera info accumulated as files land, so the post-ingest
  // import knows exactly what to pull into Resolve (survives event-handler
  // closures by living in a ref).
  const doneFilesRef = React.useRef([]);
  const [importState, setImportState]   = React.useState('idle'); // 'idle'|'running'|'done'|'error'
  const [importResult, setImportResult] = React.useState(null);   // { imported, failed }
  const [importError, setImportError]   = React.useState(null);

  // ── Progress state ─────────────────────────────────────
  const [progressItems, setProgressItems] = React.useState([]); // [{ session, file, state, camInfo }]
  const [currentProgress, setCurrentProgress] = React.useState(null);
  const [ingestDone, setIngestDone] = React.useState(false);
  const [ingestError, setIngestError] = React.useState(null);
  const [ingestCanceled, setIngestCanceled] = React.useState(false);
  const [canceling, setCanceling]   = React.useState(false);
  const [filesDone, setFilesDone]   = React.useState(0);
  const [filesTotal, setFilesTotal] = React.useState(0);

  // Reset when overlay opens
  React.useEffect(() => {
    if (!open) return;
    setStage('browse');
    setSessions([]);
    setBrowseError(null);
    setSelected(new Set());
    setDestination('');
    setProgressItems([]);
    setCurrentProgress(null);
    setIngestDone(false);
    setIngestError(null);
    setIngestCanceled(false);
    setCanceling(false);
    setFilesDone(0);
    setFilesTotal(0);
    setHost(DEFAULT_HOST);
    doneFilesRef.current = [];
    setImportState('idle');
    setImportResult(null);
    setImportError(null);
    // Keep importToResolve/importBin choices across reopen only within a session
    // is not desirable here — reset the toggle so it never fires unexpectedly.
    setImportToResolve(false);
    setImportBin(IMPORT_DEFAULT_BIN);
  }, [open]);

  // Load the current Resolve project's bins for the import dropdown. Best-effort:
  // on disconnect/error we fall back to the default bin path as the sole option.
  // Mirrors ExportDeliverOverlay's list_media_bins fetch.
  React.useEffect(() => {
    if (!open || !resolveConnected || !window.leaderpassAPI) {
      setBins([]); setBinTree([]); setBinsLoading(false);
      return;
    }
    let cancelled = false;
    setBinsLoading(true);
    window.leaderpassAPI.call('list_media_bins')
      .then(res => {
        if (cancelled) return;
        setBins(Array.isArray(res?.data?.bins) ? res.data.bins : []);
        setBinTree(Array.isArray(res?.data?.bin_tree) ? res.data.bin_tree : []);
      })
      .catch(() => { if (!cancelled) { setBins([]); setBinTree([]); } })
      .finally(() => { if (!cancelled) setBinsLoading(false); });
    return () => { cancelled = true; };
  }, [open, resolveConnected]);

  // Fire the Resolve import once the ingest finishes cleanly and the toggle is on.
  // Runs from an effect (not inside the progress handler) so it reads fresh
  // importBin/importToResolve state rather than a stale event-handler closure.
  // A canceled ingest doesn't import: the editor asked it to stop.
  React.useEffect(() => {
    if (!ingestDone || ingestError || ingestCanceled) return;
    if (!importToResolve || !resolveConnected) return;
    if (importState !== 'idle') return;
    runResolveImport();
  }, [ingestDone, ingestError, ingestCanceled, importToResolve, resolveConnected, importState]);

  // While files are copying (or the follow-up Resolve import runs) the overlay
  // can't close: App unmounts it on close, which would drop the progress view
  // and skip the import. Cancel in the footer is the way out of an ingest.
  const ingestRunning = stage === 'progress' && !ingestDone;
  const closeBlocked  = ingestRunning || importState === 'running';

  function requestClose() {
    if (closeBlocked) return;
    onClose?.();
  }

  // Escape-to-close — second escape route in case the X button gets eaten
  // by an OS drag region or some other Electron quirk. Ignored while a run
  // is in progress (same rule as the × button).
  React.useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape' && !closeBlocked) {
        e.preventDefault();
        onClose?.();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, closeBlocked]);

  // Auto-connect when browse stage is shown
  React.useEffect(() => {
    if (!open || stage !== 'browse' || sessions.length > 0 || connecting) return;
    handleConnect();
  }, [open, stage]);

  // Subscribe to atem-progress events during ingest
  React.useEffect(() => {
    if (!window.atemAPI?.onProgress) return;
    const unsub = window.atemAPI.onProgress(handleProgressEvent);
    return unsub;
  }, []);

  // ── Helpers ─────────────────────────────────────────────

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function sessionWasIngested(sessionName) {
    return ingestLogs.some(l => l.session === sessionName && l.state === 'completed');
  }

  // ── Actions ─────────────────────────────────────────────

  async function handleConnect() {
    if (!window.atemAPI) {
      setBrowseError({ message: 'ATEM ingest isn’t available in this build.', detail: 'atemAPI not available' });
      onLog?.('[ATEM] atemAPI not available');
      return;
    }
    setConnecting(true);
    setBrowseError(null);
    setSessions([]);
    onLog?.(`[ATEM] Connecting to ${host}…`);

    try {
      // Load prior ingest logs for status badges
      const logsRes = await window.atemAPI.getIngestLogs(100);
      setIngestLogs(logsRes?.data ?? []);
    } catch (_) {}

    let result;
    try {
      result = await window.atemAPI.listSessions(host);
    } catch (err) {
      setConnecting(false);
      const msg = err?.message || String(err);
      setBrowseError({ message: `Couldn’t reach the ATEM at ${host}.`, detail: msg });
      onLog?.(`[ATEM] Error: ${msg}`);
      return;
    }

    setConnecting(false);

    if (!result?.ok) {
      const errMsg = result?.error || 'Could not connect to ATEM FTP';
      setBrowseError({ message: `Couldn’t reach the ATEM at ${host}.`, detail: errMsg });
      onLog?.(`[ATEM] Connect failed: ${errMsg}`);
      return;
    }

    const count = result.data?.length ?? 0;
    setSessions(result.data ?? []);
    onLog?.(`[ATEM] Connected — ${count} session${count !== 1 ? 's' : ''} found`);
  }

  function toggleSession(name) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleAll() {
    if (selected.size === sessions.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sessions.map(s => s.name)));
    }
  }

  async function handlePickDestination() {
    if (!window.dialogAPI) return;
    const result = await window.dialogAPI.pickFolder();
    if (!result.canceled && result.folderPath) {
      setDestination(result.folderPath);
    }
  }

  async function handleStartIngest() {
    if (!destination || selected.size === 0) return;

    const selectedSessions = sessions.filter(s => selected.has(s.name));
    const total = selectedSessions.reduce((sum, s) => sum + s.fileCount, 0);

    // Build initial progress item list
    setProgressItems(selectedSessions.flatMap(s =>
      s.files.map(f => ({ session: s.name, file: f.name, state: 'pending', camInfo: null }))
    ));
    setFilesTotal(total);
    setFilesDone(0);
    setIngestDone(false);
    setIngestError(null);
    setIngestCanceled(false);
    setCanceling(false);
    setStage('progress');
    onLog?.(`[ATEM] Ingesting ${total} file${total !== 1 ? 's' : ''} into ${destination}…`);

    let res;
    try {
      res = await window.atemAPI?.startIngest({
        host,
        sessions: selectedSessions,
        destination
      });
    } catch (err) {
      res = { ok: false, error: err?.message || String(err) };
    }
    // The main process refused to start (no DB, bad args): no progress events
    // will follow, so end the run here instead of spinning forever.
    if (res && res.ok === false) {
      onLog?.(`[ATEM] Ingest didn't start: ${res.error || 'unknown error'}`);
      setIngestError(res.error || 'unknown error');
      setIngestDone(true);
    }
  }

  function handleProgressEvent(event) {
    if (event.type === 'file-start') {
      setCurrentProgress({ session: event.session, file: event.file, bytes: 0, size: event.size });
      setProgressItems(prev => prev.map(item =>
        item.session === event.session && item.file === event.file
          ? { ...item, state: 'downloading', camInfo: event.camInfo }
          : item
      ));
    } else if (event.type === 'file-bytes') {
      setCurrentProgress(prev => prev ? { ...prev, bytes: event.bytes } : prev);
    } else if (event.type === 'file-done' || event.type === 'file-skipped') {
      setFilesDone(prev => prev + 1);
      // Record the on-disk path + camera so the post-ingest import can pull it
      // into Resolve. Both done and skipped (already-on-disk) carry destPath.
      if (event.destPath) {
        doneFilesRef.current.push({
          local_path: event.destPath,
          session:    event.session,
          cam_number: event.camInfo?.camNumber ?? null,
        });
      }
      setProgressItems(prev => prev.map(item =>
        item.session === event.session && item.file === event.file
          ? { ...item, state: event.type === 'file-skipped' ? 'skipped' : 'done', camInfo: event.camInfo ?? item.camInfo }
          : item
      ));
    } else if (event.type === 'file-error') {
      // filesDone counts files *processed* (drives the progress line); the
      // done screen counts only done + skipped as ingested.
      setFilesDone(prev => prev + 1);
      onLog?.(`[ATEM] ${event.file} failed: ${event.error || 'unknown error'}`);
      setProgressItems(prev => prev.map(item =>
        item.session === event.session && item.file === event.file
          ? { ...item, state: 'error', error: event.error }
          : item
      ));
    } else if (event.type === 'ingest-complete') {
      setIngestDone(true);
      setCanceling(false);
      if (!event.ok && event.error === 'canceled') {
        setIngestCanceled(true);
        onLog?.('[ATEM] Ingest canceled.');
      } else if (!event.ok) {
        setIngestError(event.error);
        onLog?.(`[ATEM] Ingest failed: ${event.error || 'unknown error'}`);
      }
    } else if (event.type === 'ingest-error') {
      setIngestDone(true);
      setCanceling(false);
      setIngestError(event.error);
      onLog?.(`[ATEM] Ingest failed: ${event.error || 'unknown error'}`);
    }
  }

  async function handleCancel() {
    if (canceling) return;
    setCanceling(true);
    onLog?.('[ATEM] Canceling ingest…');
    try {
      await window.atemAPI?.cancelIngest();
    } catch (err) {
      setCanceling(false);
      onLog?.(`[ATEM] Cancel failed: ${err?.message || String(err)}`);
    }
  }

  async function runResolveImport() {
    const files = doneFilesRef.current;
    if (!window.leaderpassAPI || files.length === 0) {
      setImportResult({ imported: 0, failed: 0 });
      setImportState('done');
      return;
    }
    setImportState('running');
    setImportError(null);
    onLog?.(`[ATEM] Importing ${files.length} clip(s) into Resolve: ${importBin}…`);
    try {
      const res = await window.leaderpassAPI.call('import_media', {
        parent_bin: importBin || IMPORT_DEFAULT_BIN,
        files,
      });
      const data = res?.data || {};
      setImportResult({ imported: data.imported ?? 0, failed: data.failed ?? 0 });
      setImportState('done');
      onLog?.(`[ATEM] Resolve import: ${data.imported ?? 0} clip(s) into ${importBin}` +
        (data.failed ? ` · ${data.failed} failed` : ''));
    } catch (err) {
      const msg = err?.error?.message || err?.error || err?.message || 'import failed';
      setImportError(String(msg));
      setImportState('error');
      onLog?.(`[ATEM] Resolve import failed: ${msg}`);
    }
  }

  // ── Selected summary ────────────────────────────────────

  const selectedSessions = sessions.filter(s => selected.has(s.name));
  const selectedFileCount = selectedSessions.reduce((s, ss) => s + ss.fileCount, 0);
  const selectedBytes     = selectedSessions.reduce((s, ss) => s + ss.totalBytes, 0);

  // ── Render stages ────────────────────────────────────────

  function renderBrowse() {
    return (
      <>
        <div className="atem-host-bar">
          <input
            className="atem-host-input"
            type="text"
            value={host}
            onChange={e => setHost(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleConnect()}
            placeholder="ATEM address"
          />
          <button className="btn ghost atem-connect-btn" onClick={handleConnect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>

        {browseError && (
          <p className="notice error" title={browseError.detail || undefined}>{browseError.message}</p>
        )}

        {connecting && !browseError && (
          <div className="run-loading">
            <span className="spinner" />
            <span>Connecting to the ATEM…</span>
          </div>
        )}

        {!connecting && sessions.length > 0 && (
          <>
            <div className="atem-session-controls">
              <button className="atem-select-all-btn" onClick={toggleAll}>
                {selected.size === sessions.length ? 'Deselect all' : 'Select all'}
              </button>
              <span className="atem-session-count">{sessions.length} session{sessions.length !== 1 ? 's' : ''}</span>
            </div>

            <div className="atem-session-list">
              {sessions.map(session => {
                const ingested = sessionWasIngested(session.name);
                const isSelected = selected.has(session.name);
                return (
                  <label
                    key={session.name}
                    className={`atem-session-row${isSelected ? ' selected' : ''}`}
                  >
                    <input
                      type="checkbox"
                      className="atem-session-checkbox"
                      checked={isSelected}
                      onChange={() => toggleSession(session.name)}
                    />
                    <div className="atem-session-info">
                      <span className="atem-session-name">{session.name}</span>
                      <span className="atem-session-meta">
                        {session.fileCount} file{session.fileCount !== 1 ? 's' : ''}
                        {' · '}
                        {formatBytes(session.totalBytes)}
                      </span>
                    </div>
                    {ingested && <span className="tag success">Ingested</span>}
                  </label>
                );
              })}
            </div>
          </>
        )}

        {!connecting && sessions.length === 0 && !browseError && (
          <p className="run-empty">No recording sessions on this drive.</p>
        )}
      </>
    );
  }

  function renderConfigure() {
    return (
      <div className="atem-configure">
        <div className="atem-summary-card">
          <p className="atem-summary-line"><strong>{selectedSessions.length}</strong> session{selectedSessions.length !== 1 ? 's' : ''}</p>
          <p className="atem-summary-line"><strong>{selectedFileCount}</strong> file{selectedFileCount !== 1 ? 's' : ''}</p>
          <p className="atem-summary-line"><strong>{formatBytes(selectedBytes)}</strong> total</p>
        </div>

        <div className="atem-dest-section">
          <p className="atem-field-label">Destination folder</p>
          <div className="atem-dest-row">
            <span className={`atem-dest-path${destination ? '' : ' placeholder'}`}>
              {destination || 'No folder selected'}
            </span>
            <button className="btn ghost small" onClick={handlePickDestination}>
              Choose…
            </button>
          </div>
        </div>

        {/* Import into Resolve — enabled only when a project is open, since the
            Resolve API can only import into the currently-open project. */}
        <div className={`atem-resolve-toggle${resolveConnected ? '' : ' disabled'}`}>
          <label className="atem-resolve-toggle-inner" style={{ cursor: resolveConnected ? 'pointer' : 'default' }}>
            <div>
              <p className="atem-field-label">Import into Resolve</p>
              <p className="atem-resolve-sub">
                {resolveConnected
                  ? `Project: ${resolveProject || 'Current project'}`
                  : 'Resolve not connected.'}
              </p>
            </div>
            <input
              type="checkbox"
              className="atem-session-checkbox"
              checked={importToResolve}
              disabled={!resolveConnected}
              onChange={e => setImportToResolve(e.target.checked)}
            />
          </label>

          {resolveConnected && importToResolve && (
            <div className="atem-dest-section" style={{ marginTop: 10 }}>
              <p className="atem-field-label">Import bin</p>
              <select
                className="settings-input"
                value={importBin}
                onChange={e => setImportBin(e.target.value)}
                disabled={binsLoading}
              >
                {(() => {
                  const tree = binTree.length
                    ? binTree
                    : bins.map(p => ({ path: p, name: p, depth: 1 }));
                  const paths = tree.map(b => b.path);
                  const options = [...tree];
                  if (importBin && !paths.includes(importBin)) {
                    options.unshift({ path: importBin, name: importBin, depth: 1 });
                  }
                  if (options.length === 0) {
                    options.push({ path: IMPORT_DEFAULT_BIN, name: IMPORT_DEFAULT_BIN, depth: 1 });
                  }
                  return options.map(b => {
                    const indent = b.depth > 1 ? '   '.repeat(b.depth - 1) : '';
                    const missing = !paths.includes(b.path) && paths.length > 0;
                    return (
                      <option key={b.path} value={b.path}>
                        {indent}{b.name}{missing ? ' (will be created)' : ''}
                      </option>
                    );
                  });
                })()}
              </select>
              <p className="hint">
                {binsLoading ? 'Loading bins…' : 'One sub-bin per session and camera.'}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Row state → shared .status-dot modifier + short label.
  const FILE_STATE = {
    pending:     { dot: 'is-pending', label: 'Queued' },
    downloading: { dot: 'is-active',  label: 'Copying' },
    done:        { dot: 'is-done',    label: 'Ingested' },
    skipped:     { dot: 'is-skipped', label: 'Already copied' },
    error:       { dot: 'is-error',   label: 'Failed' },
  };

  function renderDoneSummary() {
    const total     = progressItems.length || filesTotal;
    const okCount   = progressItems.filter(i => i.state === 'done' || i.state === 'skipped').length;
    const failCount = progressItems.filter(i => i.state === 'error').length;

    let title = 'Ingest complete';
    if (ingestError)         title = 'Ingest failed';
    else if (ingestCanceled) title = 'Ingest canceled';
    else if (failCount > 0)  title = 'Ingest finished with errors';

    return (
      <div className="run-summary">
        <p className="run-summary-title">{title}</p>
        <p className="run-summary-sub">{okCount} of {total} file{total !== 1 ? 's' : ''} ingested.</p>
        {failCount > 0 && (
          <p className="error-text">{failCount} file{failCount !== 1 ? 's' : ''} failed. Details are in the Console.</p>
        )}
        {ingestError && (
          <p className="notice error" title={String(ingestError)}>
            The ingest stopped before it finished. Details are in the Console.
          </p>
        )}
        {importToResolve && !ingestError && !ingestCanceled && (
          <>
            {importState === 'idle' && !resolveConnected && (
              <p className="hint">Resolve not connected. Footage wasn’t imported.</p>
            )}
            {importState === 'running' && (
              <p className="run-loading">
                <span className="spinner small" />
                <span>Importing into Resolve…</span>
              </p>
            )}
            {importState === 'done' && importResult && (
              <p className="run-summary-sub">
                Imported {importResult.imported} clip{importResult.imported !== 1 ? 's' : ''} into {importBin}.
                {importResult.failed ? ` ${importResult.failed} failed.` : ''}
              </p>
            )}
            {importState === 'error' && (
              <p className="notice error" title={importError || undefined}>
                Couldn’t import the footage into Resolve. Details are in the Console.
              </p>
            )}
          </>
        )}
      </div>
    );
  }

  function renderProgress() {
    // One bar: whole files processed plus the fraction of the file in flight.
    const inFlight = !ingestDone && currentProgress?.size > 0
      ? Math.min(1, currentProgress.bytes / currentProgress.size)
      : 0;
    const pct = filesTotal > 0
      ? Math.min(100, Math.round(((filesDone + inFlight) / filesTotal) * 100))
      : 0;

    return (
      <div className="atem-progress-view">
        {ingestDone ? renderDoneSummary() : (
          <div className="run-progress">
            <p className="run-progress-line">
              <span>{filesDone} / {filesTotal} files</span>
              {currentProgress && (
                <>
                  <span>·</span>
                  <span className="run-progress-file">{currentProgress.file}</span>
                  {currentProgress.size > 0 && (
                    <span>{formatBytes(currentProgress.bytes)} / {formatBytes(currentProgress.size)}</span>
                  )}
                </>
              )}
            </p>
            <div className="run-progress-track">
              <div className="run-progress-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}

        <div className="run-list">
          {progressItems.map((item, i) => {
            const st = FILE_STATE[item.state] || FILE_STATE.pending;
            return (
              <div key={i} className={`run-row ${st.dot}`}>
                <span className={`status-dot ${st.dot}`} />
                <span className="run-row-name">{item.file}</span>
                {item.camInfo && (
                  <span className="run-row-meta">CAM {item.camInfo.camNumber}</span>
                )}
                <span className="run-row-state" title={item.state === 'error' ? (item.error || undefined) : undefined}>
                  {st.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (!open) return null;

  const canProceedToConfigure = selected.size > 0;
  const canStartIngest = destination.length > 0 && selected.size > 0;

  return (
    <div className="tool-overlay" role="dialog" aria-label="ATEM ingest">
      <header className="tool-header">
        <h2 className="tool-title">ATEM ingest</h2>
        <button
          className="tool-close"
          onClick={requestClose}
          disabled={closeBlocked}
          aria-label="Close"
          title={ingestRunning ? 'Cancel the ingest to close' : closeBlocked ? 'Importing into Resolve…' : 'Close'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <div className="tool-body tool-body--form">
        {stage === 'browse'    && renderBrowse()}
        {stage === 'configure' && renderConfigure()}
        {stage === 'progress'  && renderProgress()}
      </div>

      <footer className="tool-footer tool-footer--form">
        {stage === 'browse' && (
          <>
            {selected.size > 0 && (
              <span className="tool-footer-status">
                {selected.size} session{selected.size !== 1 ? 's' : ''} selected
              </span>
            )}
            <button
              className="btn primary"
              disabled={!canProceedToConfigure}
              onClick={() => setStage('configure')}
            >
              Next
            </button>
          </>
        )}

        {stage === 'configure' && (
          <>
            <button className="btn ghost" onClick={() => setStage('browse')}>Back</button>
            <button className="btn primary" disabled={!canStartIngest} onClick={handleStartIngest}>
              Start ingest
            </button>
          </>
        )}

        {ingestRunning && (
          <button className="btn danger" onClick={handleCancel} disabled={canceling}>
            {canceling ? 'Canceling…' : 'Cancel ingest'}
          </button>
        )}

        {stage === 'progress' && ingestDone && (
          <button className="btn primary" onClick={requestClose} disabled={closeBlocked}>Done</button>
        )}
      </footer>
    </div>
  );
}
