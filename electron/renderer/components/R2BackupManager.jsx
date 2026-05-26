/**
 * R2BackupManager — Browse, preview, and delete LPOS Backblaze B2 backups.
 *
 * Three-stage flow:
 *   dates   — list of backup dates (newest first)
 *   files   — file listing for a selected date
 *   preview — decompressed JSON content for a single .json.gz file
 *
 * Props:
 *   open    — boolean
 *   onClose — () => void
 *   onLog   — (msg: string) => void  (pipes to SlideoutConsole)
 */
function R2BackupManager({ open, onClose, onLog }) {
  const [stage, setStage]         = React.useState('dates');
  const [configured, setConfigured] = React.useState(null); // null=loading, true, false
  const [loading, setLoading]     = React.useState(false);
  const [error, setError]         = React.useState(null);

  // Dates stage
  const [dates, setDates]                   = React.useState([]);
  const [confirmDeleteDate, setConfirmDeleteDate] = React.useState(null);
  const [deletingDate, setDeletingDate]     = React.useState(null);

  // Files stage
  const [selectedDate, setSelectedDate] = React.useState(null);
  const [files, setFiles]               = React.useState([]);
  const [confirmDeleteFile, setConfirmDeleteFile] = React.useState(null);
  const [deletingFile, setDeletingFile] = React.useState(null);

  // Preview stage
  const [previewFile, setPreviewFile]       = React.useState(null);
  const [previewContent, setPreviewContent] = React.useState(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);

  // ── Lifecycle ──────────────────────────────────────────────

  React.useEffect(() => {
    if (!open) return;
    resetAll();
    checkConfig();
  }, [open]);

  function resetAll() {
    setStage('dates');
    setError(null);
    setDates([]);
    setSelectedDate(null);
    setFiles([]);
    setPreviewFile(null);
    setPreviewContent(null);
    setConfirmDeleteDate(null);
    setConfirmDeleteFile(null);
    setDeletingDate(null);
    setDeletingFile(null);
  }

  async function checkConfig() {
    setConfigured(null);
    const res = await window.r2API?.isConfigured();
    const cfg = res?.data ?? false;
    setConfigured(cfg);
    if (cfg) loadDates();
  }

  // ── Data loading ───────────────────────────────────────────

  async function loadDates() {
    setLoading(true);
    setError(null);
    onLog?.('[B2] Loading backup dates…');
    const result = await window.r2API?.listDates();
    setLoading(false);
    if (!result?.ok) {
      const msg = result?.error || 'Failed to list backup dates';
      setError(msg);
      onLog?.(`[B2] Error: ${msg}`);
      return;
    }
    setDates(result.data ?? []);
    onLog?.(`[B2] ${result.data.length} backup date(s) found`);
  }

  async function loadFiles(date) {
    setSelectedDate(date);
    setStage('files');
    setLoading(true);
    setError(null);
    setFiles([]);
    onLog?.(`[B2] Loading files for ${date}…`);
    const result = await window.r2API?.listDateFiles(date);
    setLoading(false);
    if (!result?.ok) {
      const msg = result?.error || 'Failed to list files';
      setError(msg);
      onLog?.(`[B2] Error: ${msg}`);
      return;
    }
    setFiles(result.data ?? []);
  }

  async function loadPreview(file) {
    setPreviewFile(file);
    setPreviewContent(null);
    setPreviewLoading(true);
    setStage('preview');
    onLog?.(`[B2] Loading ${file.name}…`);
    const result = await window.r2API?.getFileContent(file.key);
    setPreviewLoading(false);
    if (!result?.ok) {
      setPreviewContent(`Error: ${result?.error || 'Unknown error'}`);
      onLog?.(`[B2] Preview error: ${result?.error}`);
      return;
    }
    setPreviewContent(result.data);
    onLog?.(`[R2] Loaded ${file.name}`);
  }

  // ── Delete actions ─────────────────────────────────────────

  async function confirmAndDeleteDate(date) {
    setConfirmDeleteDate(null);
    setDeletingDate(date);
    onLog?.(`[B2] Deleting backup ${date}…`);
    const result = await window.r2API?.deleteDate(date);
    setDeletingDate(null);
    if (!result?.ok) {
      onLog?.(`[R2] Delete failed: ${result?.error}`);
      return;
    }
    onLog?.(`[B2] Deleted ${result.data?.deleted ?? 0} file(s) from ${date}`);
    // Refresh date list
    await loadDates();
    // If we were viewing this date's files, go back
    if (stage === 'files' && selectedDate === date) setStage('dates');
  }

  async function confirmAndDeleteFile(file) {
    setConfirmDeleteFile(null);
    setDeletingFile(file.key);
    onLog?.(`[B2] Deleting ${file.name}…`);
    const result = await window.r2API?.deleteFile(file.key);
    setDeletingFile(null);
    if (!result?.ok) {
      onLog?.(`[R2] Delete failed: ${result?.error}`);
      return;
    }
    // Refresh file list for the current date
    await loadFiles(selectedDate);
  }

  // ── Navigation ─────────────────────────────────────────────

  function goBack() {
    if (stage === 'preview') {
      setStage('files');
      setPreviewFile(null);
      setPreviewContent(null);
    } else if (stage === 'files') {
      setStage('dates');
      setSelectedDate(null);
      setFiles([]);
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[Math.min(i, units.length - 1)]}`;
  }

  function friendlyDate(dateStr) {
    try {
      const d = new Date(dateStr + 'T12:00:00');
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return dateStr; }
  }

  function groupFiles(fileList) {
    return {
      sqlite:   fileList.filter(f => f.isSqlite),
      state:    fileList.filter(f => !f.isSqlite && f.name.startsWith('state/')),
      projects: fileList.filter(f => !f.isSqlite && f.name.startsWith('projects/')),
      other:    fileList.filter(f => !f.isSqlite && !f.name.startsWith('state/') && !f.name.startsWith('projects/'))
    };
  }

  function stripPrefix(name) {
    return name.replace(/^(state|projects)\//, '');
  }

  // ── Render stages ──────────────────────────────────────────

  function renderDates() {
    if (loading) {
      return (
        <div className="r2-loading-row">
          <span className="status-bar-spinner" style={{ width: 14, height: 14 }} />
          <span>Loading backups…</span>
        </div>
      );
    }

    if (error) {
      return (
        <div className="r2-error-block">
          <p className="r2-error-text">{error}</p>
          <button className="btn-secondary" onClick={loadDates}>Retry</button>
        </div>
      );
    }

    if (dates.length === 0) {
      return <p className="r2-empty">No backups found in this bucket.</p>;
    }

    return (
      <div className="r2-date-list">
        {dates.map(entry => (
          <div
            key={entry.date}
            className={`r2-date-row${deletingDate === entry.date ? ' deleting' : ''}`}
          >
            <button
              className="r2-date-main"
              onClick={() => loadFiles(entry.date)}
              disabled={deletingDate === entry.date}
            >
              <span className="r2-date-label">{friendlyDate(entry.date)}</span>
              <span className="r2-date-meta">
                {entry.fileCount} file{entry.fileCount !== 1 ? 's' : ''}
                {' · '}
                {formatBytes(entry.totalBytes)}
              </span>
            </button>
            <button
              className="r2-icon-btn r2-delete-btn"
              title={`Delete all backups from ${entry.date}`}
              onClick={() => setConfirmDeleteDate(entry.date)}
              disabled={deletingDate === entry.date}
            >
              {deletingDate === entry.date
                ? <span className="status-bar-spinner" style={{ width: 12, height: 12 }} />
                : <TrashIcon />}
            </button>
          </div>
        ))}
      </div>
    );
  }

  function renderFiles() {
    if (loading) {
      return (
        <div className="r2-loading-row">
          <span className="status-bar-spinner" style={{ width: 14, height: 14 }} />
          <span>Loading files…</span>
        </div>
      );
    }

    if (error) {
      return (
        <div className="r2-error-block">
          <p className="r2-error-text">{error}</p>
          <button className="btn-secondary" onClick={() => loadFiles(selectedDate)}>Retry</button>
        </div>
      );
    }

    if (files.length === 0) {
      return <p className="r2-empty">No files in this backup.</p>;
    }

    const groups = groupFiles(files);
    const sections = [
      { key: 'sqlite',   label: 'Databases',     items: groups.sqlite },
      { key: 'state',    label: 'Config / State', items: groups.state },
      { key: 'projects', label: 'Projects',       items: groups.projects },
      { key: 'other',    label: 'Other',          items: groups.other }
    ].filter(s => s.items.length > 0);

    return (
      <div className="r2-file-list">
        {sections.map(section => (
          <div key={section.key} className="r2-file-section">
            <p className="r2-file-section-label">{section.label}</p>
            {section.items.map(file => (
              <div
                key={file.key}
                className={`r2-file-row${deletingFile === file.key ? ' deleting' : ''}`}
              >
                <span className="r2-file-icon">
                  {file.isSqlite ? <DbIcon /> : <FileIcon />}
                </span>
                <div className="r2-file-info">
                  <span className="r2-file-name">{stripPrefix(file.name)}</span>
                  <span className="r2-file-size">{formatBytes(file.size)}</span>
                </div>
                <div className="r2-file-actions">
                  {file.isJson && (
                    file.previewable ? (
                      <button
                        className="r2-preview-btn"
                        onClick={() => loadPreview(file)}
                        disabled={deletingFile === file.key}
                      >
                        Preview
                      </button>
                    ) : file.tooBig ? (
                      <span className="r2-too-big" title="File too large to preview (> 512 KB)">Too large</span>
                    ) : null
                  )}
                  <button
                    className="r2-icon-btn r2-delete-btn"
                    title={`Delete ${file.name}`}
                    onClick={() => setConfirmDeleteFile(file)}
                    disabled={deletingFile === file.key}
                  >
                    {deletingFile === file.key
                      ? <span className="status-bar-spinner" style={{ width: 12, height: 12 }} />
                      : <TrashIcon />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  }

  function renderPreview() {
    return (
      <div className="r2-preview-view">
        {previewLoading && (
          <div className="r2-loading-row">
            <span className="status-bar-spinner" style={{ width: 14, height: 14 }} />
            <span>Decompressing…</span>
          </div>
        )}
        {previewContent && (
          <pre className="r2-preview-content">{previewContent}</pre>
        )}
      </div>
    );
  }

  // ── Not configured state ───────────────────────────────────

  function renderUnconfigured() {
    return (
      <div className="r2-unconfigured">
        <p className="r2-unconfigured-title">Backblaze B2 not configured</p>
        <p className="r2-unconfigured-body">
          Set the following env vars via Doppler on this machine to enable the backup browser:
        </p>
        <ul className="r2-unconfigured-vars">
          <li><code>B2_ENDPOINT</code> — e.g. https://s3.us-west-004.backblazeb2.com</li>
          <li><code>B2_KEY_ID</code> — Application Key ID</li>
          <li><code>B2_APPLICATION_KEY</code> — Application Key</li>
          <li><code>B2_BUCKET</code> — bucket name</li>
        </ul>
      </div>
    );
  }

  // ── Header helpers ─────────────────────────────────────────

  function headerTitle() {
    if (stage === 'dates')   return 'B2 Backups';
    if (stage === 'files')   return selectedDate || 'Files';
    if (stage === 'preview') return previewFile?.name?.split('/').pop() || 'Preview';
    return 'B2 Backups';
  }

  // ── Main render ────────────────────────────────────────────

  if (!open) return null;

  return (
    <div className="result-overlay r2-overlay" role="dialog" aria-label="R2 Backup Manager">
      {/* Header */}
      <header className="result-overlay-header">
        {stage === 'dates' ? (
          <button className="result-overlay-back" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        ) : (
          <button className="result-overlay-back" onClick={goBack} aria-label="Back">
            <BackIcon />
          </button>
        )}
        <span className="result-overlay-title">{headerTitle()}</span>
        {stage === 'dates' && configured && (
          <button
            className="r2-icon-btn r2-refresh-btn"
            onClick={loadDates}
            disabled={loading}
            title="Refresh"
          >
            <RefreshIcon />
          </button>
        )}
      </header>

      {/* Body */}
      <div className="r2-overlay-body">
        {configured === null && (
          <div className="r2-loading-row">
            <span className="status-bar-spinner" style={{ width: 14, height: 14 }} />
            <span>Checking configuration…</span>
          </div>
        )}
        {configured === false && renderUnconfigured()}
        {configured === true && stage === 'dates'   && renderDates()}
        {configured === true && stage === 'files'   && renderFiles()}
        {configured === true && stage === 'preview' && renderPreview()}
      </div>

      {/* Confirm delete date */}
      {confirmDeleteDate && (
        <div className="r2-confirm-overlay">
          <div className="r2-confirm-dialog">
            <p className="r2-confirm-title">Delete backup?</p>
            <p className="r2-confirm-body">
              All files from <strong>{friendlyDate(confirmDeleteDate)}</strong> will be permanently deleted from R2.
            </p>
            <div className="r2-confirm-actions">
              <button className="btn-secondary" onClick={() => setConfirmDeleteDate(null)}>Cancel</button>
              <button
                className="btn r2-btn-danger"
                onClick={() => confirmAndDeleteDate(confirmDeleteDate)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm delete file */}
      {confirmDeleteFile && (
        <div className="r2-confirm-overlay">
          <div className="r2-confirm-dialog">
            <p className="r2-confirm-title">Delete file?</p>
            <p className="r2-confirm-body">
              <strong>{confirmDeleteFile.name}</strong> will be permanently deleted from R2.
            </p>
            <div className="r2-confirm-actions">
              <button className="btn-secondary" onClick={() => setConfirmDeleteFile(null)}>Cancel</button>
              <button
                className="btn r2-btn-danger"
                onClick={() => confirmAndDeleteFile(confirmDeleteFile)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inline icons ─────────────────────────────────────────────

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6" />
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

function DbIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
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
