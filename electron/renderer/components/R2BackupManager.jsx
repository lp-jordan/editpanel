/**
 * R2BackupManager — Backblaze B2 media storage browser.
 *
 * Browses a direct B2 bucket (individual S3 objects, not HyperBackup format)
 * using prefix-based folder navigation with '/' as the delimiter.
 *
 * Props:
 *   open    — boolean
 *   onClose — () => void
 *   onLog   — (msg: string) => void  (pipes to SlideoutConsole)
 */
function R2BackupManager({ open, onClose, onLog }) {
  const [configured, setConfigured]   = React.useState(null); // null=checking, true, false
  const [prefix, setPrefix]           = React.useState('');
  const [entries, setEntries]         = React.useState(null); // { folders, files }
  const [loading, setLoading]         = React.useState(false);
  const [error, setError]             = React.useState(null);
  const [stats, setStats]             = React.useState(null);
  const [statsLoading, setStatsLoading] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(null); // { type, key, name }
  const [deleting, setDeleting]       = React.useState(null); // key or prefix being deleted

  // Sync status (from LPOS)
  const [syncStatus, setSyncStatus]   = React.useState(null);  // null = not loaded
  const [syncTriggering, setSyncTriggering] = React.useState(false);

  // ── Lifecycle ──────────────────────────────────────────────

  React.useEffect(() => {
    if (!open) return;
    setPrefix('');
    setEntries(null);
    setError(null);
    setStats(null);
    setConfirmDelete(null);
    setDeleting(null);
    setSyncStatus(null);
    checkConfig();
    loadSyncStatus();
  }, [open]);

  async function checkConfig() {
    setConfigured(null);
    const res = await window.r2API?.isConfigured();
    const cfg = res?.data ?? false;
    setConfigured(cfg);
    if (cfg) loadDirectory('');
  }

  // ── Sync status ────────────────────────────────────────────

  async function loadSyncStatus() {
    const result = await window.lposAPI?.b2SyncStatus();
    if (result?.ok) setSyncStatus(result.data ?? null);
    // Silently ignore errors (LPOS may not be connected)
  }

  async function triggerSync() {
    setSyncTriggering(true);
    onLog?.('[B2] Triggering sync on LPOS…');
    const result = await window.lposAPI?.b2SyncTrigger();
    setSyncTriggering(false);
    if (!result?.ok) {
      onLog?.(`[B2] Trigger failed: ${result?.error ?? 'unknown'}`);
      return;
    }
    onLog?.('[B2] Sync started on LPOS — check back in a few minutes');
    // Optimistically mark as running
    setSyncStatus(prev => prev ? { ...prev, running: true } : null);
  }

  // ── Data loading ───────────────────────────────────────────

  async function loadDirectory(p) {
    setPrefix(p);
    setEntries(null);
    setLoading(true);
    setError(null);
    onLog?.(`[B2] Listing ${p || 'root'}…`);
    const result = await window.r2API?.listDirectory(p);
    setLoading(false);
    if (!result?.ok) {
      const msg = result?.error || 'Failed to list directory';
      setError(msg);
      onLog?.(`[B2] Error: ${msg}`);
      return;
    }
    const { folders, files } = result.data;
    setEntries(result.data);
    onLog?.(`[B2] ${folders.length} folder(s), ${files.length} file(s)`);
  }

  async function loadStats() {
    setStatsLoading(true);
    onLog?.('[B2] Loading bucket stats…');
    const result = await window.r2API?.getStats();
    setStatsLoading(false);
    if (!result?.ok) {
      onLog?.(`[B2] Stats error: ${result?.error}`);
      return;
    }
    setStats(result.data);
    onLog?.(`[B2] ${formatBytes(result.data.totalBytes)} · ${result.data.fileCount.toLocaleString()} files total`);
  }

  // ── Delete actions ─────────────────────────────────────────

  async function doDelete() {
    const { type, key, name } = confirmDelete;
    setConfirmDelete(null);
    setDeleting(key);

    if (type === 'folder') {
      onLog?.(`[B2] Deleting folder ${name}…`);
      const result = await window.r2API?.deleteFolder(key);
      setDeleting(null);
      if (!result?.ok) { onLog?.(`[B2] Delete failed: ${result?.error}`); return; }
      onLog?.(`[B2] Deleted ${result.data?.deleted ?? 0} file(s) from ${name}/`);
    } else {
      onLog?.(`[B2] Deleting ${name}…`);
      const result = await window.r2API?.deleteFile(key);
      setDeleting(null);
      if (!result?.ok) { onLog?.(`[B2] Delete failed: ${result?.error}`); return; }
      onLog?.(`[B2] Deleted ${name}`);
    }

    await loadDirectory(prefix);
    // Reset stats — totals are now stale
    setStats(null);
  }

  // ── Helpers ────────────────────────────────────────────────

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDate(d) {
    if (!d) return '';
    try {
      return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return ''; }
  }

  function formatRelative(isoStr) {
    if (!isoStr) return '';
    try {
      const diff = Date.now() - new Date(isoStr).getTime();
      const h = Math.floor(diff / 3_600_000);
      if (h < 1)  return 'just now';
      if (h < 24) return `${h}h ago`;
      const d = Math.floor(h / 24);
      return `${d}d ago`;
    } catch { return ''; }
  }

  function renderSyncStrip() {
    // Always render — shows LPOS-not-connected state gracefully
    const s = syncStatus;
    const isRunning   = s?.running ?? false;
    const configured  = s?.configured ?? null;  // null = not loaded yet
    const lastRun     = s?.lastRun ?? null;
    const nextHour    = s?.nextRunHour ?? 2;
    const syncDirs    = s?.syncDirs ?? [];

    let dot = 'r2-sync-dot-idle';
    if (isRunning)               dot = 'r2-sync-dot-running';
    else if (lastRun?.failed > 0) dot = 'r2-sync-dot-error';
    else if (lastRun)            dot = 'r2-sync-dot-ok';

    return (
      <div className="r2-sync-strip">
        <div className="r2-sync-left">
          <span className={`r2-sync-dot ${dot}`} />
          <span className="r2-sync-label">LPOS Sync</span>
          {s === null && (
            <span className="r2-sync-meta">Loading…</span>
          )}
          {s !== null && configured === false && (
            <span className="r2-sync-meta r2-sync-uncfg">not configured on LPOS</span>
          )}
          {s !== null && configured === null && syncStatus === null && (
            <span className="r2-sync-meta">LPOS not connected</span>
          )}
          {s !== null && configured === true && isRunning && (
            <span className="r2-sync-meta">
              <span className="status-bar-spinner" style={{ width: 10, height: 10 }} />
              {' '}Running…
            </span>
          )}
          {s !== null && configured === true && !isRunning && lastRun && (
            <span className="r2-sync-meta">
              Last: {formatRelative(lastRun.timestamp)}
              {' · '}
              <span className="r2-sync-ok">{lastRun.uploaded} uploaded</span>
              {lastRun.failed > 0 && (
                <span className="r2-sync-err"> · {lastRun.failed} failed</span>
              )}
              {lastRun.swept > 0 && (
                <span> · {lastRun.swept} swept</span>
              )}
            </span>
          )}
          {s !== null && configured === true && !isRunning && !lastRun && (
            <span className="r2-sync-meta">No runs yet · scheduled {nextHour}:00</span>
          )}
        </div>
        {s !== null && configured === true && (
          <button
            className="r2-sync-trigger-btn"
            onClick={triggerSync}
            disabled={isRunning || syncTriggering}
            title="Trigger a manual sync now"
          >
            {syncTriggering
              ? <><span className="status-bar-spinner" style={{ width: 10, height: 10 }} />{' '}Starting…</>
              : 'Sync Now'
            }
          </button>
        )}
      </div>
    );
  }

  function buildCrumbs() {
    const crumbs = [{ label: 'Root', prefix: '' }];
    if (!prefix) return crumbs;
    const parts = prefix.split('/').filter(Boolean);
    let built = '';
    for (const part of parts) {
      built += part + '/';
      crumbs.push({ label: part, prefix: built });
    }
    return crumbs;
  }

  // ── Main render ────────────────────────────────────────────

  if (!open) return null;

  const crumbs = buildCrumbs();

  return (
    <div className="result-overlay r2-overlay" role="dialog" aria-label="B2 Media Browser">

      {/* Header */}
      <header className="result-overlay-header">
        <button className="result-overlay-back" onClick={onClose} aria-label="Close">
          <CloseIcon />
        </button>
        <span className="result-overlay-title">B2 Media Storage</span>
        {configured === true && (
          <button
            className="r2-icon-btn r2-refresh-btn"
            onClick={() => loadDirectory(prefix)}
            disabled={loading}
            title="Refresh"
          >
            <RefreshIcon />
          </button>
        )}
      </header>

      {/* Body */}
      <div className="r2-overlay-body">

        {/* Sync status strip — always visible regardless of B2 config */}
        {renderSyncStrip()}

        {/* Checking config */}
        {configured === null && (
          <div className="r2-loading-row">
            <span className="status-bar-spinner" style={{ width: 14, height: 14 }} />
            <span>Checking configuration…</span>
          </div>
        )}

        {/* Not configured */}
        {configured === false && (
          <div className="r2-unconfigured">
            <p className="r2-unconfigured-title">Backblaze B2 not configured</p>
            <p className="r2-unconfigured-body">
              Set the following env vars via Doppler on this machine to enable the media browser:
            </p>
            <ul className="r2-unconfigured-vars">
              <li><code>B2_MEDIA_ENDPOINT</code> — e.g. https://s3.us-west-004.backblazeb2.com</li>
              <li><code>B2_MEDIA_KEY_ID</code> — Application Key ID</li>
              <li><code>B2_MEDIA_APPLICATION_KEY</code> — Application Key</li>
              <li><code>B2_MEDIA_BUCKET</code> — bucket name</li>
            </ul>
          </div>
        )}

        {configured === true && (
          <>
            {/* Stats bar */}
            <div className="r2-stats-bar">
              {stats ? (
                <span className="r2-stats-text">
                  {formatBytes(stats.totalBytes)}
                  {' · '}
                  {stats.fileCount.toLocaleString()} files
                  {stats.lastModified && ` · Last: ${formatDate(stats.lastModified)}`}
                </span>
              ) : (
                <button
                  className="r2-stats-load-btn"
                  onClick={loadStats}
                  disabled={statsLoading}
                >
                  {statsLoading
                    ? <><span className="status-bar-spinner" style={{ width: 10, height: 10 }} />{' '}Loading…</>
                    : 'Load bucket stats'
                  }
                </button>
              )}
            </div>

            {/* Breadcrumb */}
            <nav className="r2-breadcrumb">
              {crumbs.map((crumb, i) => (
                <React.Fragment key={crumb.prefix}>
                  {i > 0 && <span className="r2-breadcrumb-sep">/</span>}
                  {i < crumbs.length - 1 ? (
                    <button
                      className="r2-breadcrumb-link"
                      onClick={() => loadDirectory(crumb.prefix)}
                      disabled={loading}
                    >
                      {crumb.label}
                    </button>
                  ) : (
                    <span className="r2-breadcrumb-current">{crumb.label}</span>
                  )}
                </React.Fragment>
              ))}
            </nav>

            {/* Loading */}
            {loading && (
              <div className="r2-loading-row">
                <span className="status-bar-spinner" style={{ width: 14, height: 14 }} />
                <span>Loading…</span>
              </div>
            )}

            {/* Error */}
            {!loading && error && (
              <div className="r2-error-block">
                <p className="r2-error-text">{error}</p>
                <button className="btn-secondary" onClick={() => loadDirectory(prefix)}>Retry</button>
              </div>
            )}

            {/* Browser */}
            {!loading && !error && entries && (
              <div className="r2-browser">
                {entries.folders.length === 0 && entries.files.length === 0 && (
                  <p className="r2-empty">This folder is empty.</p>
                )}

                {/* Folders */}
                {entries.folders.map(folder => (
                  <div
                    key={folder.prefix}
                    className={`r2-browser-row r2-folder-row${deleting === folder.prefix ? ' deleting' : ''}`}
                  >
                    <span className="r2-row-icon"><FolderIcon /></span>
                    <button
                      className="r2-row-main"
                      onClick={() => loadDirectory(folder.prefix)}
                      disabled={!!deleting}
                    >
                      {folder.name}
                    </button>
                    <button
                      className="r2-icon-btn r2-delete-btn"
                      title={`Delete all files in ${folder.name}/`}
                      onClick={() => setConfirmDelete({ type: 'folder', key: folder.prefix, name: folder.name })}
                      disabled={!!deleting}
                    >
                      {deleting === folder.prefix
                        ? <span className="status-bar-spinner" style={{ width: 12, height: 12 }} />
                        : <TrashIcon />}
                    </button>
                  </div>
                ))}

                {/* Divider between folders and files */}
                {entries.folders.length > 0 && entries.files.length > 0 && (
                  <div className="r2-browser-divider" />
                )}

                {/* Files */}
                {entries.files.map(file => (
                  <div
                    key={file.key}
                    className={`r2-browser-row r2-file-row${deleting === file.key ? ' deleting' : ''}`}
                  >
                    <span className="r2-row-icon"><FileIcon /></span>
                    <div className="r2-file-info">
                      <span className="r2-file-name">{file.name}</span>
                      <span className="r2-file-meta">
                        {formatBytes(file.size)}
                        {file.lastModified && ` · ${formatDate(file.lastModified)}`}
                      </span>
                    </div>
                    <button
                      className="r2-icon-btn r2-delete-btn"
                      title={`Delete ${file.name}`}
                      onClick={() => setConfirmDelete({ type: 'file', key: file.key, name: file.name })}
                      disabled={!!deleting}
                    >
                      {deleting === file.key
                        ? <span className="status-bar-spinner" style={{ width: 12, height: 12 }} />
                        : <TrashIcon />}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Confirm delete */}
      {confirmDelete && (
        <div className="r2-confirm-overlay">
          <div className="r2-confirm-dialog">
            <p className="r2-confirm-title">
              {confirmDelete.type === 'folder' ? 'Delete folder?' : 'Delete file?'}
            </p>
            <p className="r2-confirm-body">
              {confirmDelete.type === 'folder'
                ? <>All files inside <strong>{confirmDelete.name}/</strong> will be permanently deleted from B2.</>
                : <><strong>{confirmDelete.name}</strong> will be permanently deleted from B2.</>
              }
            </p>
            <div className="r2-confirm-actions">
              <button className="btn-secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn r2-btn-danger" onClick={doDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inline icons ──────────────────────────────────────────────

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4h6v2" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}
