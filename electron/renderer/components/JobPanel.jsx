/**
 * JobPanel — slide-up drawer above the status bar.
 *
 * Shows:
 *  • Any currently running job engine jobs with step progress + Cancel
 *  • Recent result runs (spellcheck, audit, etc.) with Review + Delete
 *  • Recent (terminal) engine jobs with Delete
 *  • A footer action to clear everything older than 30 days
 *
 * Props:
 *  open          — boolean, whether the panel is visible
 *  onClose       — () => void
 *  dashboard     — { jobs: [], logs_by_job_step: {} }  from controlPlane.buildDashboard()
 *  activeExport  — current in-flight export snapshot, or null
 *  exportVersion — bumps when an export completes, to refresh the recent list
 *  onViewResults — (jobId: string) => void  called when user clicks Review
 */
function JobPanel({ open, onClose, dashboard, activeExport, exportVersion, onViewResults, onReviewExports }) {
  const [runs, setRuns] = React.useState([]);
  const [loadingRuns, setLoadingRuns] = React.useState(false);
  const [recentExports, setRecentExports] = React.useState([]);
  // Bumps each time we delete/prune so the dashboard reload picks up the change
  const [reloadTick, setReloadTick] = React.useState(0);
  // Export rows the user has collapsed (keyed by export id).
  const [collapsedExports, setCollapsedExports] = React.useState(() => new Set());
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

  function formatState(state) {
    if (state === 'succeeded') return '✓';
    if (state === 'failed')    return '✗';
    if (state === 'canceled')  return '–';
    return state;
  }

  function formatAge(ts) {
    if (!ts) return '';
    const diff = Math.round((Date.now() - ts) / 1000);
    if (diff < 60)   return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
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

  function formatExportState(state) {
    if (state === 'completed')   return '✓';
    if (state === 'partial')     return '⚠';
    if (state === 'failed')      return '✗';
    if (state === 'canceled')    return '–';
    if (state === 'interrupted') return '!';
    return state;
  }

  // Map export states onto the existing state-icon CSS classes for colour reuse.
  function exportRowState(state) {
    if (state === 'completed')                         return 'succeeded';
    if (state === 'failed' || state === 'interrupted') return 'failed';
    if (state === 'partial')                           return 'failed';
    if (state === 'canceled')                          return 'canceled';
    return state;
  }

  // Combined per-timeline mark: upload state takes over once a render finishes
  // (renders and uploads overlap), otherwise show the render state/percent.
  function exportJobMark(job) {
    if (job.uploadStatus === 'uploaded')  return '✓';
    if (job.uploadStatus === 'uploading') return `↑${job.uploadPercent ?? 0}%`;
    if (job.uploadStatus === 'verifying') return '…';
    if (job.uploadStatus === 'failed')    return '✗';
    if (job.status === 'Complete')  return '✓';
    if (job.status === 'Failed')    return '✗';
    if (job.status === 'Cancelled') return '–';
    if (job.status === 'Ready' || job.status === 'Queued') return '·';
    return `${job.percent ?? 0}%`;
  }

  async function handleCancelExport() {
    try { await window.exportsAPI.cancel(); } catch (_) {}
  }

  async function handleStartExport() {
    try { await window.exportsAPI.startRender(); } catch (_) {}
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

  async function handleClearOld() {
    // 30 days. Engine jobs use ms; result runs use ms.
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    try {
      await Promise.all([
        window.electronAPI.pruneJobs(THIRTY_DAYS_MS),
        window.resultsAPI.pruneRuns(THIRTY_DAYS_MS)
      ]);
    } catch (_) {}
    setReloadTick(t => t + 1);
  }

  const xIcon = (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );

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

          {/* Phase 3.5: clearable pill for orphans awaiting LPOS assignment.
              Component is defined in ExportsPanel.jsx (loaded before App.jsx
              in index.html, so it's resolvable here as a global). Renders
              nothing when there's nothing fresh to nudge about. */}
          {typeof UnassignedExportsPill !== 'undefined' && (
            <UnassignedExportsPill onClick={onReviewExports} />
          )}

          {/* ── Exports / renders ── */}
          {(activeExport || recentExports.some(e => e.export_id !== activeExport?.exportId)) && (
            <section className="job-panel-section">
              <p className="job-panel-section-label">Exports</p>

              {activeExport && (() => {
                const queued    = activeExport.state === 'queued';
                const uploading = activeExport.state === 'uploading';
                const rendering = activeExport.state === 'rendering';
                const pct = uploading ? (activeExport.uploadPercent ?? 0) : queued ? 0 : (activeExport.percent ?? 0);
                const count = activeExport.jobs.length;
                const badge = queued
                  ? `Queued · ${count} timeline${count !== 1 ? 's' : ''}`
                  : uploading
                  ? `Uploading ${pct}%`
                  : `${activeExport.jobsDone}/${count} · ${pct}%`;
                const collapsed = collapsedExports.has(activeExport.exportId);
                return (
                  <div className="job-panel-row active">
                    <div className="job-panel-row-top">
                      <div className="job-panel-export-head-left">
                        <button
                          className={`job-panel-collapse-btn${collapsed ? '' : ' open'}`}
                          onClick={() => toggleExportCollapsed(activeExport.exportId)}
                          aria-label={collapsed ? 'Expand' : 'Collapse'}
                          aria-expanded={!collapsed}
                          title={collapsed ? 'Expand' : 'Collapse'}
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="9 6 15 12 9 18" />
                          </svg>
                        </button>
                        <span className="job-panel-name">
                          {activeExport.projectName ? `→ ${activeExport.projectName}` : 'Render'}
                        </span>
                      </div>
                      <div className="job-panel-row-actions">
                        <span className="job-panel-step-badge">{badge}</span>
                        {queued ? (
                          <React.Fragment>
                            <button
                              className="job-panel-review-btn done"
                              onClick={handleStartExport}
                              title="Start rendering"
                            >
                              Start
                            </button>
                            <button
                              className="job-panel-delete-btn"
                              onClick={handleCancelExport}
                              title="Clear queued export"
                              aria-label="Clear queued export"
                            >
                              {xIcon}
                            </button>
                          </React.Fragment>
                        ) : (
                          <button
                            className="job-panel-cancel-btn"
                            onClick={handleCancelExport}
                            title={uploading ? 'Stop upload' : 'Stop render'}
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
                    {!collapsed && (
                      <div className="job-panel-export-jobs">
                        {activeExport.jobs.map(job => {
                          const mark = queued ? '·' : exportJobMark(job);
                          return (
                            <div
                              key={job.job_id}
                              className={`job-panel-export-job${mark === '✓' ? ' done' : ''}`}
                            >
                              <span className="job-panel-export-job-name">{job.name}</span>
                              <span className="job-panel-export-job-mark">{mark}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {!collapsed && (
                      <p className="job-panel-substep">
                        {queued
                          ? 'Queued in Resolve — press Start when ready'
                          : uploading
                          ? `Uploading to ${activeExport.projectName || 'LPOS'}…`
                          : (activeExport.targetDir || '')}
                      </p>
                    )}
                  </div>
                );
              })()}

              {recentExports
                .filter(e => e.export_id !== activeExport?.exportId)
                .map(e => (
                  <div key={e.export_id} className={`job-panel-row compact ${exportRowState(e.state)}`}>
                    <span className={`job-panel-state-icon ${exportRowState(e.state)}`}>
                      {formatExportState(e.state)}
                    </span>
                    <span className="job-panel-name">{e.project_name || 'Render'}</span>
                    <span className="job-panel-age">{e.jobs_done}/{e.job_count}</span>
                    {e.finished_at && e.started_at && (
                      <span className="job-panel-age">{formatDuration(e.finished_at - e.started_at)}</span>
                    )}
                    <span className="job-panel-age">{formatAge(e.finished_at || e.started_at)}</span>
                    <button
                      className="job-panel-delete-btn"
                      onClick={() => handleDeleteExportRun(e.export_id)}
                      title="Delete this export"
                      aria-label="Delete this export"
                    >
                      {xIcon}
                    </button>
                  </div>
                ))}
            </section>
          )}

          {/* ── Active jobs ── */}
          {runningJobs.length > 0 && (
            <section className="job-panel-section">
              <p className="job-panel-section-label">Running</p>
              {runningJobs.map(job => {
                const prog = stepProgress(job);
                return (
                  <div key={job.job_id} className="job-panel-row active">
                    <div className="job-panel-row-top">
                      <span className="job-panel-name">{job.preset_id || job.job_id.slice(0, 8)}</span>
                      <div className="job-panel-row-actions">
                        {prog && (
                          <span className="job-panel-step-badge">{prog.done}/{prog.total}</span>
                        )}
                        <button
                          className="job-panel-cancel-btn"
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
                    {job.active_step && (
                      <p className="job-panel-substep">
                        {job.active_step.cmd || job.active_step.worker}
                      </p>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {/* ── Result runs ── */}
          {(loadingRuns || runs.length > 0) && (
            <section className="job-panel-section">
              <p className="job-panel-section-label">Results</p>
              {loadingRuns && <p className="job-panel-empty">Loading…</p>}
              {!loadingRuns && runs.map(run => {
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
                            className="job-panel-review-btn done"
                            onClick={() => onViewResults(run.job_id)}
                          >
                            View Report
                          </button>
                          <button
                            className="job-panel-delete-btn"
                            onClick={() => handleDeleteRun(run.job_id)}
                            title="Delete this run"
                            aria-label="Delete this run"
                          >
                            {xIcon}
                          </button>
                        </div>
                      </div>
                      <p className="job-panel-substep">
                        View the report for a full breakdown.
                      </p>
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
                          className={`job-panel-review-btn${isDone ? ' done' : ''}`}
                          onClick={() => onViewResults(run.job_id)}
                        >
                          {isDone ? 'Done' : run.pending > 0 ? `Resume (${run.pending})` : 'Review'}
                        </button>
                        <button
                          className="job-panel-delete-btn"
                          onClick={() => handleDeleteRun(run.job_id)}
                          title="Delete this run"
                          aria-label="Delete this run"
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
                      {run.resolved} resolved · {run.skipped} skipped · {run.pending} pending
                    </p>
                  </div>
                );
              })}
            </section>
          )}

          {/* ── Recent engine jobs ── */}
          {recentJobs.length > 0 && (
            <section className="job-panel-section">
              <p className="job-panel-section-label">Recent</p>
              {recentJobs.map(job => (
                <div key={job.job_id} className={`job-panel-row compact ${job.state}`}>
                  <span className={`job-panel-state-icon ${job.state}`}>
                    {formatState(job.state)}
                  </span>
                  <span className="job-panel-name">{job.preset_id || job.job_id.slice(0, 8)}</span>
                  {job.finished_at && job.started_at && (
                    <span className="job-panel-age">
                      {formatDuration(job.finished_at - job.started_at)}
                    </span>
                  )}
                  <span className="job-panel-age">{formatAge(job.finished_at || job.created_at)}</span>
                  <button
                    className="job-panel-delete-btn"
                    onClick={() => handleDeleteJob(job.job_id)}
                    title="Delete this job"
                    aria-label="Delete this job"
                  >
                    {xIcon}
                  </button>
                </div>
              ))}
            </section>
          )}

          {runningJobs.length === 0 && runs.length === 0 && recentJobs.length === 0
            && !activeExport && recentExports.length === 0 && !loadingRuns && (
            <p className="job-panel-empty">No jobs yet.</p>
          )}

        </div>

        {(runs.length > 0 || recentJobs.length > 0) && (
          <footer className="job-panel-footer">
            <button className="job-panel-clear-old-btn" onClick={handleClearOld}>
              Clear older than 30 days
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
