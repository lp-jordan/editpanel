/**
 * JobPanel — slide-up drawer above the status bar.
 *
 * Shows:
 *  • Any currently running job engine jobs with step progress + Cancel
 *  • Recent result runs (spellcheck, audit, etc.) with Review + Clear
 *  • Recent (terminal) engine jobs with Clear
 *  • A footer "Clear finished" action (scoped to the active tab)
 *
 * This is a LOG of active + recently finished work. The full export history
 * (with Delete) is ExportsPanel on the Deliver page. Every × here only clears
 * the row from Jobs, so it is labelled Clear, never Delete.
 *
 * Props:
 *  open          — boolean, whether the panel is visible
 *  onClose       — () => void
 *  dashboard     — { jobs: [], logs_by_job_step: {} }  from controlPlane.buildDashboard()
 *  activeExport  — current in-flight export snapshot, or null
 *  exportVersion — bumps when an export completes, to refresh the recent list
 *  onViewResults — (jobId: string) => void  called when user clicks Review
 */
// Tab keys for the subtle pill bar at the top of the panel body. Engine jobs
// (recipes) don't get their own tab today — they're rare and surface only in
// the 'all' view; if they grow into a meaningful workload they earn one.
const TABS = [
  { key: 'all',        label: 'All' },
  { key: 'exports',    label: 'Exports' },
  { key: 'spellcheck', label: 'Spellcheck' },
  { key: 'comments',   label: 'Comments' }
];

// Static SVGs hoisted out of JobPanel so the chunky-row component can use the
// same iconography without prop-drilling.
const X_ICON = (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const CHEVRON_ICON = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

// Friendly names for engine jobs (recipe ids from orchestrator/recipes.json)
// and their steps. Raw ids never show on screen; they stay in the row tooltip.
const JOB_PRESET_NAMES = {
  lp_base_export_round1: 'Queue exports',
  prepare_project:       'Project setup'
};
const JOB_STEP_NAMES = {
  connect:        'Connecting to Resolve',
  create_bins:    'Creating bins',
  lp_base_export: 'Queuing exports'
};
function friendlyJobName(job) {
  return JOB_PRESET_NAMES[job?.preset_id] || 'Job';
}
function friendlyStepName(step) {
  if (!step) return null;
  return JOB_STEP_NAMES[step.step_id] || JOB_STEP_NAMES[step.cmd] || null;
}

// Engine-job / export state → { dot, label } for the compact rows: a
// .status-dot modifier plus a short text label.
function jobStatusOf(state) {
  switch (state) {
    case 'succeeded':
    case 'completed':   return { dot: 'is-done',    label: 'Done' };
    case 'delivered':   return { dot: 'is-done',    label: 'Uploaded' };
    case 'partial':     return { dot: 'is-error',   label: 'Partly done' };
    case 'failed':      return { dot: 'is-error',   label: 'Failed' };
    case 'interrupted': return { dot: 'is-error',   label: 'Interrupted' };
    case 'canceled':    return { dot: 'is-skipped', label: 'Canceled' };
    case 'complete_unassigned': return { dot: 'is-done', label: 'Unassigned' };
    default:            return { dot: 'is-pending', label: '' };
  }
}

/**
 * Chunky export row — the "in-flight" presentation shared by editpanel-queued
 * exports (driven by the in-memory activeExport singleton) and Resolve-queued
 * orphans in a non-terminal state (driven by the export_runs DB row that the
 * reconcile tick keeps updated). Both surfaces want the same affordances —
 * collapse, headline, per-state badge, full-width progress bar, per-timeline
 * breakdown, substep line — so we render through a single component instead
 * of forking the markup.
 *
 * Props are deliberately normalised (no activeExport / row mix at this layer):
 *  - jobs: [{id, name, mark, done}] where `mark` is already formatted text
 *    (e.g. "47%", "Done", "Uploading 12%"). For orphans we synthesise the mark
 *    from the row-level percent since the reconciler doesn't keep per-job
 *    percents fresh; for editpanel-queued exports it comes from
 *    exportJobMark(activeExport.jobs[i]).
 *  - unassigned: only adds "Unassigned" to the headline tooltip. The
 *    UnassignedExportsPill is the one visible unassigned treatment.
 *  - onStart / onClearQueued: only the editpanel-queued path uses them (queued
 *    state is unreachable for orphans, which are by definition Started in
 *    Resolve before we discover them). onStart is passed only when this is the
 *    single queued batch; with several, the checkboxes + "Start (N)" bar start
 *    them instead.
 */
function RenderingExportRow({
  headline,
  unassigned,
  state,
  percent,
  uploadPercent,
  jobs,
  jobsDone,
  jobCount,
  targetDir,
  projectName,
  collapsed,
  onToggleCollapse,
  onStart,
  onStop,
  onClearQueued,
  selectable,
  selected,
  onToggleSelect,
  upNext
}) {
  const queued    = state === 'queued';
  const uploading = state === 'uploading';
  const pct       = uploading ? (uploadPercent ?? 0) : queued ? 0 : (percent ?? 0);
  const count     = jobCount ?? (jobs ? jobs.length : 0);
  const badge     = queued
    ? `${count} timeline${count !== 1 ? 's' : ''} queued`
    : uploading
    ? `Uploading ${pct}%`
    : count > 1
    ? `Exporting ${jobsDone ?? 0} of ${count}, ${pct}%`
    : `Exporting ${pct}%`;
  const nameTitle = [headline, unassigned ? 'Unassigned' : null].filter(Boolean).join('\n');
  return (
    <div className="job-panel-row active">
      <div className="job-panel-row-top">
        <div className="job-panel-export-head-left">
          {selectable && (
            <input
              type="checkbox"
              className="job-panel-export-select"
              checked={Boolean(selected)}
              onChange={onToggleSelect}
              title="Select to start"
              aria-label="Select this batch to start"
            />
          )}
          <button
            className={`job-panel-collapse-btn${collapsed ? '' : ' open'}`}
            onClick={onToggleCollapse}
            aria-label={collapsed ? 'Expand' : 'Collapse'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {CHEVRON_ICON}
          </button>
          <span className="job-panel-name" title={nameTitle}>{headline}</span>
        </div>
        <div className="job-panel-row-actions">
          <span className="job-panel-step-badge">{badge}</span>
          {queued ? (
            upNext ? (
              <span className="job-panel-headline-hint" title="Starts after the current export">
                Up next
              </span>
            ) : (
              <React.Fragment>
                {onStart && (
                  <button
                    className="btn small"
                    onClick={onStart}
                    title="Start exporting this batch"
                  >
                    Start
                  </button>
                )}
                {onClearQueued && (
                  <button
                    className="job-panel-delete-btn"
                    onClick={onClearQueued}
                    title="Clear from Jobs"
                    aria-label="Clear from Jobs"
                  >
                    {X_ICON}
                  </button>
                )}
              </React.Fragment>
            )
          ) : (
            <button
              className="btn danger small"
              onClick={onStop}
              title={uploading ? 'Stop upload' : 'Stop export'}
            >
              Stop
            </button>
          )}
        </div>
      </div>
      <div className="job-panel-progress-track">
        <div
          className={`job-panel-progress-fill${uploading ? ' result' : ''}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {!collapsed && jobs && jobs.length > 0 && (
        <div className="job-panel-export-jobs">
          {jobs.map(j => (
            <div
              key={j.id}
              className={`job-panel-export-job${j.done ? ' done' : ''}${j.error ? ' error' : ''}`}
            >
              <span className="job-panel-export-job-name">{j.name}</span>
              <span className="job-panel-export-job-mark">{queued ? '' : j.mark}</span>
            </div>
          ))}
        </div>
      )}
      {!collapsed && !queued && (uploading || targetDir) && (
        <p className="job-panel-substep" title={uploading ? undefined : targetDir}>
          {uploading
            ? `Uploading to ${projectName || 'LPOS'}…`
            : targetDir}
        </p>
      )}
    </div>
  );
}

// Non-terminal export states render through RenderingExportRow regardless of
// whether the row came from the in-memory activeExport singleton or the
// export_runs DB (orphan path). Mirrors the activeExport lifecycle: once a
// render reaches a terminal state, the row falls back to the compact display.
const RENDERING_STATES = new Set(['queued', 'rendering', 'uploading']);

function JobPanel({ open, onClose, dashboard, activeExport, exportVersion, onViewResults, onReviewExports }) {
  const [runs, setRuns] = React.useState([]);
  const [loadingRuns, setLoadingRuns] = React.useState(false);
  const [recentExports, setRecentExports] = React.useState([]);
  // Bumps each time we delete/prune so the dashboard reload picks up the change
  const [reloadTick, setReloadTick] = React.useState(0);
  // Export rows the user has collapsed (keyed by export id).
  const [collapsedExports, setCollapsedExports] = React.useState(() => new Set());
  // Queued batches the editor has ticked to run as a sequential chain.
  const [selectedQueued, setSelectedQueued] = React.useState(() => new Set());
  // Queued rows default to COLLAPSED (a large pending queue would otherwise
  // dominate the panel). This set holds the queued rows the user has expanded —
  // the inverse of `collapsedExports`, so the default without an entry is
  // collapsed. Kept separate so it survives reloads (unlike seeding
  // collapsedExports, which a manual expand + reload would fight).
  const [expandedQueued, setExpandedQueued] = React.useState(() => new Set());
  // Active tab (component-local — resets to 'all' each session, which is the
  // right default for a quick-look panel).
  const [activeTab, setActiveTab] = React.useState('all');
  // "Clearing…" guard so double-clicks on Clear-all don't fire concurrent
  // sweeps. The button is also visually disabled while truthy.
  const [clearing, setClearing] = React.useState(false);
  // Ref on the panel inner so a global mousedown can detect clicks outside it.
  const panelRef = React.useRef(null);

  // Close the panel when the user clicks anywhere outside it. The floating
  // Jobs pill that toggles `open` lives in the status bar — we exclude it so
  // the pill keeps acting as a toggle (otherwise the outside-click would close
  // first, then the pill's onClick would reopen on the same gesture).
  React.useEffect(() => {
    if (!open) return undefined;
    function handleMouseDown(event) {
      if (!panelRef.current) return;
      if (panelRef.current.contains(event.target)) return;
      if (event.target.closest && event.target.closest('.floating-jobs-btn')) return;
      onClose();
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open, onClose]);

  function toggleExportCollapsed(id) {
    setCollapsedExports(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Queued rows are collapsed by default, so their toggle drives the
  // `expandedQueued` allow-set instead of the `collapsedExports` deny-set.
  function toggleQueuedCollapsed(id) {
    setExpandedQueued(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Reload result runs whenever panel opens or after a delete/prune
  React.useEffect(() => {
    if (!open || !window.resultsAPI) return;
    setLoadingRuns(true);
    window.resultsAPI.listRuns(10)
      .then(res => setRuns(res?.data ?? []))
      .catch(() => setRuns([]))
      .finally(() => setLoadingRuns(false));
  }, [open, reloadTick]);

  // Reload recent exports on open, on delete/prune, and when one completes
  React.useEffect(() => {
    if (!open || !window.exportsAPI) return;
    window.exportsAPI.getRecent(8)
      .then(res => setRecentExports(res?.data ?? []))
      .catch(() => setRecentExports([]));
  }, [open, reloadTick, exportVersion]);

  const runningJobs = (dashboard?.jobs ?? []).filter(j => j.state === 'running');
  const recentJobs  = (dashboard?.jobs ?? []).filter(j => j.state !== 'running').slice(0, 5);

  // Per-tab counts. Surfaced as small chips next to the tab labels so the
  // editor can tell at a glance whether there's anything in a category before
  // clicking. We deliberately leave a chip-less tab visible at 0 — stable
  // layout beats appearing/disappearing tabs.
  const spellcheckRuns   = runs.filter(r => r.item_type === 'spellcheck');
  const commentPullRuns  = runs.filter(r => r.item_type === 'comment_pull');
  const otherRuns        = runs.filter(r => r.item_type !== 'spellcheck' && r.item_type !== 'comment_pull');
  const exportsCount     = (activeExport ? 1 : 0) + recentExports.filter(e => e.export_id !== activeExport?.exportId).length;
  const tabCounts = {
    all:        exportsCount + runs.length + recentJobs.length + runningJobs.length,
    exports:    exportsCount,
    spellcheck: spellcheckRuns.length,
    comments:   commentPullRuns.length
  };

  // Which sections render under the current tab. 'all' shows everything;
  // category tabs scope to their content and hide Running/Recent engine job
  // boxes (those only make sense in the panoramic 'all' view).
  const showExports    = activeTab === 'all' || activeTab === 'exports';
  const showSpellcheck = activeTab === 'all' || activeTab === 'spellcheck';
  const showComments   = activeTab === 'all' || activeTab === 'comments';
  const showRunning    = activeTab === 'all';
  const showRecent     = activeTab === 'all';
  // The runs subset to feed into the Results section depends on the active
  // tab. 'all' shows everything; per-category tabs narrow to their type.
  const filteredRuns =
      activeTab === 'spellcheck' ? spellcheckRuns
    : activeTab === 'comments'   ? commentPullRuns
    : runs;

  // Status dot + optional short label for compact rows. "Done" is implied by
  // the green dot, so only non-success states print a label.
  function renderStatus(state) {
    const s = jobStatusOf(state);
    const showLabel = s.label && s.dot !== 'is-done';
    return (
      <React.Fragment>
        <span className={`status-dot ${s.dot}`} title={s.label || undefined} aria-label={s.label || undefined} />
        {showLabel && <span className={`job-panel-status-label ${s.dot}`}>{s.label}</span>}
      </React.Fragment>
    );
  }

  function formatAge(ts) {
    if (!ts) return '';
    const diff = Math.round((Date.now() - ts) / 1000);
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function formatDuration(ms) {
    if (!ms || ms <= 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function stepProgress(job) {
    const total = job.steps_total ?? 0;
    const done  = job.steps_done  ?? 0;
    if (total === 0) return null;
    return { done, total, pct: Math.round((done / total) * 100) };
  }

  // Build the headline label for an export_runs row in the compact recent list.
  // Editpanel-queued (or assigned orphans) → the LPOS project name. Orphans
  // without an LPOS assignment fall back to the richest Resolve-side identity
  // we captured at reconcile time (resolveProjectName / TimelineName /
  // CustomName / OutputFilename) so the editor doesn't see a wall of generic
  // rows. Last resort: 'Export'.
  function exportRowLabel(e) {
    if (e.project_name) return e.project_name;
    const j = (e.jobs && e.jobs[0]) || {};
    const proj = j.resolveProjectName || null;
    const tl   = j.TimelineName || j.CustomName || j.OutputFilename || j.RenderJobName || null;
    if (proj && tl) return `${proj} / ${tl}`;
    if (proj)       return proj;
    if (tl)         return tl;
    return 'Export';
  }

  // Combined per-timeline mark: upload state takes over once a render finishes
  // (renders and uploads overlap), otherwise show the render state/percent.
  // Returns { mark, done, error } with `mark` as short visible text.
  function exportJobMark(job) {
    if (job.uploadStatus === 'uploaded')  return { mark: 'Uploaded', done: true };
    if (job.uploadStatus === 'uploading') return { mark: `Uploading ${job.uploadPercent ?? 0}%` };
    // Retrying = LPOS went away mid-upload and the uploader is waiting to
    // resume the same session. Its own mark (not a frozen percent) so a
    // stalled bar doesn't read as a hang the editor should cancel out of.
    if (job.uploadStatus === 'retrying')  return { mark: `Retrying ${job.uploadPercent ?? 0}%` };
    if (job.uploadStatus === 'verifying') return { mark: 'Checking…' };
    if (job.uploadStatus === 'failed')    return { mark: 'Upload failed', error: true };
    if (job.status === 'Complete')  return { mark: 'Done', done: true };
    if (job.status === 'Failed')    return { mark: 'Failed', error: true };
    if (job.status === 'Cancelled') return { mark: 'Canceled' };
    if (job.status === 'Ready' || job.status === 'Queued') return { mark: 'Queued' };
    return { mark: `${job.percent ?? 0}%` };
  }

  async function handleCancelExport() {
    try { await window.exportsAPI.cancel(); } catch (_) {}
  }

  async function handleStartExport() {
    try { await window.exportsAPI.startRender(); } catch (_) {}
  }

  // ── Multi-batch chain ──────────────────────────────────────────────────
  // An export is "in flight" whenever there's an active render/upload. While
  // that holds, queued batches can't be started (keep-it-simple: one chain at a
  // time) and the pending members of the running chain show an "Up next" badge.
  const exportBusy   = Boolean(activeExport);
  const pendingChain = React.useMemo(
    () => new Set(activeExport?.chainPending || []),
    [activeExport]
  );
  // Editpanel-queued batches awaiting a start, newest-first (pipeline order).
  const queuedBatches = React.useMemo(
    () => recentExports.filter(e =>
      e.export_id !== activeExport?.exportId &&
      e.state === 'queued' &&
      e.source !== 'reconciled'),
    [recentExports, activeExport]
  );

  // Drop selections that are no longer queued (started, cleared, completed).
  React.useEffect(() => {
    setSelectedQueued(prev => {
      if (prev.size === 0) return prev;
      const live = new Set(queuedBatches.map(e => e.export_id));
      const next = new Set([...prev].filter(id => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [queuedBatches]);

  function toggleQueuedSelected(exportId) {
    setSelectedQueued(prev => {
      const next = new Set(prev);
      if (next.has(exportId)) next.delete(exportId); else next.add(exportId);
      return next;
    });
  }

  // One queued batch → per-row Start, no checkbox. Several → checkboxes plus
  // one "Start (N)" button.
  const multiQueued = queuedBatches.length > 1;

  // Start the selected batches as a chain, in pipeline (display) order.
  async function handleStartChain() {
    if (exportBusy || selectedQueued.size === 0) return;
    const ordered = queuedBatches
      .map(e => e.export_id)
      .filter(id => selectedQueued.has(id));
    if (ordered.length === 0) return;
    try { await window.exportsAPI.startChain(ordered); } catch (_) {}
    setSelectedQueued(new Set());
  }

  // Start a single queued batch now (a chain of one).
  async function handleStartOneQueued(exportId) {
    if (exportBusy) return;
    try { await window.exportsAPI.startChain([exportId]); } catch (_) {}
  }

  async function handleCancelJob(jobId) {
    try { await window.electronAPI.cancelJob(jobId); } catch (_) {}
    setReloadTick(t => t + 1);
  }

  async function handleDeleteJob(jobId) {
    try { await window.electronAPI.deleteJob(jobId); } catch (_) {}
    setReloadTick(t => t + 1);
  }

  async function handleDeleteRun(jobId) {
    try { await window.resultsAPI.deleteRun(jobId); } catch (_) {}
    setReloadTick(t => t + 1);
  }

  async function handleDeleteExportRun(exportId) {
    try { await window.exportsAPI.deleteRun(exportId); } catch (_) {}
    setReloadTick(t => t + 1);
  }

  // Tab-scoped Clear-all. Each tab clears its own category; the All tab fans
  // out across categories so one click empties everything terminal. Engine
  // jobs (recipes) are pruned with 0ms = "anything older than now," which
  // effectively means every terminal job. The active export is never touched.
  async function handleClearAll() {
    if (clearing) return;
    setClearing(true);
    try {
      const tasks = [];
      if (activeTab === 'all' || activeTab === 'exports') {
        if (window.exportsAPI?.clearTerminal) tasks.push(window.exportsAPI.clearTerminal());
      }
      if (activeTab === 'all' || activeTab === 'spellcheck') {
        // pruneRuns currently takes an "older than" ms cutoff; 0 means
        // "everything finished before this instant." For per-type clearing
        // we filter client-side after listing, then delete one-by-one. The
        // listRuns path returns all types — we just delete the matching ones.
        if (window.resultsAPI?.deleteRun) {
          const spell = runs.filter(r => r.item_type === 'spellcheck');
          tasks.push(...spell.map(r => window.resultsAPI.deleteRun(r.job_id)));
        }
      }
      if (activeTab === 'all' || activeTab === 'comments') {
        if (window.resultsAPI?.deleteRun) {
          const pulls = runs.filter(r => r.item_type === 'comment_pull');
          tasks.push(...pulls.map(r => window.resultsAPI.deleteRun(r.job_id)));
        }
      }
      if (activeTab === 'all') {
        if (window.electronAPI?.pruneJobs) tasks.push(window.electronAPI.pruneJobs(0));
      }
      await Promise.all(tasks.map(p => p.catch(() => {})));
    } finally {
      setClearing(false);
      setReloadTick(t => t + 1);
    }
  }

  const xIcon = X_ICON;

  async function handleStopOrphan(exportId) {
    try { await window.exportsAPI.stopRendering(exportId); } catch (_) {}
  }

  return (
    <div className={`job-panel${open ? ' open' : ''}`} role="dialog" aria-label="Jobs">
      <div className="job-panel-inner" ref={panelRef}>
        <header className="job-panel-header">
          <span className="job-panel-title">Jobs</span>
          <button className="job-panel-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <div className="job-panel-body">

          {/* Tab bar — subtle pills, always visible, counts when > 0. */}
          <div className="job-panel-tabs" role="tablist" aria-label="Job categories">
            {TABS.map(t => {
              const count = tabCounts[t.key] || 0;
              return (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === t.key}
                  className={`job-panel-tab${activeTab === t.key ? ' active' : ''}`}
                  onClick={() => setActiveTab(t.key)}
                >
                  {t.label}
                  {count > 0 && <span className="job-panel-tab-count">{count}</span>}
                </button>
              );
            })}
          </div>

          {/* Phase 3.5: clearable pill for orphans awaiting LPOS assignment.
              Component is defined in ExportsPanel.jsx (loaded before App.jsx
              in index.html, so it's resolvable here as a global). Renders
              nothing when there's nothing fresh to nudge about. Only on the
              All tab — the per-category tabs have their own focus. */}
          {activeTab === 'all' && typeof UnassignedExportsPill !== 'undefined' && (
            <UnassignedExportsPill onClick={onReviewExports} />
          )}

          {/* ── Exports / renders ── */}
          {showExports && (activeExport || recentExports.some(e => e.export_id !== activeExport?.exportId)) && (
            <section className="job-panel-section">
              <p className="job-panel-section-label">Exports</p>

              {/* Several queued batches: tick them and start them back-to-back
                  with one button. Hidden while an export is in flight (one run
                  at a time). A single queued batch gets a per-row Start instead. */}
              {multiQueued && !exportBusy && (
                <div className="job-panel-chain-bar">
                  <button
                    className="btn small"
                    disabled={selectedQueued.size === 0}
                    onClick={handleStartChain}
                    title="Export the selected batches one after another"
                  >
                    Start ({selectedQueued.size})
                  </button>
                </div>
              )}
              {exportBusy && pendingChain.size > 0 && (
                <p className="job-panel-chain-note">
                  {pendingChain.size} more up next.
                </p>
              )}

              {activeExport && (
                <RenderingExportRow
                  headline={activeExport.projectName || 'Export'}
                  unassigned={false}
                  state={activeExport.state}
                  percent={activeExport.percent ?? 0}
                  uploadPercent={activeExport.uploadPercent ?? 0}
                  jobs={activeExport.jobs.map(j => {
                    const m = exportJobMark(j);
                    return {
                      id: j.job_id,
                      name: j.name || 'Untitled timeline',
                      mark: m.mark,
                      done: m.done,
                      error: m.error
                    };
                  })}
                  jobsDone={activeExport.jobsDone}
                  jobCount={activeExport.jobs.length}
                  targetDir={activeExport.targetDir}
                  projectName={activeExport.projectName}
                  collapsed={collapsedExports.has(activeExport.exportId)}
                  onToggleCollapse={() => toggleExportCollapsed(activeExport.exportId)}
                  onStart={handleStartExport}
                  onStop={handleCancelExport}
                  onClearQueued={handleCancelExport}
                />
              )}

              {recentExports
                .filter(e => e.export_id !== activeExport?.exportId)
                .map(e => {
                  // Orphan = caught from Resolve's render queue, not queued via
                  // editpanel. Until the editor assigns an LPOS project the row
                  // stays in this in-between state. The UnassignedExportsPill
                  // is the visible treatment; rows only carry it in a tooltip.
                  const isUnassignedOrphan = e.source === 'reconciled' && !e.project_name;

                  // Editpanel-queued batch awaiting a start. With several
                  // queued batches it gets a checkbox (started via the
                  // "Start (N)" bar); a lone batch gets a per-row Start. A
                  // pending member of the running chain shows "Up next".
                  // (Orphans are never in 'queued' — they're discovered
                  // already rendering — so this branch is editpanel-queued
                  // batches only.)
                  if (e.state === 'queued' && e.source !== 'reconciled') {
                    const inChain = pendingChain.has(e.export_id);
                    return (
                      <RenderingExportRow
                        key={e.export_id}
                        headline={exportRowLabel(e)}
                        unassigned={false}
                        state="queued"
                        percent={0}
                        jobs={(e.jobs || []).map(j => ({
                          id: String(j.job_id || j.JobId || ''),
                          name: j.name || j.TimelineName || j.CustomName || 'Untitled timeline',
                          mark: ''
                        }))}
                        jobsDone={0}
                        jobCount={e.job_count ?? (e.jobs || []).length}
                        targetDir={e.target_dir}
                        projectName={e.project_name}
                        collapsed={!expandedQueued.has(e.export_id)}
                        onToggleCollapse={() => toggleQueuedCollapsed(e.export_id)}
                        onStart={exportBusy || multiQueued ? null : () => handleStartOneQueued(e.export_id)}
                        onClearQueued={exportBusy ? null : () => handleDeleteExportRun(e.export_id)}
                        selectable={!exportBusy && multiQueued}
                        selected={selectedQueued.has(e.export_id)}
                        onToggleSelect={() => toggleQueuedSelected(e.export_id)}
                        upNext={inChain}
                      />
                    );
                  }

                  // Non-terminal rows (orphan rendering through the reconcile
                  // tick, post-assignment uploads) get the chunky in-flight
                  // presentation that mirrors the editpanel-queued activeExport
                  // row — progress bar, badge, per-timeline breakdown, Stop
                  // button. Once the row goes terminal it falls back to compact.
                  if (RENDERING_STATES.has(e.state)) {
                    // Normalize the jobs_json shape (uppercased keys) into the
                    // {id, name, mark} contract RenderingExportRow expects.
                    // Per-job percent inside jobs_json isn't kept fresh by the
                    // reconciler — only the row-level `percent` is — so we
                    // synthesise each timeline's mark from the row-level value.
                    // For the typical single-timeline orphan this is exactly
                    // what the editor would expect to see.
                    const rowPct = e.percent ?? 0;
                    const normalizedJobs = (e.jobs || []).map(j => ({
                      id: String(j.JobId || j.job_id || ''),
                      name: j.TimelineName || j.CustomName || j.OutputFilename || j.RenderJobName || j.name || 'Untitled timeline',
                      mark: e.state === 'uploading'
                        ? `Uploading ${rowPct}%`
                        : e.state === 'rendering'
                        ? `${rowPct}%`
                        : ''
                    }));
                    const headline = exportRowLabel(e);
                    return (
                      <RenderingExportRow
                        key={e.export_id}
                        headline={headline}
                        unassigned={isUnassignedOrphan}
                        state={e.state}
                        percent={rowPct}
                        uploadPercent={rowPct}
                        jobs={normalizedJobs}
                        jobsDone={e.jobs_done ?? 0}
                        jobCount={e.job_count ?? normalizedJobs.length}
                        targetDir={e.target_dir}
                        projectName={e.project_name}
                        collapsed={collapsedExports.has(e.export_id)}
                        onToggleCollapse={() => toggleExportCollapsed(e.export_id)}
                        onStart={null}
                        onStop={() => handleStopOrphan(e.export_id)}
                        onClearQueued={null}
                      />
                    );
                  }

                  // Compact finished row: status dot (+ label when not Done),
                  // name, age. Timeline count only when partial; duration and
                  // destination live in the tooltip.
                  const doneCount  = e.jobs_done ?? 0;
                  const totalCount = e.job_count ?? 0;
                  const isPartialCount = totalCount > 0 && doneCount < totalCount;
                  const statusState = e.state === 'completed' && e.lpos_delivery ? 'delivered' : e.state;
                  const titleParts = [];
                  if (e.project_name) titleParts.push(`LPOS: ${e.project_name}`);
                  if (e.target_dir)   titleParts.push(`Output: ${e.target_dir}`);
                  if (isUnassignedOrphan) titleParts.push('Unassigned');
                  if (e.finished_at && e.started_at) titleParts.push(`Took ${formatDuration(e.finished_at - e.started_at)}`);
                  const rowTitle = titleParts.join('\n') || undefined;
                  return (
                    <div
                      key={e.export_id}
                      className="job-panel-row compact"
                      title={rowTitle}
                    >
                      {renderStatus(statusState)}
                      <span className="job-panel-name">{exportRowLabel(e)}</span>
                      {isPartialCount && (
                        <span className="job-panel-age">{doneCount}/{totalCount}</span>
                      )}
                      <span className="job-panel-age">{formatAge(e.finished_at || e.started_at)}</span>
                      <button
                        className="job-panel-delete-btn"
                        onClick={() => handleDeleteExportRun(e.export_id)}
                        title="Clear from Jobs"
                        aria-label="Clear from Jobs"
                      >
                        {xIcon}
                      </button>
                    </div>
                  );
                })}
            </section>
          )}

          {/* ── Active jobs ── */}
          {showRunning && runningJobs.length > 0 && (
            <section className="job-panel-section">
              <p className="job-panel-section-label">Running</p>
              {runningJobs.map(job => {
                const prog = stepProgress(job);
                const stepName = friendlyStepName(job.active_step);
                // Raw ids stay available on hover for debugging.
                const rawTitle = [job.preset_id, job.job_id, job.active_step?.cmd || job.active_step?.worker]
                  .filter(Boolean).join('\n');
                return (
                  <div key={job.job_id} className="job-panel-row active">
                    <div className="job-panel-row-top">
                      <span className="job-panel-name" title={rawTitle}>{friendlyJobName(job)}</span>
                      <div className="job-panel-row-actions">
                        {prog && (
                          <span className="job-panel-step-badge">Step {prog.done} of {prog.total}</span>
                        )}
                        <button
                          className="btn danger small"
                          onClick={() => handleCancelJob(job.job_id)}
                          title="Cancel job"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                    {prog && (
                      <div className="job-panel-progress-track">
                        <div
                          className="job-panel-progress-fill"
                          style={{ width: `${prog.pct}%` }}
                        />
                      </div>
                    )}
                    {stepName && (
                      <p className="job-panel-substep">{stepName}…</p>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {/* ── Result runs ── */}
          {(showSpellcheck || showComments) && (loadingRuns || filteredRuns.length > 0) && (
            <section className="job-panel-section">
              <p className="job-panel-section-label">
                {activeTab === 'spellcheck' ? 'Spellcheck runs'
                  : activeTab === 'comments' ? 'Comment pulls'
                  : 'Results'}
              </p>
              {loadingRuns && <p className="job-panel-empty">Loading…</p>}
              {!loadingRuns && filteredRuns.map(run => {
                // Phase 5c.8 (2026-06-02): comment_pull runs aren't a per-item
                // review flow — every item is informational (state stays
                // 'pending' because nothing's resolved or skipped). Show a
                // 'View Report' button and a one-line summary instead of
                // resolved/skipped/pending counts + a progress bar that never
                // moves.
                const isCommentPull = run.item_type === 'comment_pull';
                if (isCommentPull) {
                  return (
                    <div key={run.job_id} className="job-panel-row comment-pull-row">
                      <div className="job-panel-row-top">
                        <div>
                          <span className="job-panel-name">{run.label}</span>
                          <span className="job-panel-age">{formatAge(run.created_at)}</span>
                        </div>
                        <div className="job-panel-row-actions">
                          <button
                            className="btn ghost small"
                            onClick={() => onViewResults(run.job_id)}
                          >
                            View report
                          </button>
                          <button
                            className="job-panel-delete-btn"
                            onClick={() => handleDeleteRun(run.job_id)}
                            title="Clear from Jobs"
                            aria-label="Clear from Jobs"
                          >
                            {xIcon}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                }

                // Spellcheck-with-zero-issues: register that the run happened
                // (so the editor has proof) but skip the Review button and the
                // resolved/skipped/pending substep — there's nothing to review.
                // Shows a green status dot + "No issues" in line with the success
                // color used elsewhere in this panel.
                const noItems = run.total === 0;
                if (noItems) {
                  return (
                    <div key={run.job_id} className="job-panel-row compact">
                      {renderStatus('succeeded')}
                      <span className="job-panel-name">{run.label}</span>
                      <span className="job-panel-age">No issues</span>
                      <span className="job-panel-age">{formatAge(run.created_at)}</span>
                      <button
                        className="job-panel-delete-btn"
                        onClick={() => handleDeleteRun(run.job_id)}
                        title="Clear from Jobs"
                        aria-label="Clear from Jobs"
                      >
                        {xIcon}
                      </button>
                    </div>
                  );
                }

                const pct = run.total > 0
                  ? Math.round(((run.resolved + run.skipped) / run.total) * 100)
                  : 0;
                const isDone = run.pending === 0 && run.total > 0;
                return (
                  <div key={run.job_id} className="job-panel-row">
                    <div className="job-panel-row-top">
                      <div>
                        <span className="job-panel-name">{run.label}</span>
                        <span className="job-panel-age">{formatAge(run.created_at)}</span>
                      </div>
                      <div className="job-panel-row-actions">
                        <button
                          className="btn ghost small"
                          onClick={() => onViewResults(run.job_id)}
                        >
                          {!isDone && run.pending > 0 ? `Resume (${run.pending})` : 'Review'}
                        </button>
                        <button
                          className="job-panel-delete-btn"
                          onClick={() => handleDeleteRun(run.job_id)}
                          title="Clear from Jobs"
                          aria-label="Clear from Jobs"
                        >
                          {xIcon}
                        </button>
                      </div>
                    </div>
                    <div className="job-panel-progress-track">
                      <div
                        className="job-panel-progress-fill result"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="job-panel-substep">
                      {run.resolved} resolved, {run.skipped} skipped, {run.pending} pending
                    </p>
                  </div>
                );
              })}
            </section>
          )}

          {/* ── Recent engine jobs ── */}
          {showRecent && recentJobs.length > 0 && (
            <section className="job-panel-section">
              <p className="job-panel-section-label">Recent</p>
              {recentJobs.map(job => (
                <div
                  key={job.job_id}
                  className="job-panel-row compact"
                  title={[
                    job.preset_id,
                    job.job_id,
                    job.finished_at && job.started_at ? `Took ${formatDuration(job.finished_at - job.started_at)}` : null
                  ].filter(Boolean).join('\n')}
                >
                  {renderStatus(job.state)}
                  <span className="job-panel-name">{friendlyJobName(job)}</span>
                  <span className="job-panel-age">{formatAge(job.finished_at || job.created_at)}</span>
                  <button
                    className="job-panel-delete-btn"
                    onClick={() => handleDeleteJob(job.job_id)}
                    title="Clear from Jobs"
                    aria-label="Clear from Jobs"
                  >
                    {xIcon}
                  </button>
                </div>
              ))}
            </section>
          )}

          {tabCounts[activeTab] === 0 && !loadingRuns && (
            <p className="job-panel-empty">
              {activeTab === 'all'        ? 'No jobs yet.'
                : activeTab === 'exports'   ? 'No exports yet.'
                : activeTab === 'spellcheck' ? 'No spellcheck runs yet.'
                : activeTab === 'comments'   ? 'No comment pulls yet.'
                : 'Nothing here.'}
            </p>
          )}

        </div>

        {tabCounts[activeTab] > 0 && (
          <footer className="job-panel-footer">
            <button
              className="job-panel-clear-old-btn"
              onClick={handleClearAll}
              disabled={clearing}
              title={activeTab === 'all'
                ? 'Clear finished items from Jobs'
                : `Clear finished ${activeTab === 'exports' ? 'exports' : activeTab === 'spellcheck' ? 'spellcheck runs' : 'comment pulls'} from Jobs`}
            >
              {clearing ? 'Clearing…' : 'Clear finished'}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
