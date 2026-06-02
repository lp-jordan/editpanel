/**
 * ResultOverlay — full-screen overlay for reviewing result items one at a time.
 *
 * Supports item types:
 *   'spellcheck' — shows misspelled word in context, suggestions, custom input, jump-to-timecode
 *
 * Props:
 *   jobId   — string, the result run to review
 *   onClose — () => void
 */
function ResultOverlay({ jobId, onClose }) {
  const [items, setItems] = React.useState([]);
  const [currentIdx, setCurrentIdx] = React.useState(0);
  const [suggestions, setSuggestions] = React.useState([]);
  const [loadingSuggestions, setLoadingSuggestions] = React.useState(false);
  const [customValue, setCustomValue] = React.useState('');
  const [selectedSuggestion, setSelectedSuggestion] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [runLabel, setRunLabel] = React.useState('');
  const [scopeProject, setScopeProject] = React.useState('');
  const [scopeTimeline, setScopeTimeline] = React.useState('');
  const [applyError, setApplyError] = React.useState('');
  const customInputRef = React.useRef(null);

  // Load items on mount
  React.useEffect(() => {
    if (!jobId || !window.resultsAPI) return;

    window.resultsAPI.listRuns(50)
      .then(res => {
        const run = (res?.data ?? []).find(r => r.job_id === jobId);
        if (run) {
          setRunLabel(run.label || run.item_type);
          setScopeProject(run.project_name || '');
          setScopeTimeline(run.timeline_name || '');
        }
      })
      .catch(() => {});

    window.resultsAPI.getItems(jobId)
      .then(res => {
        const all = res?.data ?? [];
        setItems(all);
        // Start at the first pending item
        const firstPending = all.findIndex(i => i.state === 'pending');
        setCurrentIdx(firstPending >= 0 ? firstPending : 0);
      })
      .catch(() => {});
  }, [jobId]);

  const currentItem = items[currentIdx] ?? null;

  // Load suggestions whenever current item changes (for spellcheck)
  React.useEffect(() => {
    setSuggestions([]);
    setSelectedSuggestion(null);
    setCustomValue('');

    if (!currentItem || currentItem.item_type !== 'spellcheck') return;
    const word = currentItem.item_data?.word;
    if (!word || !window.spellcheckAPI?.suggestions) return;

    setLoadingSuggestions(true);
    window.spellcheckAPI.suggestions(word)
      .then(res => setSuggestions(Array.isArray(res) ? res : []))
      .catch(() => setSuggestions([]))
      .finally(() => setLoadingSuggestions(false));
  }, [currentItem?.item_key]);

  // Auto-focus custom input when no suggestions
  React.useEffect(() => {
    if (!loadingSuggestions && suggestions.length === 0 && customInputRef.current) {
      customInputRef.current.focus();
    }
  }, [loadingSuggestions, suggestions.length]);

  // Keyboard shortcuts
  React.useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowRight' || e.key === 'Tab') {
        if (e.target === customInputRef.current) return; // let tab work in input
        e.preventDefault();
        goNext();
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [currentIdx, items.length]);

  function goNext() {
    setCurrentIdx(prev => Math.min(prev + 1, items.length - 1));
  }

  function goPrev() {
    setCurrentIdx(prev => Math.max(prev - 1, 0));
  }

  function goNextPending() {
    const next = items.findIndex((item, i) => i > currentIdx && item.state === 'pending');
    if (next >= 0) {
      setCurrentIdx(next);
    } else {
      // wrap to first pending
      const first = items.findIndex(item => item.state === 'pending');
      if (first >= 0) setCurrentIdx(first);
      // else all done — stay on last item
    }
  }

  async function handleApply() {
    if (!currentItem || saving) return;
    const correction = customValue.trim() || selectedSuggestion;
    if (!correction) return;

    setSaving(true);
    setApplyError('');

    // For spellcheck: push the text update to Resolve, but only if the live
    // Resolve context still matches what this run was captured against. The
    // worker enforces this — passing expect_project / expect_timeline causes
    // it to refuse and return a clear error if the user has switched projects.
    if (currentItem.item_type === 'spellcheck') {
      const d = currentItem.item_data;
      if (window.leaderpassAPI && d?.track != null && d?.start_frame != null) {
        const newText = d.clipText.replace(
          new RegExp(`\\b${escapeRegex(d.word)}\\b`, 'gi'),
          correction
        );
        try {
          const res = await window.leaderpassAPI.call('update_text', {
            track: d.track,
            start_frame: d.start_frame,
            tool_name: d.tool_name,
            text: newText,
            expect_project:  scopeProject  || null,
            expect_timeline: scopeTimeline || null
          });
          // The Python helper returns `{ result: false, reason: "..." }`
          // when it couldn't find the clip or the Text+ tool. Earlier code
          // only caught thrown errors, so those silent failures got
          // recorded as "resolved" and the editor never saw the timeline
          // hadn't actually been updated. Treat any falsy result as a hard
          // error and leave the item pending.
          const payload = res?.data ?? res ?? {};
          if (payload && payload.result === false) {
            setApplyError(
              payload.reason ||
                'Resolve refused the text update — nothing was changed in the timeline.'
            );
            setSaving(false);
            return;
          }
        } catch (err) {
          // Refuse-on-mismatch surfaces here. Show the message and bail
          // without writing a resolution row — the item stays pending so
          // the user can switch projects and try again.
          const msg = err?.error || err?.message || String(err);
          setApplyError(msg);
          setSaving(false);
          return;
        }
      }
    }

    // Persist resolution
    await window.resultsAPI?.resolveItem(jobId, currentItem.item_key, {
      action: 'replace',
      replacement: correction
    }).catch(() => {});

    // Update local state
    setItems(prev => prev.map((it, i) =>
      i === currentIdx
        ? { ...it, state: 'resolved', resolution: { action: 'replace', replacement: correction } }
        : it
    ));
    setSaving(false);
    goNextPending();
  }

  async function handleSkip() {
    if (!currentItem || saving) return;
    setSaving(true);

    await window.resultsAPI?.skipItem(jobId, currentItem.item_key).catch(() => {});

    setItems(prev => prev.map((it, i) =>
      i === currentIdx ? { ...it, state: 'skipped' } : it
    ));
    setSaving(false);
    goNextPending();
  }

  async function handleReopen() {
    if (!currentItem || saving) return;
    setSaving(true);
    setApplyError('');

    await window.resultsAPI?.reopenItem(jobId, currentItem.item_key).catch(() => {});

    setItems(prev => prev.map((it, i) =>
      i === currentIdx
        ? { ...it, state: 'pending', resolution: null }
        : it
    ));
    setSaving(false);
    // Stay on this item so the user can make a new choice.
  }

  function handleJumpToTimecode() {
    if (!currentItem?.item_data?.timecode || !window.leaderpassAPI) return;
    window.leaderpassAPI.call('goto', { timecode: currentItem.item_data.timecode }).catch(() => {});
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  const total   = items.length;
  const done    = items.filter(i => i.state !== 'pending').length;
  const pct     = total > 0 ? Math.round((done / total) * 100) : 0;
  const allDone = total > 0 && done === total;

  // Render the current item based on its type
  function renderSpellcheckItem(item) {
    const d = item.item_data ?? {};
    const word = d.word ?? '';
    const text = d.clipText ?? '';

    // Highlight the word in context
    const parts = text.split(new RegExp(`(${escapeRegex(word)})`, 'i'));

    return (
      <div className="result-item-content spellcheck-item">
        <div className="result-item-context">
          {parts.map((part, i) =>
            part.toLowerCase() === word.toLowerCase()
              ? <mark key={i} className="result-item-mark">{part}</mark>
              : <span key={i}>{part}</span>
          )}
        </div>

        {(d.track != null || d.timecode) && (
          <div className="result-item-meta">
            {d.track != null && <span>Track {d.track}</span>}
            {d.tool && <span>{d.tool}</span>}
            {d.timecode && (
              <button className="result-item-tc-btn" onClick={handleJumpToTimecode}>
                {d.timecode}
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              </button>
            )}
          </div>
        )}

        <div className="result-item-suggestions">
          {loadingSuggestions && <p className="result-item-loading">Loading suggestions…</p>}
          {!loadingSuggestions && suggestions.length > 0 && (
            <div className="result-suggestions-list">
              {suggestions.slice(0, 5).map(s => (
                <button
                  key={s}
                  className={`result-suggestion${selectedSuggestion === s && !customValue ? ' selected' : ''}`}
                  onClick={() => { setSelectedSuggestion(s); setCustomValue(''); }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {!loadingSuggestions && suggestions.length === 0 && (
            <p className="result-item-no-suggestions">No suggestions — type a correction below.</p>
          )}
        </div>

        <div className="result-item-custom">
          <input
            ref={customInputRef}
            type="text"
            className="result-item-input"
            placeholder="Or type a correction…"
            value={customValue}
            onChange={e => { setCustomValue(e.target.value); setSelectedSuggestion(null); }}
            onKeyDown={e => { if (e.key === 'Enter') handleApply(); }}
          />
        </div>
      </div>
    );
  }

  function renderResolvedItem(item) {
    const res = item.resolution;
    const wasApplied = item.state === 'resolved';
    return (
      <div className="result-item-content resolved-item">
        <p className="result-item-resolved-label">
          {item.state === 'skipped' ? 'Skipped' : `Replaced with: "${res?.replacement ?? ''}"`}
        </p>
        <p className="result-item-context dim">{item.item_data?.clipText ?? ''}</p>
        {wasApplied && (
          <p className="result-item-reopen-note">
            Reopening lets you make a different choice here, but the Resolve
            timeline text was already updated. Edit it directly in Resolve if
            you need to revert.
          </p>
        )}
      </div>
    );
  }

  function renderAllDone() {
    return (
      <div className="result-item-content all-done">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <p className="result-done-title">All {total} items reviewed</p>
        <p className="result-done-sub">
          {items.filter(i => i.state === 'resolved').length} resolved
          · {items.filter(i => i.state === 'skipped').length} skipped
        </p>
        <button className="btn" onClick={onClose}>Done</button>
      </div>
    );
  }

  return (
    <div className="result-overlay" role="dialog" aria-label={runLabel || 'Results'}>
      {/* Header */}
      <header className="result-overlay-header">
        <button className="result-overlay-back" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <span className="result-overlay-title">{runLabel || 'Results'}</span>
        {(scopeProject || scopeTimeline) && (
          <span className="result-overlay-scope" title="This run is scoped to a specific Resolve project + timeline">
            {scopeProject || '?'}{scopeTimeline ? ` · ${scopeTimeline}` : ''}
          </span>
        )}
        <span className="result-overlay-counter">{done} / {total}</span>
      </header>

      {/* Progress bar */}
      <div className="result-overlay-progress-track">
        <div className="result-overlay-progress-fill" style={{ width: `${pct}%` }} />
      </div>

      {applyError && (
        <div className="result-overlay-error" role="alert">
          {applyError}
          <button
            className="result-overlay-error-dismiss"
            onClick={() => setApplyError('')}
            aria-label="Dismiss"
          >×</button>
        </div>
      )}

      {/* Item navigation */}
      {total > 0 && (
        <div className="result-overlay-nav">
          <button
            className="result-nav-btn"
            onClick={goPrev}
            disabled={currentIdx === 0}
            aria-label="Previous"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="result-nav-label">{currentIdx + 1} of {total}</span>
          <button
            className="result-nav-btn"
            onClick={goNext}
            disabled={currentIdx === items.length - 1}
            aria-label="Next"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      )}

      {/* Item content */}
      <div className="result-overlay-body">
        {allDone && renderAllDone()}
        {!allDone && currentItem && currentItem.state !== 'pending' && renderResolvedItem(currentItem)}
        {!allDone && currentItem && currentItem.state === 'pending' && currentItem.item_type === 'spellcheck' && renderSpellcheckItem(currentItem)}
        {!allDone && !currentItem && items.length === 0 && (
          <p className="result-item-loading">Loading…</p>
        )}
      </div>

      {/* Action bar */}
      {!allDone && currentItem && currentItem.state === 'pending' && (
        <footer className="result-overlay-actions">
          <button className="btn-secondary" onClick={handleSkip} disabled={saving}>
            Skip
          </button>
          <button
            className="btn"
            onClick={handleApply}
            disabled={saving || (!selectedSuggestion && !customValue.trim())}
          >
            {saving ? 'Applying…' : 'Apply'}
          </button>
        </footer>
      )}

      {/* Already-resolved item action bar */}
      {!allDone && currentItem && currentItem.state !== 'pending' && (
        <footer className="result-overlay-actions">
          <button className="btn-secondary" onClick={handleReopen} disabled={saving}>
            Reopen
          </button>
          <button className="btn" onClick={goNextPending}>
            Next Pending →
          </button>
        </footer>
      )}
    </div>
  );
}
