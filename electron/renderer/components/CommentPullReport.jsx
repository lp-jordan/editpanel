/**
 * CommentPullReport — single-page report for a Pull Comments run.
 *
 * Layout (shared .tool-overlay family): header with title + ×, a one-line
 * banner when Resolve is offline or on a different project, then a report-
 * width body: one muted metadata line, a compact pinned bar (totals + sort
 * switch + expand/collapse toggle), and a collapsible per-timeline list.
 * Each timeline starts collapsed so the editor sees an at-a-glance overview
 * and can expand only the ones they care about. Footer: Done.
 *
 * Reads result_items written by main.js's lpos:pull-comments handler:
 *   - Exactly one __summary__ item (kind: 'summary') carrying the aggregate stats
 *   - 0..N timeline items (kind: 'timeline') with placed/removed/kept/skipped arrays
 *
 * Editor-facing vocabulary maps the sync outcomes: placed → "new",
 * kept → "open", removed → "removed", skipped → "skipped" (marker couldn't
 * be placed). Raw reasons / frames / sync codes go to the console and to
 * tooltips, never inline.
 *
 * Props:
 *   jobId            — string, the result_run job id
 *   run              — optional result_run row (ResultOverlay already fetched it)
 *   onClose          — () => void
 *   resolveProject   — string, the project name currently open in Resolve (live)
 *   resolveConnected — bool, is Resolve attached right now?
 *
 * When the live Resolve project differs from `summary.resolveProject` (the
 * project the report was generated against), a one-line warning banner is
 * shown above the body. Jump and Mark done still dispatch as usual; the
 * banner is advisory because the wrong-project case can produce confusing
 * results (Jump lands on a different timeline by uid, marker drops happen in
 * the wrong project, etc.) but isn't categorically wrong — the editor may
 * have intentionally opened a different project to review. When Resolve is
 * not connected at all, Jump and Mark done are disabled (Jump can't work,
 * and Mark done would leave the marker behind in Resolve); Reopen stays
 * available since it only touches LPOS.
 *
 * Esc closes unless a Mark done / Reopen is in flight (× and Done are
 * disabled for that moment too).
 */
// ── Pure formatting helpers (module scope) ──────────────────────────────────
// These are referentially stable, so the row components below can be defined at
// module scope too. That stability matters: CommentRow/SkippedRow used to live
// *inside* CommentPullReport, which gave them a fresh function identity on every
// parent re-render (e.g. marking a comment complete). React then treated each
// row as a brand-new component type and remounted the whole list, collapsing the
// scroll container back to the top. Hoisting them out keeps the DOM (and scroll
// position) stable across state updates.
function fmtHMS(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(total / 60);
  const ss = total % 60;
  return `${m}:${ss.toString().padStart(2, '0')}`;
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

// ── Sort keys ────────────────────────────────────────────────────────────────
// Timeline position: every placed/kept/removed record carries a numeric `frame`
// (removed records are pass-through {commentId, frame}); fall back to
// timestamp_s, then push position-less records to the end.
function _frameSortKey(rec) {
  if (typeof rec?.frame === 'number') return rec.frame;
  if (typeof rec?.timestamp_s === 'number') return rec.timestamp_s;
  return Number.MAX_SAFE_INTEGER;
}
// Recency: only decorated (placed/kept) records carry createdAt; removed records
// have none, so they sort oldest (to the bottom in newest-first order).
function _createdSortKey(rec) {
  const t = rec?.createdAt ? Date.parse(rec.createdAt) : NaN;
  return Number.isFinite(t) ? t : 0;
}

// Merge the three outcome groups into a single list ordered by the chosen mode.
// Array.prototype.sort is stable in V8, so equal keys keep the placed→kept→
// removed insertion order as a tiebreak. Skipped rows are rendered separately.
function orderedComments(t, sortMode) {
  const rows = [
    ...(t.placed  || []).map(c => ({ c, outcome: 'placed'  })),
    ...(t.kept    || []).map(c => ({ c, outcome: 'kept'    })),
    ...(t.removed || []).map(c => ({ c, outcome: 'removed' })),
  ];
  const cmp = sortMode === 'newest'
    ? (a, b) => _createdSortKey(b.c) - _createdSortKey(a.c)
    : (a, b) => _frameSortKey(a.c) - _frameSortKey(b.c);
  rows.sort(cmp);
  return rows;
}


// Record timecode for a marker. Prefer the exact marker frame (0-relative to
// the timeline start) and fall back to the comment's timestamp.
function recordSeconds(rec, fps) {
  if (typeof rec?.frame === 'number' && rec.frame >= 0 && Number.isFinite(fps) && fps > 0) {
    return rec.frame / fps;
  }
  if (typeof rec?.timestamp_s === 'number') return rec.timestamp_s;
  return null;
}

// Labelled counts, e.g. "4 new · 2 open · 1 removed". `always` keeps the
// new/open parts even at zero (summary bar); timeline headers drop zeros.
function countParts({ placed = 0, kept = 0, removed = 0, skipped = 0 }, always) {
  const parts = [];
  if (always || placed > 0) parts.push({ key: 'new', text: `${placed} new` });
  if (always || kept > 0)   parts.push({ key: 'open', text: `${kept} open` });
  if (removed > 0) parts.push({ key: 'removed', text: `${removed} removed`, title: 'No longer in LPOS, so their markers were removed.' });
  if (skipped > 0) parts.push({ key: 'skipped', text: `${skipped} skipped`, title: 'Markers that couldn’t be placed in Resolve.' });
  return parts;
}

function CountLine({ parts, className }) {
  return (
    <span className={className}>
      {parts.map((p, i) => (
        <React.Fragment key={p.key}>
          {i > 0 && ' · '}
          <span title={p.title}>{p.text}</span>
        </React.Fragment>
      ))}
    </span>
  );
}

function friendlyJumpError(raw) {
  const s = String(raw || '');
  if (/timeline_not_found/i.test(s)) return 'Couldn’t find this timeline in the open Resolve project.';
  if (/not connected|ECONNREFUSED|worker/i.test(s)) return 'Resolve not connected.';
  return 'Couldn’t jump to this marker.';
}

function CommentRow({ comment, outcome, startTC, fps, timeline, completionState, busyComments, rowErrors, canUseResolve, onJump, onSetCompleted }) {
  // outcome: 'placed' | 'kept' | 'removed'
  const cid = comment.commentId;
  const localState = cid ? completionState[cid] : null;
  const isCompleted = localState === 'completed' || localState === 'completing';
  const isBusy = cid ? !!busyComments[cid] : false;
  const rowError = cid ? rowErrors[cid] : null;
  const isActionable = (outcome === 'placed' || outcome === 'kept')
    && timeline
    && cid
    && typeof comment.frame === 'number';
  const isStruck = isCompleted || outcome === 'removed';

  // One timecode per row: the record TC. Offset-from-start goes in the tooltip.
  const secs = recordSeconds(comment, fps);
  const recordTC = secs != null ? fmtTimecode(startTC, secs, fps) : null;
  const offsetTitle = secs != null ? `${fmtHMS(secs)} from the start of the timeline` : undefined;

  return (
    <div className={`comment-pull-comment${isStruck ? ' is-struck' : ''}`}>
      <div className="comment-pull-comment-header">
        {isCompleted && <span className="tag">Done</span>}
        {!isCompleted && outcome === 'placed' && <span className="tag accent">New</span>}
        {outcome === 'removed' && (
          <span className="tag" title="No longer in LPOS, so its marker was removed.">Removed</span>
        )}
        {comment.authorName && <span className="comment-pull-comment-author">{comment.authorName}</span>}
        {recordTC && <span className="comment-pull-comment-tc" title={offsetTitle}>{recordTC}</span>}
        {comment.olderCut && (
          <span
            className="tag"
            title="Left on an earlier cut of this timeline. It may already have been actioned in a later export."
          >
            {typeof comment.versionNumber === 'number' ? `Earlier cut (v${comment.versionNumber})` : 'Earlier cut'}
          </span>
        )}
        {isActionable && (
          <div className="comment-pull-comment-actions">
            <button
              className="btn small ghost"
              onClick={() => onJump(timeline.timelineUid, comment)}
              disabled={isBusy || !canUseResolve}
            >
              Jump
            </button>
            {isCompleted ? (
              <button
                className="btn small ghost"
                onClick={() => onSetCompleted(timeline, comment, false)}
                disabled={isBusy}
              >
                {isBusy ? <span className="spinner small" aria-label="Saving" /> : 'Reopen'}
              </button>
            ) : (
              <button
                className="btn small ghost"
                onClick={() => onSetCompleted(timeline, comment, true)}
                disabled={isBusy || !canUseResolve}
                title="Marks the comment done in LPOS and removes its marker"
              >
                {isBusy ? <span className="spinner small" aria-label="Saving" /> : 'Mark done'}
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
              <span className="comment-pull-comment-reply-author">{r.authorName || 'Unknown'}:</span>
              <span className="comment-pull-comment-reply-text">{r.text || ''}</span>
            </div>
          ))}
        </div>
      )}
      {outcome === 'removed' && !comment.text && (
        <div className="comment-pull-comment-note">No longer in LPOS.</div>
      )}
      {rowError && (
        <p className="error-text comment-pull-row-error" title={rowError.raw || undefined}>{rowError.msg}</p>
      )}
    </div>
  );
}

function SkippedRow({ skipped, startTC, fps }) {
  const secs = recordSeconds(skipped, fps);
  const tc = secs != null && typeof skipped?.frame === 'number' && skipped.frame >= 0
    ? fmtTimecode(startTC, secs, fps)
    : null;
  const raw = [skipped?.reason, typeof skipped?.frame === 'number' ? `frame ${skipped.frame}` : null]
    .filter(Boolean).join(', ');
  return (
    <div className="comment-pull-comment">
      <p className="error-text" title={raw || undefined}>
        {tc ? `Couldn’t place marker at ${tc}.` : 'Couldn’t place a marker for this comment.'}
      </p>
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg className="comment-pull-twisty" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

function CommentPullReport({ jobId, run, onClose, resolveProject, resolveConnected }) {
  const [items, setItems]   = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [runLabel, setRunLabel] = React.useState(run?.label || '');
  const [expanded, setExpanded] = React.useState({}); // timelineUid -> bool
  const [sortMode, setSortMode] = React.useState('timecode'); // 'timecode' | 'newest'
  // 5c.10: per-comment local completion state (commentId -> 'completing' | 'completed' | 'reopening' | 'open').
  // The actual upstream truth is Frame.io's `completed` flag; this is local
  // mirror state for the UI's optimistic-then-confirmed transition.
  const [completionState, setCompletionState] = React.useState({});
  const [busyComments, setBusyComments] = React.useState({}); // commentId -> bool
  // Per-row failure from Jump or Mark done/Reopen: commentId -> { msg, raw }.
  const [rowErrors, setRowErrors] = React.useState({});

  React.useEffect(() => {
    if (!jobId || !window.resultsAPI) return;
    setLoading(true);

    if (!run) {
      window.resultsAPI.listRuns(50)
        .then(res => {
          const found = (res?.data ?? []).find(r => r.job_id === jobId);
          if (found) setRunLabel(found.label || '');
        })
        .catch(() => {});
    }

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

  // Raw diagnostics that used to be inline (sync codes, skip reasons, asset
  // fetch errors) go to the console once per load.
  React.useEffect(() => {
    for (const t of timelineItems) {
      const name = t.timelineName || t.timelineUid;
      if (t.error) console.warn(`[CommentPullReport] ${name}: sync error:`, t.error);
      for (const s of (t.skipped || [])) console.warn(`[CommentPullReport] ${name}: marker skipped at frame ${s.frame}:`, s.reason);
      for (const a of (t.assetErrors || [])) console.warn(`[CommentPullReport] ${name}: asset ${a.assetId} comments failed:`, a.error);
    }
  }, [timelineItems]);

  const anyBusy = Object.values(busyComments).some(Boolean);

  // Esc closes the report unless a Mark done / Reopen is in flight.
  React.useEffect(() => {
    function handleKey(e) {
      if (e.key !== 'Escape' || anyBusy) return;
      onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [anyBusy, onClose]);

  function toggle(uid) {
    setExpanded(prev => ({ ...prev, [uid]: !prev[uid] }));
  }

  const allExpanded = timelineItems.length > 0 && timelineItems.every(t => expanded[t.timelineUid]);
  function toggleAll() {
    if (allExpanded) {
      setExpanded({});
      return;
    }
    const next = {};
    for (const t of timelineItems) next[t.timelineUid] = true;
    setExpanded(next);
  }

  function setRowError(cid, err) {
    setRowErrors(prev => {
      if (!err && !prev[cid]) return prev;
      const next = { ...prev };
      if (err) next[cid] = err; else delete next[cid];
      return next;
    });
  }

  // ── 5c.10 action handlers ────────────────────────────────────────────────
  // The preload (electron/preload.js) exposes focusComment + setCommentCompleted
  // under window.lposAPI, not window.commentsAPI. Earlier drafts checked the
  // wrong namespace, which made both buttons silently no-op (guard returned
  // before the IPC ever fired).
  async function handleJump(timelineUid, comment) {
    const cid = comment.commentId;
    if (!window.lposAPI?.focusComment) return;
    setRowError(cid, null);
    let raw = null;
    try {
      const res = await window.lposAPI.focusComment({ timelineUid, frame: comment.frame });
      // The IPC wraps the worker reply as { ok: true, data }, and the worker
      // reports its own failures as data.result === false + reason
      // (timeline_not_found, goto_failed, …), so check both layers.
      if (!res?.ok) raw = res?.error || 'focus failed';
      else if (res?.data?.result === false) raw = res.data.reason || 'focus failed';
    } catch (err) {
      raw = err?.message || String(err);
    }
    if (raw) {
      console.warn('[CommentPullReport] focus failed:', raw);
      setRowError(cid, { msg: friendlyJumpError(raw), raw: String(raw) });
    }
  }

  async function handleSetCompleted(timeline, comment, completed) {
    const cid = comment.commentId;
    if (!cid || !window.lposAPI?.setCommentCompleted) return;
    if (busyComments[cid]) return;
    const prevState = completionState[cid];
    setBusyComments(prev => ({ ...prev, [cid]: true }));
    setRowError(cid, null);
    // Optimistic UI: flip the state immediately. Confirm/revert on response.
    setCompletionState(prev => ({ ...prev, [cid]: completed ? 'completing' : 'reopening' }));
    let raw = null;
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
        raw = res?.error || 'set-completed failed';
      }
    } catch (err) {
      raw = err?.message || String(err);
    } finally {
      setBusyComments(prev => ({ ...prev, [cid]: false }));
    }
    if (raw) {
      // Revert to what the row showed before the click.
      console.warn('[CommentPullReport] set-completed failed:', raw);
      setCompletionState(prev => ({ ...prev, [cid]: prevState }));
      setRowError(cid, { msg: 'Couldn’t update. Try again.', raw: String(raw) });
    }
  }

  const title = runLabel || 'Pull comments';
  const hasTimelineActivity = timelineItems.length > 0;
  const totals = {
    placed:  summary?.totalPlaced  ?? 0,
    kept:    summary?.totalKept    ?? 0,
    removed: summary?.totalRemoved ?? 0,
    skipped: summary?.totalSkipped ?? 0,
  };

  // Wrong-project check. The report records which Resolve project was open
  // when the pull ran; the live `resolveProject` prop is whatever is open
  // now. A mismatch makes Jump/Mark done dangerous (different timelines
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

  // One muted metadata line: project · N of M timelines in LPOS · K flagged.
  // Diagnostics (LPOS project names, assets checked, how to find flagged
  // timelines) live in tooltips.
  const meta = [];
  if (summary?.resolveProject) meta.push({ key: 'project', text: summary.resolveProject });
  if (summary) {
    const matched = summary.matchedCount ?? 0;
    const lposNames = Array.isArray(summary.involvedProjectNames) ? summary.involvedProjectNames : [];
    const tip = [
      lposNames.length > 0 ? `LPOS project${lposNames.length === 1 ? '' : 's'}: ${lposNames.join(', ')}` : null,
      summary.totalAssetsScanned != null ? `${summary.totalAssetsScanned} LPOS asset${summary.totalAssetsScanned === 1 ? '' : 's'} checked` : null,
    ].filter(Boolean).join('\n');
    meta.push({
      key: 'matched',
      text: summary.scannedCount != null
        ? `${matched} of ${summary.scannedCount} timelines in LPOS`
        : `${matched} timeline${matched === 1 ? '' : 's'} in LPOS`,
      title: tip || undefined,
    });
  }
  if (Array.isArray(summary?.flagged) && summary.flagged.length > 0) {
    meta.push({
      key: 'flagged',
      text: `${summary.flagged.length} flagged`,
      title: `Flagged ${summary.flagColor || 'Sand'} in Resolve. Sort the bin by Flag to find them.`,
    });
  }

  return (
    <div className="tool-overlay comment-pull-report" role="dialog" aria-label={title}>
      <header className="tool-header">
        <h2 className="tool-title">{title}</h2>
        <button className="tool-close" onClick={onClose} disabled={anyBusy} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      {!loading && (projectMismatch || resolveOffline) && (
        <div className="tool-body--report comment-pull-banner">
          {projectMismatch ? (
            <div className="notice warning" role="alert">
              <span>
                <strong>{reportProject}</strong> isn’t open in Resolve (currently <strong>{livePProject}</strong>). Jump and Mark done need it open.
              </span>
            </div>
          ) : (
            <div className="notice info" role="alert">
              <span>Resolve not connected. Jump and Mark done are unavailable.</span>
            </div>
          )}
        </div>
      )}

      <div className="tool-body tool-body--report comment-pull-body">
        {loading ? (
          <p className="hint comment-pull-loading">Loading…</p>
        ) : (
          <>
            {meta.length > 0 && <CountLine parts={meta} className="comment-pull-meta" />}

            {/* Compact pinned bar: totals + sort + expand/collapse. */}
            <div className="comment-pull-bar">
              <CountLine parts={countParts(totals, true)} className="comment-pull-totals" />
              {hasTimelineActivity && (
                <div className="comment-pull-controls">
                  <div className="comment-pull-sort" role="group" aria-label="Sort comments">
                    <button
                      className={sortMode === 'timecode' ? 'active' : ''}
                      aria-pressed={sortMode === 'timecode'}
                      onClick={() => setSortMode('timecode')}
                    >
                      Timecode
                    </button>
                    <button
                      className={sortMode === 'newest' ? 'active' : ''}
                      aria-pressed={sortMode === 'newest'}
                      onClick={() => setSortMode('newest')}
                    >
                      Newest
                    </button>
                  </div>
                  <button className="btn small ghost" onClick={toggleAll}>
                    {allExpanded ? 'Collapse all' : 'Expand all'}
                  </button>
                </div>
              )}
            </div>

            {/* Per-timeline collapsible list */}
            {hasTimelineActivity ? (
              <div className="comment-pull-timelines">
                {timelineItems.map(t => {
                  const isOpen = !!expanded[t.timelineUid];
                  const totalThis = (t.placed?.length || 0) + (t.kept?.length || 0) + (t.removed?.length || 0) + (t.skipped?.length || 0);
                  const headParts = countParts({
                    placed:  t.placed?.length  || 0,
                    kept:    t.kept?.length    || 0,
                    removed: t.removed?.length || 0,
                    skipped: t.skipped?.length || 0,
                  }, false);
                  return (
                    <div key={t.timelineUid} className={`comment-pull-timeline${isOpen ? ' open' : ''}`}>
                      <button
                        className="comment-pull-timeline-head"
                        onClick={() => toggle(t.timelineUid)}
                        aria-expanded={isOpen}
                      >
                        <ChevronIcon />
                        <span className="comment-pull-timeline-name">{t.timelineName || 'Untitled timeline'}</span>
                        {t.lposProjectName && (
                          <span className="comment-pull-timeline-project">{t.lposProjectName}</span>
                        )}
                        <span className="comment-pull-timeline-counts">
                          {t.error && <span className="tag danger" title={String(t.error)}>Couldn’t sync</span>}
                          {headParts.length > 0 && <CountLine parts={headParts} />}
                        </span>
                      </button>
                      {isOpen && (
                        <div className="comment-pull-timeline-body">
                          {t.error && (
                            <div className="notice error" title={String(t.error)}>
                              <span>
                                {t.error === 'timeline_not_found'
                                  ? 'This timeline isn’t in the open Resolve project.'
                                  : 'Couldn’t sync this timeline.'}
                              </span>
                            </div>
                          )}
                          {orderedComments(t, sortMode).map(({ c, outcome }) => (
                            <CommentRow
                              key={`${outcome[0]}-${c.commentId}`}
                              comment={c}
                              outcome={outcome}
                              startTC={t.timelineStartTimecode}
                              fps={t.fps}
                              timeline={t}
                              completionState={completionState}
                              busyComments={busyComments}
                              rowErrors={rowErrors}
                              canUseResolve={!!resolveConnected}
                              onJump={handleJump}
                              onSetCompleted={handleSetCompleted}
                            />
                          ))}
                          {(t.skipped || []).map((s, i) => (
                            <SkippedRow key={`s-${i}`} skipped={s} startTC={t.timelineStartTimecode} fps={t.fps} />
                          ))}
                          {totalThis === 0 && !t.error && (
                            <p className="hint">No comments.</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="hint comment-pull-empty">
                {summary?.scannedCount === 0
                  ? 'No timelines in the open Resolve project.'
                  : (summary?.matchedCount ?? 0) === 0
                    ? 'None of this project’s timelines are in LPOS yet. Export and upload one from the Deliver tab.'
                    : 'No comments on these timelines.'}
              </p>
            )}
          </>
        )}
      </div>

      <footer className="tool-footer tool-footer--report">
        <button className="btn primary" onClick={onClose} disabled={anyBusy}>Done</button>
      </footer>
    </div>
  );
}
