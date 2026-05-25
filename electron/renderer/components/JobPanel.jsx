/**
 * JobPanel — slide-up drawer above the status bar.
 *
 * Shows:
 *  • Any currently running job engine jobs with step progress
 *  • Recent result runs (spellcheck, audit, etc.) with a "Review" button
 *
 * Props:
 *  open          — boolean, whether the panel is visible
 *  onClose       — () => void
 *  dashboard     — { jobs: [], logs_by_job_step: {} }  from controlPlane.buildDashboard()
 *  onViewResults — (jobId: string) => void  called when user clicks Review
 */
function JobPanel({ open, onClose, dashboard, onViewResults }) {
  const [runs, setRuns] = React.useState([]);
  const [loadingRuns, setLoadingRuns] = React.useState(false);

  // Reload result runs whenever panel opens
  React.useEffect(() => {
    if (!open || !window.resultsAPI) return;
    setLoadingRuns(true);
    window.resultsAPI.listRuns(10)
      .then(res => setRuns(res?.data ?? []))
      .catch(() => setRuns([]))
      .finally(() => setLoadingRuns(false));
  }, [open]);

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

  return (
    <div className={`job-panel${open ? ' open' : ''}`} role="dialog" aria-label="Jobs">
      <div className="job-panel-inner">
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
                      {prog && (
                        <span className="job-panel-step-badge">{prog.done}/{prog.total}</span>
                      )}
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
                      <button
                        className={`job-panel-review-btn${isDone ? ' done' : ''}`}
                        onClick={() => onViewResults(run.job_id)}
                      >
                        {isDone ? 'Done' : run.pending > 0 ? `Resume (${run.pending})` : 'Review'}
                      </button>
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
                </div>
              ))}
            </section>
          )}

          {runningJobs.length === 0 && runs.length === 0 && recentJobs.length === 0 && !loadingRuns && (
            <p className="job-panel-empty">No jobs yet.</p>
          )}

        </div>
      </div>
    </div>
  );
}
