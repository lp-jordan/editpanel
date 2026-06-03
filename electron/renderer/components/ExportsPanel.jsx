/**
 * ExportsPanel — Phase 3.5 Exports history view.
 *
 * Lives inside the Delivery page, BELOW the existing task grid, behind a
 * subtle centered "· Exports ▾ ·" divider-button that expands the panel
 * inline. The page top stays unchanged; the divider gives the history a
 * calm home that's there when the editor goes looking.
 *
 * Data:
 *   - window.exportsAPI.list({ kind, projectId? }) — filtered query against
 *     the editpanel-side export_runs table.
 *   - window.exportsAPI.onReconciled — wakes us on EVERY reconciler-driven
 *     change (orphan discovered, orphan completed, orphan dismissed, push
 *     phase transitions). We refetch on each one.
 *
 * Actions:
 *   - Open folder — shell.showItemInFolder via exports:open-folder.
 *   - Push to LPOS… — inline project picker (reuses lposAPI.listProjects,
 *     same shape ExportDeliverOverlay already grouped) → exports:push-to-lpos.
 *
 * Sort: newest first by started_at. No Dismiss button (history view —
 * nothing to dismiss). Manual delete is available via window.exportsAPI's
 * deleteRun method (existing) but isn't surfaced here yet.
 */

const FILTERS = [
  { key: 'all',        label: 'All' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'delivered',  label: 'Delivered' },
  { key: 'active',     label: 'Active' },
  { key: 'failed',     label: 'Failed' },
];

// State → { icon, badgeClass, label } for the row's leading chip.
function stateBadge(state) {
  switch (state) {
    case 'completed':           return { icon: '✓', cls: 'ok',    label: 'Delivered' };
    case 'delivered':           return { icon: '✓', cls: 'ok',    label: 'Delivered' };
    case 'complete_unassigned': return { icon: '○', cls: 'wait',  label: 'Awaiting project' };
    case 'rendering':           return { icon: '◌', cls: 'busy',  label: 'Rendering' };
    case 'queued':              return { icon: '◦', cls: 'busy',  label: 'Queued' };
    case 'uploading':           return { icon: '↑', cls: 'busy',  label: 'Uploading' };
    case 'partial':             return { icon: '⚠', cls: 'warn',  label: 'Partial' };
    case 'failed':              return { icon: '×', cls: 'bad',   label: 'Failed' };
    case 'canceled':            return { icon: '–', cls: 'mute',  label: 'Canceled' };
    case 'interrupted':         return { icon: '!', cls: 'warn',  label: 'Interrupted' };
    case 'dismissed_in_resolve':return { icon: '⊖', cls: 'mute',  label: 'Removed from Resolve' };
    default:                    return { icon: '·', cls: 'mute',  label: state || 'Unknown' };
  }
}

function relativeTime(ms) {
  if (!ms) return '';
  const now = Date.now();
  const delta = Math.max(0, now - Number(ms));
  const m = Math.round(delta / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return mo < 12 ? `${mo}mo ago` : `${Math.round(mo / 12)}y ago`;
}

// Pull a Resolve project name from a row. Editpanel-queued and reconciled
// rows store it identically in jobs[0].resolveProjectName.
function resolveProjectNameOf(row) {
  const j = row?.jobs?.[0];
  return j?.resolveProjectName || null;
}

// Timeline names — editpanel-queued jobs[i].name, orphan jobs[i].TimelineName.
function timelineNamesOf(row) {
  const list = Array.isArray(row?.jobs) ? row.jobs : [];
  const names = list.map(j => j?.name || j?.TimelineName).filter(Boolean);
  return names;
}

// Primary on-disk path for the "Local" link. Prefers the captured
// output_paths_json, falls back to target_dir + first timeline name.
function primaryOutputPath(row) {
  if (Array.isArray(row?.output_paths) && row.output_paths.length > 0) {
    return row.output_paths[0];
  }
  return null;
}

function fileTail(p) {
  if (!p) return '';
  const s = String(p);
  const ix = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return ix >= 0 ? s.slice(ix + 1) : s;
}

function dirOf(p) {
  if (!p) return '';
  const s = String(p);
  const ix = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return ix >= 0 ? s.slice(0, ix) : s;
}

// ── Inline project picker ──────────────────────────────────────
// Mirrors the grouped-by-client shape ExportDeliverOverlay uses so editors
// see the same project listing they're used to. Loads on open; renders an
// error if LPOS unreachable.
function ProjectPicker({ open, onClose, onPick }) {
  const [projects, setProjects] = React.useState([]);
  const [loading, setLoading]   = React.useState(false);
  const [error, setError]       = React.useState(null);
  const [picked, setPicked]     = React.useState(null);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setPicked(null);
    if (!window.lposAPI?.listProjects) {
      setError('LPOS API unavailable');
      return;
    }
    setLoading(true);
    window.lposAPI.listProjects()
      .then(res => {
        if (res?.ok) setProjects(res.data?.projects || []);
        else         setError(res?.error || 'Could not load projects');
      })
      .catch(err => setError(err?.message || String(err)))
      .finally(() => setLoading(false));
  }, [open]);

  const grouped = React.useMemo(() => {
    const m = new Map();
    for (const p of projects) {
      if (p.archived) continue;
      const k = p.clientName || 'Unassigned';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [projects]);

  if (!open) return null;

  return (
    <div className="export-picker-overlay" role="dialog" aria-modal="true">
      <div className="export-picker">
        <header className="export-picker-head">
          <div>
            <p className="eyebrow">Push to LPOS</p>
            <h3>Pick a destination project</h3>
          </div>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        </header>

        <div className="export-picker-body">
          {loading && <p className="muted">Loading projects…</p>}
          {error   && <p className="bad">{error}</p>}
          {!loading && !error && grouped.length === 0 && (
            <p className="muted">No projects available.</p>
          )}
          {!loading && !error && grouped.map(([client, list]) => (
            <div key={client} className="export-project-group">
              <p className="export-client-name">{client}</p>
              {list.map(p => (
                <label
                  key={p.projectId}
                  className={`atem-session-row${picked?.projectId === p.projectId ? ' selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="exports-push-pick"
                    checked={picked?.projectId === p.projectId}
                    onChange={() => setPicked(p)}
                  />
                  <span>{p.name || p.projectName}</span>
                </label>
              ))}
            </div>
          ))}
        </div>

        <footer className="export-picker-foot">
          <button
            type="button"
            className="btn primary"
            disabled={!picked}
            onClick={() => { if (picked) onPick(picked); }}
          >
            Push to LPOS
          </button>
        </footer>
      </div>
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────
function ExportRow({ row, onPushClick, onOpenFolderClick }) {
  const badge   = stateBadge(row.state);
  const tl      = timelineNamesOf(row);
  const rpName  = resolveProjectNameOf(row);
  const localPrimary = primaryOutputPath(row)
    || (row.target_dir ? row.target_dir : null);
  const ldelivery = row.lpos_delivery;

  const fromLine = (rpName || tl.length > 0)
    ? `${rpName || '—'}${tl.length > 0 ? ` / ${tl.join(', ')}` : ''}`
    : null;

  const localLine = localPrimary
    ? (Array.isArray(row.output_paths) && row.output_paths.length > 1
        ? `${fileTail(localPrimary)} (+${row.output_paths.length - 1})`
        : (fileTail(localPrimary) || localPrimary))
    : null;

  const orphanWaitingAssign = row.state === 'complete_unassigned';

  return (
    <article className={`exports-row exports-row-${badge.cls}`}>
      <header className="exports-row-head">
        <span className={`exports-row-badge exports-row-badge-${badge.cls}`} title={badge.label}>
          {badge.icon}
        </span>
        <span className="exports-row-title">
          {fileTail(localPrimary) || tl[0] || row.export_id}
        </span>
        <span className="exports-row-time">{relativeTime(row.started_at)}</span>
      </header>

      {fromLine && (
        <div className="exports-row-line">
          <span className="exports-row-label">From</span>
          <span className="exports-row-value">{fromLine}</span>
          {row.source === 'reconciled' && (
            <span className="exports-row-hint">queued in Resolve</span>
          )}
        </div>
      )}

      {localLine && (
        <div className="exports-row-line">
          <span className="exports-row-label">Local</span>
          <span className="exports-row-value mono">{localLine}</span>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => onOpenFolderClick(localPrimary)}
          >
            ↗ Open folder
          </button>
        </div>
      )}

      <div className="exports-row-line">
        <span className="exports-row-label">LPOS</span>
        {ldelivery ? (
          <>
            <span className="exports-row-value">
              {ldelivery.project_name || row.project_name || '—'}
            </span>
            {ldelivery.file_ids?.length > 1 && (
              <span className="exports-row-hint">{ldelivery.file_ids.length} files</span>
            )}
          </>
        ) : orphanWaitingAssign ? (
          <>
            <span className="exports-row-value muted">— not assigned —</span>
            <button
              type="button"
              className="btn primary small"
              onClick={() => onPushClick(row)}
            >
              Push to LPOS…
            </button>
          </>
        ) : row.project_name ? (
          <span className="exports-row-value">{row.project_name}</span>
        ) : (
          <span className="exports-row-value muted">—</span>
        )}
      </div>

      {row.error && (
        <div className="exports-row-line exports-row-error">
          <span className="exports-row-label">Error</span>
          <span className="exports-row-value">{row.error}</span>
        </div>
      )}
    </article>
  );
}

// ── Unassigned-exports pill ────────────────────────────────────
// Single non-blocking chip that lives at the top of the JobPanel. Wakes when
// the reconciler discovers a fresh orphan; editor can ✕ it. Dismissal stores
// the current count as a baseline (preferences.exports_pill_dismissed_count);
// the pill reappears the moment a new orphan pushes the live count above it.
// So ✕ is "I saw these, hide until something new" — never "silence forever."
//
// Clicking the pill (anywhere except ✕) invokes onClick, which the parent
// uses to close JobPanel, navigate to /deliver, and bump a focus token that
// expands ExportsPanel + sets its filter to 'unassigned' (one motion, no
// scrolling).
function UnassignedExportsPill({ onClick }) {
  const [state, setState] = React.useState({ count: 0, dismissedCount: 0, show: false });

  const refresh = React.useCallback(async () => {
    if (!window.exportsAPI?.pillState) return;
    try {
      const res = await window.exportsAPI.pillState();
      if (res?.ok) setState(res.data || { count: 0, dismissedCount: 0, show: false });
    } catch (_) { /* non-fatal */ }
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  React.useEffect(() => {
    if (!window.exportsAPI?.onReconciled) return;
    const unsub = window.exportsAPI.onReconciled(() => refresh());
    return () => { try { unsub && unsub(); } catch (_) {} };
  }, [refresh]);

  // Refresh when the window regains focus — covers the case where orphans were
  // detected while the editor was switched to Resolve and editpanel was idle.
  React.useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  async function handleDismiss(e) {
    e.stopPropagation();
    if (!window.exportsAPI?.dismissPill) return;
    try { await window.exportsAPI.dismissPill(); } catch (_) {}
    refresh();
  }

  if (!state.show || state.count === 0) return null;

  return (
    <button
      type="button"
      className="exports-pill"
      onClick={onClick}
      title="Open the Exports list to review"
    >
      <span className="exports-pill-icon" aria-hidden="true">●</span>
      <span className="exports-pill-text">
        {state.count} export{state.count !== 1 ? 's' : ''} awaiting assignment
      </span>
      <span className="exports-pill-cta">Review →</span>
      <span
        className="exports-pill-dismiss"
        onClick={handleDismiss}
        role="button"
        aria-label="Dismiss"
        title="Hide until a new orphan is detected"
      >
        ×
      </span>
    </button>
  );
}

// ── Panel ──────────────────────────────────────────────────────
function ExportsPanel({ focusToken } = {}) {
  const [open, setOpen]       = React.useState(false);
  const [filter, setFilter]   = React.useState('all');
  const [rows, setRows]       = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError]     = React.useState(null);
  const [pickerForRow, setPickerForRow] = React.useState(null);
  const [pushBusy, setPushBusy]         = React.useState(false);
  const [pushError, setPushError]       = React.useState(null);

  const refresh = React.useCallback(async () => {
    if (!window.exportsAPI?.list) return;
    setLoading(true);
    setError(null);
    try {
      const res = await window.exportsAPI.list({ kind: filter });
      if (res?.ok) setRows(Array.isArray(res.data) ? res.data : []);
      else         setError(res?.error || 'Could not load exports');
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  // Initial load + filter changes — only when expanded (avoid wasted IPC).
  React.useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  // External focus request — pill click in JobPanel bumps focusToken. We
  // expand the panel and snap the filter to Unassigned. Each bump = one
  // action; we don't compare prev-vs-next, just react on every change.
  React.useEffect(() => {
    if (focusToken && focusToken > 0) {
      setOpen(true);
      setFilter('unassigned');
    }
  }, [focusToken]);

  // Reconciler-driven refresh. Subscribe whenever the panel is open; rely on
  // the same exportsAPI.onReconciled the Jobs-tab pill uses (Batch 7).
  React.useEffect(() => {
    if (!open) return;
    if (!window.exportsAPI?.onReconciled) return;
    const unsub = window.exportsAPI.onReconciled(() => { refresh(); });
    return () => { try { unsub && unsub(); } catch (_) {} };
  }, [open, refresh]);

  // Also refresh on every export-progress / export-complete (editpanel-queued
  // exports finishing while the editor's looking at the page).
  React.useEffect(() => {
    if (!open) return;
    const handlers = [];
    if (window.exportsAPI?.onProgress) handlers.push(window.exportsAPI.onProgress(() => refresh()));
    if (window.exportsAPI?.onComplete) handlers.push(window.exportsAPI.onComplete(() => refresh()));
    return () => handlers.forEach(u => { try { u && u(); } catch (_) {} });
  }, [open, refresh]);

  async function handleOpenFolder(filePath) {
    if (!window.exportsAPI?.openFolder) return;
    await window.exportsAPI.openFolder({ filePath, dirPath: dirOf(filePath) });
  }

  async function handlePush(project) {
    if (!pickerForRow || !window.exportsAPI?.pushToLpos) return;
    setPushBusy(true);
    setPushError(null);
    try {
      const res = await window.exportsAPI.pushToLpos({
        exportId:    pickerForRow.export_id,
        projectId:   project.projectId,
        projectName: project.name || project.projectName
      });
      if (res?.ok) {
        setPickerForRow(null);
        refresh();
      } else {
        setPushError(res?.error || 'Push failed');
      }
    } catch (err) {
      setPushError(err?.message || String(err));
    } finally {
      setPushBusy(false);
    }
  }

  return (
    <section className="exports-panel">
      <div
        className={`exports-divider${open ? ' open' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setOpen(o => !o); }}
        aria-expanded={open}
      >
        <span className="exports-divider-line" />
        <span className="exports-divider-label">
          · Exports {open ? '▴' : '▾'} ·
        </span>
        <span className="exports-divider-line" />
      </div>

      {open && (
        <div className="exports-body">
          <div className="exports-filters">
            {FILTERS.map(f => (
              <button
                key={f.key}
                type="button"
                className={`exports-filter${filter === f.key ? ' active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
            <span className="exports-filter-spacer" />
            <button type="button" className="btn ghost small" onClick={refresh}>
              Refresh
            </button>
          </div>

          {loading && <p className="muted">Loading…</p>}
          {error && <p className="bad">{error}</p>}
          {!loading && !error && rows.length === 0 && (
            <p className="muted exports-empty">No exports match this filter.</p>
          )}

          {!loading && !error && rows.length > 0 && (
            <div className="exports-list">
              {rows.map(r => (
                <ExportRow
                  key={r.export_id}
                  row={r}
                  onPushClick={setPickerForRow}
                  onOpenFolderClick={handleOpenFolder}
                />
              ))}
            </div>
          )}

          <ProjectPicker
            open={Boolean(pickerForRow)}
            onClose={() => { setPickerForRow(null); setPushError(null); }}
            onPick={handlePush}
          />
          {pickerForRow && pushBusy && (
            <p className="muted">Pushing…</p>
          )}
          {pickerForRow && pushError && (
            <p className="bad">Push failed: {pushError}</p>
          )}
        </div>
      )}
    </section>
  );
}

