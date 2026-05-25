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
 *   resolveConnected — boolean (future Resolve import toggle)
 *   resolveProject   — string  (future Resolve import toggle)
 */
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

  // ── Progress state ─────────────────────────────────────
  const [progressItems, setProgressItems] = React.useState([]); // [{ session, file, state, camInfo }]
  const [currentProgress, setCurrentProgress] = React.useState(null);
  const [ingestDone, setIngestDone] = React.useState(false);
  const [ingestError, setIngestError] = React.useState(null);
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
    setFilesDone(0);
    setFilesTotal(0);
    setHost(DEFAULT_HOST);
  }, [open]);

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
    if (!window.atemAPI) { setBrowseError('atemAPI not available'); return; }
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
      setBrowseError(`FTP error: ${msg}`);
      onLog?.(`[ATEM] Error: ${msg}`);
      return;
    }

    setConnecting(false);

    if (!result?.ok) {
      const errMsg = result?.error || 'Could not connect to ATEM FTP';
      setBrowseError(errMsg);
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
    setStage('progress');

    await window.atemAPI?.startIngest({
      host,
      sessions: selectedSessions,
      destination
    });
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
      setProgressItems(prev => prev.map(item =>
        item.session === event.session && item.file === event.file
          ? { ...item, state: event.type === 'file-skipped' ? 'skipped' : 'done', camInfo: event.camInfo ?? item.camInfo }
          : item
      ));
    } else if (event.type === 'file-error') {
      setFilesDone(prev => prev + 1);
      setProgressItems(prev => prev.map(item =>
        item.session === event.session && item.file === event.file
          ? { ...item, state: 'error', error: event.error }
          : item
      ));
    } else if (event.type === 'ingest-complete') {
      setIngestDone(true);
      if (!event.ok && event.error !== 'canceled') setIngestError(event.error);
    } else if (event.type === 'ingest-error') {
      setIngestDone(true);
      setIngestError(event.error);
    }
  }

  async function handleCancel() {
    await window.atemAPI?.cancelIngest();
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
            placeholder="ATEM FTP IP"
          />
          <button className="btn-secondary atem-connect-btn" onClick={handleConnect} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>

        {browseError && <p className="atem-error">{browseError}</p>}

        {connecting && !browseError && (
          <div className="atem-loading">
            <span className="status-bar-spinner" style={{ width: 14, height: 14 }} />
            <span>Connecting to ATEM…</span>
          </div>
        )}

        {!connecting && sessions.length > 0 && (
          <>
            <div className="atem-session-controls">
              <button className="atem-select-all-btn" onClick={toggleAll}>
                {selected.size === sessions.length ? 'Deselect All' : 'Select All'}
              </button>
              <span className="atem-session-count">{sessions.length} session{sessions.length !== 1 ? 's' : ''} found</span>
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
                    {ingested && <span className="atem-badge ingested">Ingested</span>}
                  </label>
                );
              })}
            </div>
          </>
        )}

        {!connecting && sessions.length === 0 && !browseError && (
          <p className="atem-empty">No recording sessions found on this drive.</p>
        )}
      </>
    );
  }

  function renderConfigure() {
    return (
      <div className="atem-configure">
        <div className="atem-summary-card">
          <p className="atem-summary-line"><strong>{selectedSessions.length}</strong> session{selectedSessions.length !== 1 ? 's' : ''}</p>
          <p className="atem-summary-line"><strong>{selectedFileCount}</strong> video file{selectedFileCount !== 1 ? 's' : ''}</p>
          <p className="atem-summary-line"><strong>{formatBytes(selectedBytes)}</strong> estimated</p>
        </div>

        <div className="atem-dest-section">
          <p className="atem-field-label">Destination folder</p>
          <div className="atem-dest-row">
            <span className={`atem-dest-path${destination ? '' : ' placeholder'}`}>
              {destination || 'No folder selected'}
            </span>
            <button className="btn-secondary" onClick={handlePickDestination}>
              Choose…
            </button>
          </div>
          {!destination && (
            <p className="atem-dest-hint">Select the folder where footage will be organised by session and camera.</p>
          )}
        </div>

        {/* Future: Resolve import toggle */}
        <div className={`atem-resolve-toggle${resolveConnected ? '' : ' disabled'}`}>
          <div className="atem-resolve-toggle-inner">
            <div>
              <p className="atem-field-label">Import into Resolve</p>
              <p className="atem-resolve-sub">
                {resolveConnected
                  ? `Will import into: ${resolveProject || 'current project'}`
                  : 'Resolve not connected — open a project first'}
              </p>
            </div>
            <span className="atem-coming-soon-badge">Soon</span>
          </div>
        </div>
      </div>
    );
  }

  function renderProgress() {
    const pct = filesTotal > 0 ? Math.round((filesDone / filesTotal) * 100) : 0;
    const fileBytePct = currentProgress?.size > 0
      ? Math.round((currentProgress.bytes / currentProgress.size) * 100)
      : 0;

    const errorCount = progressItems.filter(i => i.state === 'error').length;

    return (
      <div className="atem-progress-view">
        <div className="atem-progress-overall">
          <div className="atem-progress-label">
            <span>{filesDone} / {filesTotal} files</span>
            <span>{pct}%</span>
          </div>
          <div className="result-overlay-progress-track" style={{ height: 4 }}>
            <div className="result-overlay-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>

        {!ingestDone && currentProgress && (
          <div className="atem-current-file">
            <p className="atem-current-file-label">Downloading</p>
            <p className="atem-current-file-name">{currentProgress.file}</p>
            {currentProgress.size > 0 && (
              <div className="atem-progress-track-sm">
                <div className="atem-progress-fill-sm" style={{ width: `${fileBytePct}%` }} />
              </div>
            )}
            <p className="atem-current-file-bytes">
              {formatBytes(currentProgress.bytes)} / {formatBytes(currentProgress.size)}
            </p>
          </div>
        )}

        {ingestDone && !ingestError && (
          <div className="atem-done-state">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--success)' }}>
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <p className="atem-done-title">Ingest complete</p>
            <p className="atem-done-sub">
              {filesDone} file{filesDone !== 1 ? 's' : ''} ingested
              {errorCount > 0 ? ` · ${errorCount} error${errorCount !== 1 ? 's' : ''}` : ''}
            </p>
          </div>
        )}

        {ingestDone && ingestError && ingestError !== 'canceled' && (
          <p className="atem-error">Ingest failed: {ingestError}</p>
        )}

        <div className="atem-file-list">
          {progressItems.map((item, i) => (
            <div key={i} className={`atem-file-row ${item.state}`}>
              <span className="atem-file-state-icon">
                {item.state === 'done'        && '✓'}
                {item.state === 'skipped'     && '–'}
                {item.state === 'error'       && '✗'}
                {item.state === 'downloading' && <span className="status-bar-spinner" style={{ display: 'inline-block', width: 8, height: 8 }} />}
                {item.state === 'pending'     && '·'}
              </span>
              <span className="atem-file-name">{item.file}</span>
              {item.camInfo && (
                <span className="atem-file-cam">CAM {item.camInfo.camNumber}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!open) return null;

  const canProceedToConfigure = selected.size > 0;
  const canStartIngest = destination.length > 0 && selected.size > 0;

  return (
    <div className="result-overlay atem-overlay" role="dialog" aria-label="ATEM Ingest">
      {/* Header */}
      <header className="result-overlay-header">
        <button className="result-overlay-back" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <span className="result-overlay-title">ATEM Footage Ingest</span>
        <div className="atem-stage-pills">
          {['browse', 'configure', 'progress'].map((s, i) => (
            <span key={s} className={`atem-stage-pill${stage === s ? ' active' : ''}`}>{i + 1}</span>
          ))}
        </div>
      </header>

      {/* Body */}
      <div className="atem-overlay-body">
        {stage === 'browse'    && renderBrowse()}
        {stage === 'configure' && renderConfigure()}
        {stage === 'progress'  && renderProgress()}
      </div>

      {/* Footer */}
      <footer className="result-overlay-actions">
        {stage === 'browse' && (
          <button
            className="btn"
            disabled={!canProceedToConfigure}
            onClick={() => setStage('configure')}
          >
            Next — {selected.size} session{selected.size !== 1 ? 's' : ''} selected
          </button>
        )}

        {stage === 'configure' && (
          <>
            <button className="btn-secondary" onClick={() => setStage('browse')}>Back</button>
            <button className="btn" disabled={!canStartIngest} onClick={handleStartIngest}>
              Start Ingest
            </button>
          </>
        )}

        {stage === 'progress' && !ingestDone && (
          <button className="btn-secondary" onClick={handleCancel}>Cancel</button>
        )}

        {stage === 'progress' && ingestDone && (
          <button className="btn" onClick={onClose}>Done</button>
        )}
      </footer>
    </div>
  );
}
