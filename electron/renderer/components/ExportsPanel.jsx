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
 *   - Multi-select hard delete (Phase 3.5.1, 2026-06-08) — standard
 *     shift/cmd-click selection on terminal rows; floating action bar shows
 *     "N selected · [Clear] [Delete]"; confirmation modal flags LPOS-link
 *     loss when unassigned rows are in the batch. Wires to
 *     window.exportsAPI.hardDeleteBatch (jobsDb.deleteExportRun under the
 *     hood — hard DELETE, NOT the misleadingly-named export:delete-run
 *     which is JobPanel-side soft-hide).
 *
 * Sort: newest first by started_at. No Dismiss button (history view —
 * nothing to dismiss).
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

// Whether a row is selectable for the multi-select / hard-delete flow.
// Active states (rendering, uploading, queued) are deliberately excluded —
// in-flight work shouldn't be deleted; use cancel instead. Mirrors the
// backend guard in 'exports:hard-delete-batch'.
const NON_SELECTABLE_STATES = new Set(['rendering', 'uploading', 'queued']);
function isSelectableState(state) {
  return !NON_SELECTABLE_STATES.has(state);
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

// ── Confirm-delete modal (Phase 3.5.1) ─────────────────────────
// Triggered from the selection action bar. Renders a count summary, calls
// out the LPOS-link-loss specifically when unassigned rows are in the batch
// (the unique-and-unrecoverable cost of deletion), and a per-row preview
// (first ~6 rows by file name) so the editor can sanity-check before
// committing. Reuses the .export-picker-overlay positioning to stay visually
// consistent with the existing project picker.
function ConfirmDeleteDialog({ rows, busy, error, onCancel, onConfirm }) {
  if (!rows || rows.length === 0) return null;
  const unassignedCount = rows.filter(r => r.state === 'complete_unassigned').length;
  const PREVIEW = 6;
  const preview = rows.slice(0, PREVIEW);
  const more    = Math.max(0, rows.length - PREVIEW);

  return (
    <div className="export-picker-overlay" role="dialog" aria-modal="true" aria-label="Confirm delete">
      <div className="export-picker confirm-delete-dialog">
        <header className="export-picker-head">
          <div>
            <p className="eyebrow">Delete</p>
            <h3>Permanently delete {rows.length} export{rows.length !== 1 ? 's' : ''}?</h3>
          </div>
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        </header>

        <div className="export-picker-body">
          {unassignedCount > 0 && (
            <p className="confirm-delete-warning">
              <strong>{unassignedCount}</strong> of these {unassignedCount === 1 ? 'is' : 'are'}{' '}
              <strong>unassigned</strong>. Deleting them removes any future possibility of
              linking these renders to an LPOS project for comment retrieval.
            </p>
          )}
          <p className="confirm-delete-body">
            All selected exports will be removed from local Exports history. Any files
            already uploaded to LPOS will remain on the LPOS side — only the local
            history rows are deleted. This cannot be undone.
          </p>
          <ul className="confirm-delete-list">
            {preview.map(r => {
              const tail = fileTail(primaryOutputPath(r))
                || (timelineNamesOf(r)[0])
                || r.export_id;
              const badge = stateBadge(r.state);
              return (
                <li key={r.export_id}>
                  <span className={`exports-row-badge exports-row-badge-${badge.cls}`} title={badge.label}>
                    {badge.icon}
                  </span>
                  <span className="confirm-delete-name">{tail}</span>
                  <span className="confirm-delete-state">{badge.label}</span>
                </li>
              );
            })}
            {more > 0 && (
              <li className="confirm-delete-more">…and {more} more</li>
            )}
          </ul>
          {error && <p className="bad">{error}</p>}
        </div>

        <footer className="export-picker-foot">
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Deleting…' : `Delete ${rows.length} export${rows.length !== 1 ? 's' : ''}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ── Selection action bar (Phase 3.5.1) ─────────────────────────
// Slim sticky bar at the top of the Exports body when selection > 0. Mirrors
// the standard pattern (Finder/Mail/anywhere) — count + clear + primary
// destructive action. Esc clears selection (handled in the parent).
function SelectionActionBar({ count, onClear, onDelete }) {
  if (count <= 0) return null;
  return (
    <div className="exports-selection-bar" role="toolbar" aria-label="Selection actions">
      <span className="exports-selection-count">
        {count} selected
      </span>
      <span className="exports-selection-spacer" />
      <button type="button" className="btn ghost small" onClick={onClear}>
        Clear
      </button>
      <button type="button" className="btn danger small" onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────
function ExportRow({
  row, selected, selectable, onRowClick, onPushClick, onOpenFolderClick
}) {
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

  // Clicks on inline action buttons must NOT bubble up to the row root and
  // trigger a selection change. The row's onClick is selection; the
  // buttons keep their existing semantics.
  const stopBubble = (handler) => (e) => { e.stopPropagation(); handler && handler(); };

  const classes = [
    'exports-row',
    `exports-row-${badge.cls}`,
    selectable ? '' : 'unselectable',
    selected   ? 'selected'     : ''
  ].filter(Boolean).join(' ');

  function handleRootClick(e) {
    if (!selectable) return;
    if (!onRowClick) return;
    onRowClick(row.export_id, e);
  }

  return (
    <article
      className={classes}
      onClick={handleRootClick}
      aria-selected={selected || undefined}
    >
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
            onClick={stopBubble(() => onOpenFolderClick(localPrimary))}
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
              onClick={stopBubble(() => onPushClick(row))}
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

// ── Resolve-project grouping (Unassigned filter only) ─────────
// At meaningful unassigned counts the flat list gets noisy — editors usually
// review by source Resolve project ("everything from Project A goes to LPOS
// Project A"), so we bucket the Unassigned view by resolveProjectName and let
// the editor push the whole group with one picker click.
//
// Unknown bucket: reconciled orphans where we couldn't recover the Resolve
// project name (rare — usually means the render was queued by something that
// didn't set TargetDir/JobMeta in the way we expect). These land in a tail
// "Unknown project" group, sorted last so they don't dilute the named ones.
const UNKNOWN_GROUP_KEY = '__unknown_resolve_project__';

function groupByResolveProject(rows) {
  const buckets = new Map(); // key → { projectName: string | null, rows: [], newestStarted: number }
  for (const r of rows) {
    const name = resolveProjectNameOf(r);
    const key = name || UNKNOWN_GROUP_KEY;
    if (!buckets.has(key)) {
      buckets.set(key, { projectName: name, rows: [], newestStarted: 0 });
    }
    const b = buckets.get(key);
    b.rows.push(r);
    if (Number(r.started_at) > b.newestStarted) b.newestStarted = Number(r.started_at);
  }
  // Sort: named groups by newest-row first; the Unknown bucket pinned to the end.
  return Array.from(buckets.entries())
    .map(([key, b]) => ({ key, ...b }))
    .sort((a, b) => {
      if (a.key === UNKNOWN_GROUP_KEY) return 1;
      if (b.key === UNKNOWN_GROUP_KEY) return -1;
      return b.newestStarted - a.newestStarted;
    });
}

// One Resolve-project group: collapsible header + body of ExportRow cards.
// Header carries the project name, the count chip, and (when count > 1) a
// "Push all (N) to LPOS…" button that opens the picker for the whole group.
// Single-item groups omit the group push button — the row's own button does
// the same thing and the duplicate would just add visual noise.
function ResolveProjectGroup({
  group, open, onToggle, onGroupPushClick, onRowPushClick, onOpenFolderClick,
  selectedIds, onRowClick
}) {
  const { projectName, rows } = group;
  const isUnknown = !projectName;
  const count = rows.length;
  const showGroupPush = count > 1;
  return (
    <section className={`exports-group${open ? ' open' : ''}${isUnknown ? ' unknown' : ''}`}>
      <header
        className="exports-group-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        <span className="exports-group-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="exports-group-name">
          {projectName || 'Unknown project'}
        </span>
        <span className="exports-group-count">{count}</span>
        <span className="exports-group-spacer" />
        {showGroupPush && (
          <button
            type="button"
            className="btn primary small exports-group-push"
            onClick={(e) => { e.stopPropagation(); onGroupPushClick(group); }}
          >
            Push all ({count}) to LPOS…
          </button>
        )}
      </header>
      {open && (
        <div className="exports-group-body">
          {rows.map(r => (
            <ExportRow
              key={r.export_id}
              row={r}
              selected={selectedIds ? selectedIds.has(r.export_id) : false}
              selectable={isSelectableState(r.state)}
              onRowClick={onRowClick}
              onPushClick={onRowPushClick}
              onOpenFolderClick={onOpenFolderClick}
            />
          ))}
        </div>
      )}
    </section>
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
  // Group state (Unassigned filter only): pickerForGroup holds the whole group
  // object while its picker is open; groupOpen is a per-group-key collapse map
  // (undefined → expanded; explicit false → collapsed). groupPushFeedback is a
  // transient "Pushed N to <project>" line that auto-clears after a few seconds.
  const [pickerForGroup, setPickerForGroup]       = React.useState(null);
  const [groupOpen, setGroupOpen]                 = React.useState({});
  const [groupPushFeedback, setGroupPushFeedback] = React.useState(null);

  // Phase 3.5.1 (2026-06-08) — multi-select hard-delete state.
  // selectedIds: Set of export_ids currently checked.
  // selectionAnchor: last single-clicked id, used for shift-range extension.
  // confirmRows: when non-null, opens the confirmation modal with this list.
  // deleteBusy / deleteError: modal action state.
  const [selectedIds,     setSelectedIds]     = React.useState(() => new Set());
  const [selectionAnchor, setSelectionAnchor] = React.useState(null);
  const [confirmRows,     setConfirmRows]     = React.useState(null);
  const [deleteBusy,      setDeleteBusy]      = React.useState(false);
  const [deleteError,     setDeleteError]     = React.useState(null);

  // Unassigned-only grouping. Memoized so we don't re-bucket on every render.
  const groupedRows = React.useMemo(
    () => filter === 'unassigned' ? groupByResolveProject(rows) : null,
    [filter, rows]
  );

  // Visible-and-selectable export_ids in DOM order. Used for shift-click
  // range selection and for pruning stale selections when rows change.
  // For the unassigned (grouped) view, walks groups in their sorted order
  // and skips rows in collapsed groups (those aren't rendered, so a
  // shift-range across them would jump invisible rows). For the flat view,
  // just maps rows in their natural order.
  const visibleSelectableIds = React.useMemo(() => {
    const out = [];
    if (filter === 'unassigned' && groupedRows) {
      for (const g of groupedRows) {
        const isOpen = groupOpen[g.key] !== false; // default expanded
        if (!isOpen) continue;
        for (const r of g.rows) {
          if (isSelectableState(r.state)) out.push(r.export_id);
        }
      }
    } else {
      for (const r of rows) {
        if (isSelectableState(r.state)) out.push(r.export_id);
      }
    }
    return out;
  }, [filter, groupedRows, groupOpen, rows]);

  // When rows change (refresh, filter switch, reconciler event after a
  // delete), prune the selection to ids that are still selectable. Avoids
  // a stale id ghosting the action bar count.
  React.useEffect(() => {
    if (selectedIds.size === 0) return;
    const live = new Set(visibleSelectableIds);
    let changed = false;
    const next = new Set();
    for (const id of selectedIds) {
      if (live.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) {
      setSelectedIds(next);
      if (selectionAnchor && !live.has(selectionAnchor)) {
        setSelectionAnchor(null);
      }
    }
  }, [visibleSelectableIds, selectedIds, selectionAnchor]);

  // Esc clears selection. Only when the panel is open and there's something
  // to clear — don't steal Esc from other UI when we're idle.
  React.useEffect(() => {
    if (!open) return;
    if (selectedIds.size === 0 && !confirmRows) return;
    function onKey(e) {
      if (e.key !== 'Escape') return;
      if (confirmRows) {
        // Esc closes the modal first; second Esc clears selection.
        setConfirmRows(null);
        setDeleteError(null);
        return;
      }
      setSelectedIds(new Set());
      setSelectionAnchor(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, selectedIds, confirmRows]);

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

  // Group push: fire pushToLpos for every row in the chosen Resolve-project
  // group concurrently. Each push is fire-and-forget on the main side (returns
  // ok immediately, runs upload in a background IIFE), so launching N in
  // parallel just queues N background uploads — they progress individually in
  // JobPanel. We surface an aggregate "Pushed N to <project>" line that
  // auto-clears after 4.5s; per-row errors continue to show on each row via
  // the existing reconciled-event flow.
  async function handleGroupPush(project) {
    if (!pickerForGroup || !window.exportsAPI?.pushToLpos) return;
    const groupRows = pickerForGroup.rows || [];
    setPushBusy(true);
    setPushError(null);
    try {
      const results = await Promise.allSettled(groupRows.map(r =>
        window.exportsAPI.pushToLpos({
          exportId:    r.export_id,
          projectId:   project.projectId,
          projectName: project.name || project.projectName
        })
      ));
      const ok     = results.filter(r => r.status === 'fulfilled' && r.value?.ok).length;
      const failed = results.length - ok;
      setGroupPushFeedback({
        projectName: project.name || project.projectName,
        ok,
        failed,
        total: results.length
      });
      // Auto-clear the feedback line so it doesn't pile up across sessions.
      setTimeout(() => setGroupPushFeedback(null), 4500);
      setPickerForGroup(null);
      refresh();
    } catch (err) {
      setPushError(err?.message || String(err));
    } finally {
      setPushBusy(false);
    }
  }

  // The ProjectPicker is shared between per-row and per-group pushes — open
  // condition is "either picker target is set"; the chosen onPick routes to
  // whichever flow the user actually invoked.
  const pickerOpen = Boolean(pickerForRow) || Boolean(pickerForGroup);
  function handlePickerClose() {
    setPickerForRow(null);
    setPickerForGroup(null);
    setPushError(null);
  }
  function handlePickerPick(project) {
    if (pickerForGroup) return handleGroupPush(project);
    return handlePush(project);
  }

  function toggleGroup(key) {
    setGroupOpen(prev => ({ ...prev, [key]: prev[key] === false ? true : false }));
  }

  // ── Selection click handler (Phase 3.5.1) ───────────────────
  // Standard shift/cmd-click semantics, matched to Finder/Mail:
  //   plain click        → replace selection with this id; set anchor
  //   cmd/ctrl + click   → toggle this id; set anchor
  //   shift + click      → replace selection with range from anchor to id
  //                        (inclusive, in visible-DOM order); leave anchor
  //   shift + click (no anchor) → falls through to plain click
  // Only fires for selectable rows — non-selectable rows get short-circuited
  // at ExportRow.handleRootClick before we ever see them here.
  const handleRowClick = React.useCallback((exportId, e) => {
    const toggleMod = e.metaKey || e.ctrlKey;
    const rangeMod  = e.shiftKey;

    setSelectedIds(prev => {
      // Range select
      if (rangeMod && selectionAnchor && selectionAnchor !== exportId) {
        const order = visibleSelectableIds;
        const a = order.indexOf(selectionAnchor);
        const b = order.indexOf(exportId);
        if (a === -1 || b === -1) {
          // Anchor or target not visible — fall back to plain replace.
          return new Set([exportId]);
        }
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        return new Set(order.slice(lo, hi + 1));
      }
      // Toggle
      if (toggleMod) {
        const next = new Set(prev);
        if (next.has(exportId)) next.delete(exportId);
        else next.add(exportId);
        return next;
      }
      // Plain
      return new Set([exportId]);
    });

    // Anchor moves on plain click and on cmd/ctrl-toggle; shift-range
    // leaves the anchor in place (matches Finder — shift-clicking around
    // re-anchors from the same point).
    if (!rangeMod) {
      setSelectionAnchor(exportId);
    } else if (!selectionAnchor) {
      // First-ever shift-click without anchor — set anchor now.
      setSelectionAnchor(exportId);
    }
  }, [visibleSelectableIds, selectionAnchor]);

  // Clear selection (action bar Clear button).
  function clearSelection() {
    setSelectedIds(new Set());
    setSelectionAnchor(null);
  }

  // Action bar Delete button → open confirmation modal. Resolves the selected
  // ids to the actual row objects so the modal can show a preview + count
  // the unassigned ones for its LPOS-link warning.
  function openConfirm() {
    if (selectedIds.size === 0) return;
    const byId = new Map(rows.map(r => [r.export_id, r]));
    const selectedRows = [];
    for (const id of selectedIds) {
      const r = byId.get(id);
      if (r) selectedRows.push(r);
    }
    if (selectedRows.length === 0) return;
    setDeleteError(null);
    setConfirmRows(selectedRows);
  }

  // Modal Confirm → fire the batch hard-delete IPC, refresh, clear selection.
  async function handleConfirmDelete() {
    if (!confirmRows || confirmRows.length === 0) return;
    if (!window.exportsAPI?.hardDeleteBatch) {
      setDeleteError('hardDeleteBatch unavailable in preload');
      return;
    }
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const ids = confirmRows.map(r => r.export_id);
      const res = await window.exportsAPI.hardDeleteBatch(ids);
      if (res?.ok) {
        const skipped = Array.isArray(res.data?.skipped) ? res.data.skipped : [];
        setConfirmRows(null);
        clearSelection();
        // Server broadcasts export-reconciled with deletedExportIds; the
        // panel's existing onReconciled listener will refresh. Call refresh
        // here anyway to avoid waiting on the round-trip event.
        await refresh();
        // Surface a soft warning if any rows were skipped (e.g., became
        // active between selection and confirm — rare but possible).
        if (skipped.length > 0) {
          setError(`Skipped ${skipped.length} of ${ids.length}: ${skipped.map(s => s.reason).join('; ')}`);
        }
      } else {
        setDeleteError(res?.error || 'Delete failed');
      }
    } catch (err) {
      setDeleteError(err?.message || String(err));
    } finally {
      setDeleteBusy(false);
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

          <SelectionActionBar
            count={selectedIds.size}
            onClear={clearSelection}
            onDelete={openConfirm}
          />

          {loading && <p className="muted">Loading…</p>}
          {error && <p className="bad">{error}</p>}
          {!loading && !error && rows.length === 0 && (
            <p className="muted exports-empty">No exports match this filter.</p>
          )}

          {!loading && !error && rows.length > 0 && (
            filter === 'unassigned' && groupedRows ? (
              <div className="exports-groups">
                {groupedRows.map(g => (
                  <ResolveProjectGroup
                    key={g.key}
                    group={g}
                    open={groupOpen[g.key] !== false /* default expanded */}
                    onToggle={() => toggleGroup(g.key)}
                    onGroupPushClick={setPickerForGroup}
                    onRowPushClick={setPickerForRow}
                    onOpenFolderClick={handleOpenFolder}
                    selectedIds={selectedIds}
                    onRowClick={handleRowClick}
                  />
                ))}
              </div>
            ) : (
              <div className="exports-list">
                {rows.map(r => (
                  <ExportRow
                    key={r.export_id}
                    row={r}
                    selected={selectedIds.has(r.export_id)}
                    selectable={isSelectableState(r.state)}
                    onRowClick={handleRowClick}
                    onPushClick={setPickerForRow}
                    onOpenFolderClick={handleOpenFolder}
                  />
                ))}
              </div>
            )
          )}

          {/* Transient feedback after a group push. Auto-clears after 4.5s;
              click-through close still available for impatient editors. */}
          {groupPushFeedback && (
            <button
              type="button"
              className={`exports-group-feedback${groupPushFeedback.failed > 0 ? ' has-failures' : ''}`}
              onClick={() => setGroupPushFeedback(null)}
              title="Dismiss"
            >
              {groupPushFeedback.failed === 0
                ? `Pushed ${groupPushFeedback.ok} to ${groupPushFeedback.projectName}`
                : `Pushed ${groupPushFeedback.ok}/${groupPushFeedback.total} to ${groupPushFeedback.projectName} — ${groupPushFeedback.failed} failed`}
            </button>
          )}

          <ProjectPicker
            open={pickerOpen}
            onClose={handlePickerClose}
            onPick={handlePickerPick}
          />
          {pickerOpen && pushBusy && (
            <p className="muted">Pushing{pickerForGroup ? ` ${pickerForGroup.rows.length} exports` : ''}…</p>
          )}
          {pickerOpen && pushError && (
            <p className="bad">Push failed: {pushError}</p>
          )}

          <ConfirmDeleteDialog
            rows={confirmRows}
            busy={deleteBusy}
            error={deleteError}
            onCancel={() => { if (!deleteBusy) { setConfirmRows(null); setDeleteError(null); } }}
            onConfirm={handleConfirmDelete}
          />
        </div>
      )}
    </section>
  );
}

