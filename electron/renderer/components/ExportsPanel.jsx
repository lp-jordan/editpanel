/**
 * ExportsPanel — Phase 3.5 Exports history view.
 *
 * Lives inside the Delivery page, BELOW the existing task grid, under a plain
 * "Exports" heading. Expanded by default; the heading still collapses it.
 * This is the full export HISTORY (open/show in folder, upload, delete); the
 * Jobs panel is only a log of active + recently finished work.
 *
 * Status per row = coloured left stripe + a short text label (exportStatusOf).
 * Copy follows the export glossary: Exporting / Queued / Uploading / Done
 * (local only) / Uploaded (in LPOS) / Unassigned / Failed / Canceled.
 *
 * Data:
 *   - window.exportsAPI.list({ kind, projectId? }) — filtered query against
 *     the editpanel-side export_runs table.
 *   - window.exportsAPI.onReconciled — wakes us on EVERY reconciler-driven
 *     change (orphan discovered, orphan completed, orphan dismissed, push
 *     phase transitions). We refetch on each one.
 *
 * Actions:
 *   - Show in folder — shell.showItemInFolder via exports:open-folder.
 *   - Upload to LPOS… ("push") — inline project picker (reuses lposAPI.listProjects,
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

// The 'delivered' key is the main-process filter for "has an LPOS half"
// (lpos_delivery set or state 'delivered'); the label follows the glossary.
const FILTERS = [
  { key: 'all',        label: 'All' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'delivered',  label: 'Uploaded' },
  { key: 'active',     label: 'Active' },
  { key: 'failed',     label: 'Failed' },
];

// Row → { cls, label }. `cls` drives the coloured left stripe; `label` is the
// short visible status text. 'completed' splits on whether the export reached
// LPOS: Uploaded when it did, Done when it's local only.
function exportStatusOf(row) {
  const state = row?.state;
  switch (state) {
    case 'completed':           return row?.lpos_delivery
                                  ? { cls: 'ok', label: 'Uploaded' }
                                  : { cls: 'ok', label: 'Done' };
    case 'delivered':           return { cls: 'ok',   label: 'Uploaded' };
    case 'complete_unassigned': return { cls: 'wait', label: 'Unassigned' };
    case 'rendering':           return { cls: 'busy', label: 'Exporting' };
    case 'queued':              return { cls: 'busy', label: 'Queued' };
    case 'uploading':           return { cls: 'busy', label: 'Uploading' };
    case 'partial':             return { cls: 'warn', label: 'Partly uploaded' };
    case 'failed':              return { cls: 'bad',  label: 'Failed' };
    case 'canceled':            return { cls: 'mute', label: 'Canceled' };
    case 'interrupted':         return { cls: 'warn', label: 'Interrupted' };
    case 'dismissed_in_resolve':return { cls: 'mute', label: 'Removed from Resolve' };
    default:                    return { cls: 'mute', label: 'Unknown' };
  }
}

// Display name for a row: output file name, else first timeline name.
// Never the raw export_id.
function exportDisplayName(row) {
  const localPrimary = primaryOutputPath(row) || (row?.target_dir ? row.target_dir : null);
  return fileTail(localPrimary) || timelineNamesOf(row)[0] || 'Untitled export';
}

const EXPORTS_CHEVRON_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

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
//
// Phase 3.5.3 (2026-06-08): added a filter-as-you-type search at the top.
// Matches case-insensitively against EITHER project name or client name —
// typing a client name surfaces every project under that client, typing
// part of a project name narrows to that project. Empty client groups
// disappear from the result. Input is autofocused on open and cleared on
// close so each session starts fresh. Cmd/Ctrl+F focuses the input if the
// editor's mid-scroll and reaches for it instinctively.
//
// Upload busy/error state lives INSIDE the picker footer (it used to render
// behind the modal, invisible), and Upload is disabled while busy so a double
// click can't push twice. `uploadCount` > 1 only changes the button label.
function ProjectPicker({ open, onClose, onPick, busy, uploadError, uploadCount }) {
  const [projects, setProjects] = React.useState([]);
  const [loading, setLoading]   = React.useState(false);
  const [error, setError]       = React.useState(null);
  const [picked, setPicked]     = React.useState(null);
  const [query, setQuery]       = React.useState('');
  const searchRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setPicked(null);
    setQuery('');
    if (!window.lposAPI?.listProjects) {
      setError('LPOS API unavailable');
      console.warn('[exports] lposAPI.listProjects unavailable');
      return;
    }
    setLoading(true);
    window.lposAPI.listProjects()
      .then(res => {
        if (res?.ok) setProjects(res.data?.projects || []);
        else {
          setError(res?.error || 'Could not load projects');
          console.warn('[exports] Could not load LPOS projects:', res?.error);
        }
      })
      .catch(err => {
        setError(err?.message || String(err));
        console.warn('[exports] Could not load LPOS projects:', err);
      })
      .finally(() => setLoading(false));
  }, [open]);

  // Autofocus the search input when the modal opens. The data fetch effect
  // above runs first; this runs after the input is in the DOM. Defer with
  // requestAnimationFrame so we focus AFTER the layout pass that mounted
  // the input, not before.
  React.useEffect(() => {
    if (!open) return;
    const raf = window.requestAnimationFrame(() => {
      if (searchRef.current) searchRef.current.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [open]);

  // Cmd/Ctrl+F → focus search input. Standard convention; the editor
  // shouldn't have to reach for the mouse if they're already mid-scroll.
  React.useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (searchRef.current) searchRef.current.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const grouped = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const m = new Map();
    for (const p of projects) {
      if (p.archived) continue;
      const name   = (p.name || p.projectName || '').toLowerCase();
      const client = (p.clientName || '').toLowerCase();
      if (q && !name.includes(q) && !client.includes(q)) continue;
      const k = p.clientName || 'Unassigned';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [projects, query]);

  // Total filtered count — useful for "no matches" copy and as a sanity
  // check during typing. Derived from grouped so we count post-filter.
  const filteredCount = React.useMemo(
    () => grouped.reduce((acc, [, list]) => acc + list.length, 0),
    [grouped]
  );

  if (!open) return null;

  const showNoMatches = !loading && !error && projects.length > 0 && filteredCount === 0;
  const showNoProjects = !loading && !error && projects.length === 0;

  return (
    <div className="export-picker-overlay" role="dialog" aria-modal="true" aria-label="Upload to project">
      <div className="export-picker">
        <header className="export-picker-head">
          <h3>Upload to project</h3>
        </header>

        <div className="export-picker-search">
          <input
            ref={searchRef}
            type="search"
            className="export-picker-search-input"
            placeholder="Search projects or clients…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            // Esc clears the query if any, else closes the modal — matches
            // how text-input dialogs typically handle Esc. Never closes
            // while an upload request is in flight.
            onKeyDown={e => {
              if (e.key === 'Escape') {
                if (query) {
                  e.preventDefault();
                  setQuery('');
                } else if (!busy) {
                  onClose();
                }
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <span className="export-picker-search-meta">
              {filteredCount} match{filteredCount !== 1 ? 'es' : ''}
            </span>
          )}
        </div>

        <div className="export-picker-body">
          {loading && <p className="hint">Loading projects…</p>}
          {error && (
            <div className="notice error" title={String(error)}>
              <span>Couldn't load LPOS projects.</span>
            </div>
          )}
          {showNoProjects && (
            <p className="hint">No projects in LPOS.</p>
          )}
          {showNoMatches && (
            <p className="hint">No projects match “{query}”.</p>
          )}
          {!loading && !error && grouped.map(([client, list]) => (
            <div key={client} className="export-project-group">
              <p className="export-client-name">{client}</p>
              {list.map(p => (
                <label
                  key={p.projectId}
                  className={`export-project-row${picked?.projectId === p.projectId ? ' selected' : ''}`}
                >
                  <input
                    type="radio"
                    name="exports-push-pick"
                    className="export-project-radio"
                    checked={picked?.projectId === p.projectId}
                    onChange={() => setPicked(p)}
                  />
                  <span className="export-project-row-name">{p.name || p.projectName}</span>
                </label>
              ))}
            </div>
          ))}
        </div>

        <footer className="export-picker-foot">
          {uploadError && (
            <span className="error-text export-picker-foot-status" title={String(uploadError)}>
              Upload didn't start. Try again.
            </span>
          )}
          {busy && !uploadError && (
            <span className="hint export-picker-foot-status">Starting upload…</span>
          )}
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="btn primary"
            disabled={!picked || busy}
            onClick={() => { if (picked && !busy) onPick(picked); }}
          >
            {busy ? 'Uploading…' : (uploadCount > 1 ? `Upload ${uploadCount}` : 'Upload')}
          </button>
        </footer>
      </div>
    </div>
  );
}

// ── Confirm-delete modal (Phase 3.5.1) ─────────────────────────
// Triggered from the selection action bar. Heading, one line, one extra line
// when unassigned rows are included (deleting them loses the chance to upload
// them later), then the names (first ~6). Cancel + Delete in the footer.
function ConfirmDeleteDialog({ rows, busy, error, onCancel, onConfirm }) {
  if (!rows || rows.length === 0) return null;
  const unassignedCount = rows.filter(r => r.state === 'complete_unassigned').length;
  const PREVIEW = 6;
  const preview = rows.slice(0, PREVIEW);
  const more    = Math.max(0, rows.length - PREVIEW);
  const noun    = `${rows.length} export${rows.length !== 1 ? 's' : ''}`;

  return (
    <div className="export-picker-overlay" role="dialog" aria-modal="true" aria-label="Confirm delete">
      <div className="export-picker confirm-delete-dialog">
        <header className="export-picker-head">
          <h3>Delete {noun} from history?</h3>
        </header>

        <div className="export-picker-body">
          <p className="confirm-delete-body">
            Files in LPOS aren't affected. Can't be undone.
            {unassignedCount > 0 && (
              <>
                <br />
                {unassignedCount === 1
                  ? '1 is unassigned and can no longer be uploaded to LPOS.'
                  : `${unassignedCount} are unassigned and can no longer be uploaded to LPOS.`}
              </>
            )}
          </p>
          <ul className="confirm-delete-list">
            {preview.map(r => (
              <li key={r.export_id}>
                <span className="confirm-delete-name">{exportDisplayName(r)}</span>
              </li>
            ))}
            {more > 0 && (
              <li className="confirm-delete-more">and {more} more</li>
            )}
          </ul>
          {error && (
            <div className="notice error" title={String(error)}>
              <span>Couldn't delete. Try again.</span>
            </div>
          )}
        </div>

        <footer className="export-picker-foot">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? 'Deleting…' : 'Delete'}
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
        Deselect
      </button>
      <button type="button" className="btn danger small" onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

// ── Row ────────────────────────────────────────────────────────
// Two-line layout (header + meta):
//   HEADER: title                                     [Status]   time
//   META:   resolveProject / timeline  Queued in Resolve   LposProject [Show in folder] [Upload to LPOS…]
//   ERROR:  (only when row.error present; raw text in the tooltip)
// Status = the coloured left stripe (exports-row-<cls>) + the visible label.
// The meta row flexes — the from-info shrinks first, the LPOS name + action
// buttons stay fixed on the right.
function ExportRow({
  row, selected, selectable, onRowClick, onPushClick, onOpenFolderClick
}) {
  const status  = exportStatusOf(row);
  const tl      = timelineNamesOf(row);
  const rpName  = resolveProjectNameOf(row);
  const localPrimary = primaryOutputPath(row)
    || (row.target_dir ? row.target_dir : null);
  const ldelivery = row.lpos_delivery;

  // Contextual sub-text — Resolve project / timeline. No "FROM" label: the
  // muted color + position under the title carry the same meaning.
  const fromInfo = [rpName, tl.length > 0 ? tl.join(', ') : null].filter(Boolean).join(' / ') || null;

  const orphanWaitingAssign = row.state === 'complete_unassigned';

  // LPOS project name — shown muted when known. Dropped for unassigned rows
  // (the Upload button takes over that visual slot).
  const lposName = ldelivery?.project_name
    || (orphanWaitingAssign ? null : row.project_name)
    || null;

  // Multi-file "+N" affordance next to the title.
  const multiFileCount = (Array.isArray(row.output_paths) && row.output_paths.length > 1)
    ? row.output_paths.length
    : 0;

  const titleText = exportDisplayName(row);

  const hasMeta = fromInfo
    || lposName
    || orphanWaitingAssign
    || localPrimary
    || row.source === 'reconciled';

  // Clicks on inline action buttons must NOT bubble up to the row root and
  // trigger a selection change. The row's onClick is selection; the
  // buttons keep their existing semantics.
  const stopBubble = (handler) => (e) => { e.stopPropagation(); handler && handler(); };

  const classes = [
    'exports-row',
    `exports-row-${status.cls}`,
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
        <span className="exports-row-title" title={titleText}>
          {titleText}
          {multiFileCount > 0 && (
            <span className="exports-row-multifile"> +{multiFileCount - 1}</span>
          )}
        </span>
        <span className="exports-row-status">{status.label}</span>
        <span className="exports-row-time">{relativeTime(row.started_at)}</span>
      </header>

      {hasMeta && (
        <div className="exports-row-meta">
          {fromInfo && (
            <span className="exports-row-from" title={fromInfo}>{fromInfo}</span>
          )}
          {row.source === 'reconciled' && (
            <span className="exports-row-hint">Queued in Resolve</span>
          )}
          {lposName && (
            <span className="exports-row-lpos-name" title={`Uploaded to ${lposName}`}>
              {lposName}
            </span>
          )}
          {localPrimary && (
            <button
              type="button"
              className="btn ghost small exports-row-action"
              onClick={stopBubble(() => onOpenFolderClick(localPrimary))}
              title={localPrimary}
            >
              Show in folder
            </button>
          )}
          {orphanWaitingAssign && (
            <button
              type="button"
              className="btn primary small exports-row-action"
              onClick={stopBubble(() => onPushClick(row))}
            >
              Upload to LPOS…
            </button>
          )}
        </div>
      )}

      {row.error && (
        <div className="exports-row-error-line" title={row.error}>
          {exportErrorLine(row)}
        </div>
      )}
    </article>
  );
}

// Plain one-line error for a row; the raw row.error stays in the tooltip.
function exportErrorLine(row) {
  switch (row?.state) {
    case 'partial':             return "Some files didn't upload.";
    case 'complete_unassigned': return "Upload failed. Try again.";
    case 'interrupted':         return 'Stopped when EditPanel closed.';
    case 'failed':              return 'Export failed.';
    default:                    return 'Something went wrong.';
  }
}

// ── Unassigned-exports pill ────────────────────────────────────
// Single non-blocking chip that lives at the top of the JobPanel. Wakes when
// the reconciler discovers a fresh orphan; editor can hide it with ×. Hiding
// stores the current count as a baseline (preferences.exports_pill_dismissed_count);
// the pill reappears the moment a new orphan pushes the live count above it.
// So × is "I saw these, hide until something new" — never "silence forever."
//
// Clicking the pill (anywhere except ×) invokes onClick, which the parent
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
      title="Review on the Deliver page"
    >
      <span className="exports-pill-text">
        {state.count} unassigned export{state.count !== 1 ? 's' : ''}
        <span className="exports-pill-sep" aria-hidden="true"> · </span>
        <span className="exports-pill-cta">Review</span>
      </span>
      <span
        className="exports-pill-dismiss"
        onClick={handleDismiss}
        role="button"
        aria-label="Hide"
        title="Hide"
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
// Header carries the project name, the count chip, and (when count > 1) an
// "Upload all…" button that opens the picker for the whole group.
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
        <span className={`exports-group-chevron${open ? ' open' : ''}`} aria-hidden="true">{EXPORTS_CHEVRON_ICON}</span>
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
            Upload all…
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
function ExportsPanel({ focusToken, focusFilter = 'unassigned' } = {}) {
  // Expanded by default (the history should be visible); the heading toggles.
  const [open, setOpen]       = React.useState(true);
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
  // Non-blocking notice after a partial delete ("Couldn't delete 1 of 3…").
  // Kept separate from `error` so it never hides the list. { text, detail }.
  const [deleteNotice,    setDeleteNotice]    = React.useState(null);

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
        // Esc closes the modal first (not while a delete is running);
        // second Esc clears selection.
        if (deleteBusy) return;
        setConfirmRows(null);
        setDeleteError(null);
        return;
      }
      setSelectedIds(new Set());
      setSelectionAnchor(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, selectedIds, confirmRows, deleteBusy]);

  const refresh = React.useCallback(async () => {
    if (!window.exportsAPI?.list) return;
    setLoading(true);
    setError(null);
    try {
      const res = await window.exportsAPI.list({ kind: filter });
      if (res?.ok) setRows(Array.isArray(res.data) ? res.data : []);
      else {
        setError(res?.error || 'Could not load exports');
        console.warn('[exports] Could not load exports:', res?.error);
      }
    } catch (err) {
      setError(err?.message || String(err));
      console.warn('[exports] Could not load exports:', err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  // Initial load + filter changes — only when expanded (avoid wasted IPC).
  React.useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  // External focus request — pill click in JobPanel bumps focusToken. We
  // expand the panel and snap the filter (Unassigned by default). Each bump = one
  // action; we don't compare prev-vs-next, just react on every change.
  React.useEffect(() => {
    if (focusToken && focusToken > 0) {
      setOpen(true);
      setFilter(focusFilter);
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
    if (pushBusy) return; // double-click guard (button is disabled too)
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
        console.warn('[exports] Upload to LPOS failed to start:', res?.error);
      }
    } catch (err) {
      setPushError(err?.message || String(err));
      console.warn('[exports] Upload to LPOS failed to start:', err);
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
    if (pushBusy) return; // double-click guard (button is disabled too)
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
      results.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value?.ok) return;
        console.warn('[exports] Upload to LPOS failed to start for', groupRows[i]?.export_id,
          r.status === 'rejected' ? r.reason : r.value?.error);
      });
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
      console.warn('[exports] exportsAPI.hardDeleteBatch unavailable in preload');
      return;
    }
    setDeleteBusy(true);
    setDeleteError(null);
    setDeleteNotice(null);
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
        // Surface a soft, NON-blocking notice if any rows were skipped (e.g.,
        // became active between selection and confirm — rare but possible).
        // Plain wording on screen; raw reasons to the console + tooltip.
        if (skipped.length > 0) {
          const detail = skipped.map(s => `${s.exportId}: ${s.reason}`).join('\n');
          console.warn('[exports] Delete skipped some exports:\n' + detail);
          setDeleteNotice({
            text: `Couldn't delete ${skipped.length} of ${ids.length} exports. They may still be in progress.`,
            detail
          });
        }
      } else {
        setDeleteError(res?.error || 'Delete failed');
        console.warn('[exports] Delete failed:', res?.error);
      }
    } catch (err) {
      setDeleteError(err?.message || String(err));
      console.warn('[exports] Delete failed:', err);
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <section className="exports-panel">
      <h2 className="exports-heading">
        <button
          type="button"
          className={`exports-heading-toggle${open ? ' open' : ''}`}
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          title={open ? 'Collapse' : 'Expand'}
        >
          <span className="exports-heading-chevron" aria-hidden="true">{EXPORTS_CHEVRON_ICON}</span>
          Exports
        </button>
      </h2>

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

          {deleteNotice && (
            <div className="notice warning" title={deleteNotice.detail}>
              <span>{deleteNotice.text}</span>
              <button
                type="button"
                className="btn ghost small notice-action"
                onClick={() => setDeleteNotice(null)}
              >
                Dismiss
              </button>
            </div>
          )}

          {loading && <p className="hint">Loading…</p>}
          {error && (
            <div className="notice error" title={String(error)}>
              <span>Couldn't load exports.</span>
              <button type="button" className="btn ghost small notice-action" onClick={refresh}>
                Try again
              </button>
            </div>
          )}
          {!loading && !error && rows.length === 0 && (
            <p className="hint exports-empty">No exports match this filter.</p>
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
                ? `Uploading ${groupPushFeedback.ok} to ${groupPushFeedback.projectName}.`
                : `Uploading ${groupPushFeedback.ok} of ${groupPushFeedback.total} to ${groupPushFeedback.projectName}. ${groupPushFeedback.failed} didn't start.`}
            </button>
          )}

          {/* Upload busy/error state renders inside the picker footer. */}
          <ProjectPicker
            open={pickerOpen}
            onClose={() => { if (!pushBusy) handlePickerClose(); }}
            onPick={handlePickerPick}
            busy={pushBusy}
            uploadError={pushError}
            uploadCount={pickerForGroup ? (pickerForGroup.rows || []).length : 1}
          />

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

