/**
 * CommentPullReport — single-page report for a Pull Comments run.
 *
 * Renders a summary card at the top (timelines scanned, matched, totals,
 * involved LPOS projects) and a collapsible per-timeline section below. Each
 * timeline starts collapsed so the editor sees an at-a-glance overview and
 * can expand only the ones they care about.
 *
 * Reads result_items written by main.js's lpos:pull-comments handler:
 *   - Exactly one __summary__ item (kind: 'summary') carrying the aggregate stats
 *   - 0..N timeline items (kind: 'timeline') with placed/removed/kept/skipped arrays
 *
 * Props:
 *   jobId            — string, the result_run job id
 *   onClose          — () => void
 *   resolveProject   — string, the project name currently open in Resolve (live)
 *   resolveConnected — bool, is Resolve attached right now?
 *
 * When the live Resolve project differs from `summary.resolveProject` (the
 * project the report was generated against), a mismatch banner is shown
 * sticky at the top of the body. Jump and Mark-complete actions still
 * dispatch as usual; the banner is advisory because the wrong-project
 * case can produce confusing results (Jump lands on a different timeline
 * by uid, marker drops happen in the wrong project, etc.) but isn't
 * categorically wrong — the editor may have intentionally opened a
 * different project to review.
 */
function CommentPullReport({ jobId, onClose, resolveProject, resolveConnected }) {
  const [items, setItems]   = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [runLabel, setRunLabel] = React.useState('');
  const [expanded, setExpanded] = React.useState({}); // timelineUid -> bool
  // 5c.10: per-comment local completion state (commentId -> 'completing' | 'completed' | 'error').
  // The actual upstream truth is Frame.io's `completed` flag; this is local
  // mirror state for the UI's optimistic-then-confirmed transition.
  const [completionState, setCompletionState] = React.useState({});
  const [busyComments, setBusyComments] = React.useState({}); // commentId -> bool

  React.useEffect(() => {
    if (!jobId || !window.resultsAPI) return;
    setLoading(true);

    window.resultsAPI.listRuns(50)
      .then(res => {
        const run = (res?.data ?? []).find(r => r.job_id === jobId);
        if (run) setRunLabel(run.label || 'Comment pull');
      })
      .catch(() => {});

    window.resultsAPI.getItems(jobId)
      .then(res => setItems(res?.data ?? []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [jobId]);

  const summary = React.useMemo(
    () => items.find(it => it.item_key === '__summary__')?.item_data ?? null,
    [items]
  );
  const timelineItems = React.useMemo(
    () => items
      .filter(it => it.item_key !== '__summary__')
      .map(it => ({ ...(it.item_data || {}), itemKey: it.item_key })),
    [items]
  );

  function toggle(uid) {
    setExpanded(prev => ({ ...prev, [uid]: !prev[uid] }));
  }

  function expandAll() {
    const next = {};
    for (const t of timelineItems) next[t.timelineUid] = true;
    setExpanded(next);
  }
  function collapseAll() {
    setExpanded({});
  }

  function fmtHMS(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(total / 60);
    const ss = total % 60;
    return `${m}:${ss.toString().padStart(2, '0')}`;
  }

  // ── 5c.10 action handlers ────────────────────────────────────────────────
  // The preload (electron/preload.js) exposes focusComment + setCommentCompleted
  // under window.lposAPI, not window.commentsAPI. Earlier drafts checked the
  // wrong namespace, which made both buttons silently no-op (guard returned
  // before the IPC ever fired).
  async function handleJump(timelineUid, frame) {
    if (!window.lposAPI?.focusComment) return;
    try {
      const res = await window.lposAPI.focusComment({ timelineUid, frame });
      if (!res?.ok) {
        // Silent fail; the report doesn't have a toast surface yet. The
        // background log surfaces errors elsewhere if needed.
        console.warn('[CommentPullReport] focus failed:', res?.error);
      }
    } catch (err) {
      console.warn('[CommentPullReport] focus error:', err);
    }
  }

  async function handleSetCompleted(timeline, comment, completed) {
    const cid = comment.commentId;
    if (!cid || !window.lposAPI?.setCommentCompleted) return;
    if (busyComments[cid]) return;
    setBusyComments(prev => ({ ...prev, [cid]: true }));
    // Optimistic UI: flip the state immediately. Confirm/revert on response.
    setCompletionState(prev => ({ ...prev, [cid]: completed ? 'completing' : 'reopening' }));
    try {
      const res = await window.lposAPI.setCommentCompleted({
        projectId:   timeline.lposProjectId,
        assetId:     timeline.assetId,
        commentId:   cid,
        completed,
        timelineUid: timeline.timelineUid,
      });
      if (res?.ok) {
        setCompletionState(prev => ({ ...prev, [cid]: completed ? 'completed' : 'open' }));
      } else {
        setCompletionState(prev => ({ ...prev, [cid]: 'error' }));
        console.warn('[CommentPullReport] set-completed failed:', res?.error);
      }
    } catch (err) {
      setCompletionState(prev => ({ ...prev, [cid]: 'error' }));
      console.warn('[CommentPullReport] set-completed error:', err);
    } finally {
      setBusyComments(prev => ({ ...prev, [cid]: false }));
    }
  }

  function fmtTimecode(startTC, offsetS, fps) {
    // Best-effort: parse "HH:MM:SS:FF" (non-drop) and add offsetS seconds.
    // Drop-frame TC math is non-trivial; we just show m:ss-from-start if
    // start TC isn't parseable.
    if (!startTC || typeof startTC !== 'string' || !Number.isFinite(fps) || fps <= 0) {
      return fmtHMS(offsetS);
    }
    const parts = startTC.split(':');
    if (parts.length !== 4) return fmtHMS(offsetS);
    const [hh, mm, ss, ff] = parts.map(p => parseInt(p, 10));
    if ([hh, mm, ss, ff].some(n => !Number.isFinite(n))) return fmtHMS(offsetS);
    const startSeconds = hh * 3600 + mm * 60 + ss + (ff / fps);
    const total = startSeconds + (offsetS || 0);
    const outH = Math.floor(total / 3600);
    const outM = Math.floor((total % 3600) / 60);
    const outS = Math.floor(total % 60);
    const outF = Math.max(0, Math.min(fps - 1, Math.round((total - Math.floor(total)) * fps)));
    return `${String(outH).padStart(2, '0')}:${String(outM).padStart(2, '0')}:${String(outS).padStart(2, '0')}:${String(outF).padStart(2, '0')}`;
  }

  function CommentRow({ comment, outcome, startTC, fps, timeline }) {
    // outcome: 'placed' | 'kept' | 'removed' | 'skipped'
    const cid = comment.commentId;
    const localState = cid ? completionState[cid] : null;
    const isCompleted = localState === 'completed' || localState === 'completing';
    const isBusy = cid ? !!busyComments[cid] : false;
    const isActionable = (outcome === 'placed' || outcome === 'kept')
      && timeline
      && cid
      && typeof comment.frame === 'number';

    const offsetLabel = comment.timestamp_s != null ? fmtHMS(comment.timestamp_s) : '?';
    const absLabel    = comment.timestamp_s != null ? fmtTimecode(startTC, comment.timestamp_s, fps) : null;

    return (
      <div className={`comment-pull-comment outcome-${outcome}${isCompleted ? ' is-completed' : ''}${localState === 'error' ? ' has-error' : ''}`}>
        <div className="comment-pull-comment-header">
          <span className={`comment-pull-outcome-pill outcome-${isCompleted ? 'completed' : outcome}`}>
            {isCompleted ? 'completed' : outcome}
          </span>
          {comment.authorName && <span className="comment-pull-comment-author">{comment.authorName}</span>}
          <span className="comment-pull-comment-tc" title={absLabel || ''}>
            {offsetLabel}{absLabel ? `  ·  ${absLabel}` : ''}
          </span>
          {isActionable && (
            <div className="comment-pull-comment-actions">
              <button
                className="comment-action-btn jump"
                onClick={() => handleJump(timeline.timelineUid, comment.frame)}
                disabled={isBusy}
                title="Jump to this marker in Resolve"
              >
                Jump
              </button>
              {isCompleted ? (
                <button
                  className="comment-action-btn reopen"
                  onClick={() => handleSetCompleted(timeline, comment, false)}
                  disabled={isBusy}
                  title="Reopen this comment in Frame.io"
                >
                  {isBusy ? '…' : 'Reopen'}
                </button>
              ) : (
                <button
                  className="comment-action-btn complete"
                  onClick={() => handleSetCompleted(timeline, comment, true)}
                  disabled={isBusy}
                  title="Mark complete in Frame.io and drop the marker"
                >
                  {isBusy ? '…' : 'Mark complete'}
                </button>
              )}
            </div>
          )}
        </div>
        {comment.text && (
          <div className="comment-pull-comment-text">{comment.text}</div>
        )}
        {Array.isArray(comment.replies) && comment.replies.length > 0 && (
          <div className="comment-pull-comment-replies">
            {comment.replies.map((r, i) => (
              <div key={i} className="comment-pull-comment-reply">
                <span className="comment-pull-comment-reply-arrow">↳</span>
                <span className="comment-pull-comment-reply-author">{r.authorName || '?'}:</span>
                <span className="comment-pull-comment-reply-text">{r.text || ''}</span>
              </div>
            ))}
          </div>
        )}
        {outcome === 'removed' && !comment.text && (
          <div className="comment-pull-comment-text dim">
            (no longer in LPOS — marker removed)
          </div>
        )}
        {localState === 'error' && (
          <div className="comment-pull-comment-text dim">
            (Couldn't update — try again, or pull comments to resync state.)
          </div>
        )}
      </div>
    );
  }

  function SkippedRow({ skipped }) {
    return (
      <div className="comment-pull-comment outcome-skipped">
        <div className="comment-pull-comment-header">
          <span className="comment-pull-outcome-pill outcome-skipped">skipped</span>
          <span className="comment-pull-comment-tc">frame {skipped.frame}</span>
        </div>
        <div className="comment-pull-comment-text dim">{skipped.reason || 'AddMarker rejected'}</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="result-overlay comment-pull-report" role="dialog" aria-label="Comment pull report">
        <header className="result-overlay-header">
          <button className="result-overlay-back" onClick={onClose} aria-label="Close">×</button>
          <span className="result-overlay-title">Comment pull</span>
        </header>
        <div className="result-overlay-body comment-pull-body">
          <div className="comment-pull-content">
            <p className="result-item-loading">Loading…</p>
          </div>
        </div>
      </div>
    );
  }

  const hasTimelineActivity = timelineItems.length > 0;
  const placedSum  = summary?.totalPlaced  ?? 0;
  const removedSum = summary?.totalRemoved ?? 0;
  const keptSum    = summary?.totalKept    ?? 0;
  const skippedSum = summary?.totalSkipped ?? 0;

  // Wrong-project check. The report records which Resolve project was open
  // when the pull ran; the live `resolveProject` prop is whatever is open
  // now. A mismatch makes Jump/Mark-complete dangerous (different timelines
  // share uids across projects only by accident, and "drop marker" lands in
  // whichever project is open). We surface this prominently rather than
  // disabling actions because: (a) the editor may have intentionally
  // switched projects to spot-check, (b) Resolve may not be attached at
  // all — in which case the report is still useful as a read-only summary.
  const reportProject = (summary?.resolveProject || '').trim();
  const livePProject  = (resolveProject || '').trim();
  const projectMismatch = !!reportProject &&
    resolveConnected &&
    !!livePProject &&
    reportProject !== livePProject;
  const resolveOffline = !!reportProject && !resolveConnected;

  return (
    <div className="result-overlay comment-pull-report" role="dialog" aria-label={runLabel || 'Comment pull report'}>
      <header className="result-overlay-header">
        <button className="result-overlay-back" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <span className="result-overlay-title">{runLabel || 'Comment pull'}</span>
      </header>

      <div className="result-overlay-body comment-pull-body">
        {/* Centered, max-width content column so the report breathes on wide
            screens instead of stretching to the full viewport. */}
        <div className="comment-pull-content">

        {/* Sticky top stack: project-mismatch banner (when applicable) +
            summary card. Both stick together so the editor always sees the
            aggregate counts and the project context regardless of scroll
            depth — addresses "I lose the ability to scroll up to the top
            to view the summary when everything is expanded." */}
        <div className="comment-pull-sticky-top">
        {(projectMismatch || resolveOffline) && (
          <div
            className={`comment-pull-mismatch-banner ${projectMismatch ? 'mismatch' : 'offline'}`}
            role="alert"
          >
            <div className="comment-pull-mismatch-icon" aria-hidden="true">⚠</div>
            <div className="comment-pull-mismatch-body">
              {projectMismatch ? (
                <>
                  <div className="comment-pull-mismatch-title">
                    You're not in the project this report was generated for
                  </div>
                  <div className="comment-pull-mismatch-text">
                    Report project: <strong>{reportProject}</strong>{' '}
                    · currently open: <strong>{livePProject}</strong>
                    . Open <strong>{reportProject}</strong> in Resolve before using
                    Jump or Mark complete, or these actions will target the
                    wrong project's timelines.
                  </div>
                </>
              ) : (
                <>
                  <div className="comment-pull-mismatch-title">
                    Resolve isn't connected
                  </div>
                  <div className="comment-pull-mismatch-text">
                    This report's markers were placed in{' '}
                    <strong>{reportProject}</strong>. Reconnect to Resolve
                    (and open that project) before using Jump or Mark complete.
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Summary card */}
        <div className="comment-pull-summary">
          <div className="comment-pull-summary-totals">
            <div className="comment-pull-totals-item">
              <div className="comment-pull-totals-num placed">+{placedSum}</div>
              <div className="comment-pull-totals-label">placed</div>
            </div>
            <div className="comment-pull-totals-item">
              <div className="comment-pull-totals-num kept">={keptSum}</div>
              <div className="comment-pull-totals-label">kept</div>
            </div>
            <div className="comment-pull-totals-item">
              <div className="comment-pull-totals-num removed">−{removedSum}</div>
              <div className="comment-pull-totals-label">removed</div>
            </div>
            {skippedSum > 0 && (
              <div className="comment-pull-totals-item">
                <div className="comment-pull-totals-num skipped">!{skippedSum}</div>
                <div className="comment-pull-totals-label">skipped</div>
              </div>
            )}
          </div>

          <div className="comment-pull-summary-meta">
            {summary?.resolveProject && (
              <div><span className="dim">Resolve project</span> {summary.resolveProject}</div>
            )}
            {summary?.scannedCount != null && (
              <div>
                <span className="dim">Timelines scanned</span> {summary.scannedCount}
                <span className="dim"> · matched in LPOS </span>{summary.matchedCount ?? 0}
              </div>
            )}
            {Array.isArray(summary?.involvedProjectNames) && summary.involvedProjectNames.length > 0 && (
              <div>
                <span className="dim">LPOS project{summary.involvedProjectNames.length === 1 ? '' : 's'}</span>{' '}
                {summary.involvedProjectNames.join(', ')}
              </div>
            )}
            {Array.isArray(summary?.flagged) && summary.flagged.length > 0 && (
              <div className="comment-pull-flag-hint">
                <span className="dim">Flagged</span>{' '}
                {summary.flagged.length} timeline{summary.flagged.length === 1 ? '' : 's'} <strong>{summary.flagColor || 'Sand'}</strong>{' '}
                — sort the bin by Flag in Resolve to find them.
              </div>
            )}
          </div>
        </div>
        </div>{/* /.comment-pull-sticky-top */}

        {/* Per-timeline collapsible list */}
        {hasTimelineActivity ? (
          <>
            <div className="comment-pull-section-header">
              <span>Per timeline</span>
              <div className="comment-pull-section-actions">
                <button className="link-btn" onClick={expandAll}>Expand all</button>
                <span className="dim">·</span>
                <button className="link-btn" onClick={collapseAll}>Collapse all</button>
              </div>
            </div>
            <div className="comment-pull-timelines">
              {timelineItems.map(t => {
                const isOpen = !!expanded[t.timelineUid];
                const totalThis = (t.placed?.length || 0) + (t.kept?.length || 0) + (t.removed?.length || 0) + (t.skipped?.length || 0);
                return (
                  <div key={t.timelineUid} className={`comment-pull-timeline${isOpen ? ' open' : ''}`}>
                    <button
                      className="comment-pull-timeline-head"
                      onClick={() => toggle(t.timelineUid)}
                      aria-expanded={isOpen}
                    >
                      <span className="comment-pull-twisty" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                      <span className="comment-pull-timeline-name">{t.timelineName || t.timelineUid}</span>
                      {t.lposProjectName && (
                        <span className="comment-pull-timeline-project dim">· {t.lposProjectName}</span>
                      )}
                      <span className="comment-pull-timeline-counts">
                        {t.placed?.length > 0  && <span className="count placed">+{t.placed.length}</span>}
                        {t.kept?.length > 0    && <span className="count kept">={t.kept.length}</span>}
                        {t.removed?.length > 0 && <span className="count removed">−{t.removed.length}</span>}
                        {t.skipped?.length > 0 && <span className="count skipped">!{t.skipped.length}</span>}
                        {t.error && <span className="count error">error</span>}
                      </span>
                    </button>
                    {isOpen && (
                      <div className="comment-pull-timeline-body">
                        {t.error && (
                          <div className="comment-pull-error">
                            {t.error === 'timeline_not_found'
                              ? 'Timeline not found in current Resolve project — may have been deleted, renamed, or you have a different project open.'
                              : `Sync failed: ${t.error}`}
                          </div>
                        )}
                        {(t.placed || []).map(c => (
                          <CommentRow key={`p-${c.commentId}`} comment={c} outcome="placed"
                            startTC={t.timelineStartTimecode} fps={t.fps} timeline={t} />
                        ))}
                        {(t.kept || []).map(c => (
                          <CommentRow key={`k-${c.commentId}`} comment={c} outcome="kept"
                            startTC={t.timelineStartTimecode} fps={t.fps} timeline={t} />
                        ))}
                        {(t.removed || []).map(c => (
                          <CommentRow key={`r-${c.commentId}`} comment={c} outcome="removed"
                            startTC={t.timelineStartTimecode} fps={t.fps} timeline={t} />
                        ))}
                        {(t.skipped || []).map((s, i) => (
                          <SkippedRow key={`s-${i}`} skipped={s} />
                        ))}
                        {totalThis === 0 && !t.error && (
                          <div className="dim" style={{ padding: '8px 0' }}>No activity.</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="comment-pull-empty dim">
            {summary?.scannedCount === 0
              ? 'No timelines in the current Resolve project.'
              : (summary?.matchedCount ?? 0) === 0
                ? 'None of this Resolve project\'s timelines have been uploaded to LPOS yet. Export one from the Deliver tab first.'
                : 'All scanned timelines had no comment activity.'}
          </div>
        )}

        </div>{/* /.comment-pull-content */}
      </div>
    </div>
  );
}
