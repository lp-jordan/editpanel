/**
 * ResultOverlay — full-screen overlay for reviewing result items one at a time.
 *
 * Supports item types:
 *   'spellcheck' — shows misspelled word in context, suggestions, custom input, jump-to-timecode
 *   'comment_pull' — single-page summary + per-timeline accordion via CommentPullReport
 *
 * Props:
 *   jobId            — string, the result run to review
 *   onClose          — () => void
 *   resolveProject   — string, the project name currently open in Resolve (live)
 *   resolveConnected — bool, is Resolve attached right now?
 *
 * The live Resolve project + connection state are passed through so the
 * routed report component can warn when the editor is viewing a run that
 * was generated against a different project than what's currently open
 * (or no project at all). The spellcheck branch doesn't currently use
 * these — it's a per-item walk with no project context to mismatch
 * against — but they're available if it ever needs them.
 *
 * Both branches use the shared .tool-overlay family (header with title + ×,
 * scrolling body at report width, footer that always exists). Esc closes
 * unless an action is in flight; while one is, × is disabled too.
 */
function ResultOverlay({ jobId, onClose, resolveProject, resolveConnected }) {
  // 5c.7 (2026-06-02): Pull Comments runs use a single-page CommentPullReport
  // (summary card + collapsible per-timeline) rather than the spellcheck-style
  // item-by-item walk. Detect the run type up-front via the run row's
  // item_type and bypass the spellcheck UI entirely. The run row is handed
  // down so neither branch has to re-fetch it for its title.
  const [routedType, setRoutedType] = React.useState(null); // null = unknown, 'spellcheck', 'comment_pull', …
  const [run, setRun] = React.useState(null);
  React.useEffect(() => {
    if (!jobId || !window.resultsAPI) return;
    let cancelled = false;
    setRoutedType(null);
    window.resultsAPI.listRuns(50)
      .then(res => {
        if (cancelled) return;
        const found = (res?.data ?? []).find(r => r.job_id === jobId) || null;
        setRun(found);
        setRoutedType(found?.item_type || 'unknown');
      })
      .catch(() => { if (!cancelled) setRoutedType('unknown'); });
    return () => { cancelled = true; };
  }, [jobId]);

  // Until the run type is known, show the shared shell (same header/footer)
  // instead of briefly mounting the spellcheck walk for a comment pull run.
  if (routedType === null && window.resultsAPI) {
    return <ResultLoadingShell onClose={onClose} />;
  }

  if (routedType === 'comment_pull') {
    return (
      <CommentPullReport
        jobId={jobId}
        run={run}
        onClose={onClose}
        resolveProject={resolveProject}
        resolveConnected={resolveConnected}
      />
    );
  }

  // Spellcheck (and any other future per-item-walk run type) keeps the
  // existing behaviour.
  return <SpellcheckResultOverlay jobId={jobId} run={run} onClose={onClose} />;
}

function ResultCloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ResultLoadingShell({ onClose }) {
  React.useEffect(() => {
    function handleKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);
  return (
    <div className="tool-overlay" role="dialog" aria-label="Results">
      <header className="tool-header">
        <h2 className="tool-title">Loading…</h2>
        <button className="tool-close" onClick={onClose} aria-label="Close"><ResultCloseIcon /></button>
      </header>
      <div className="tool-body tool-body--report">
        <p className="hint">Loading…</p>
      </div>
      <footer className="tool-footer tool-footer--report">
        <button className="btn" onClick={onClose}>Done</button>
      </footer>
    </div>
  );
}

// Map a raw update_text failure (worker reason or thrown error) to one short
// sentence. The raw text still goes to the console and the notice tooltip.
function friendlySpellApplyError(raw) {
  const s = String(raw || '');
  if (/project mismatch/i.test(s))  return 'Resolve has a different project open. Switch back to apply.';
  if (/timeline mismatch/i.test(s)) return 'Resolve has a different timeline open. Switch back to apply.';
  if (/no active timeline/i.test(s)) return 'No timeline is open in Resolve.';
  if (/no clip on track/i.test(s))  return 'Couldn’t find this clip. It may have moved since the scan. Run the scan again.';
  if (/not connected|ECONNREFUSED|worker/i.test(s)) return 'Resolve not connected.';
  return 'Couldn’t update the text in Resolve. Nothing was changed.';
}

function SpellcheckResultOverlay({ jobId, run, onClose }) {
  const [items, setItems] = React.useState([]);
  const [loaded, setLoaded] = React.useState(false);
  const [currentIdx, setCurrentIdx] = React.useState(0);
  const [suggestions, setSuggestions] = React.useState([]);
  const [loadingSuggestions, setLoadingSuggestions] = React.useState(false);
  const [customValue, setCustomValue] = React.useState('');
  const [selectedSuggestion, setSelectedSuggestion] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [runLabel, setRunLabel] = React.useState(run ? (run.label || run.item_type) : '');
  const [scopeProject, setScopeProject] = React.useState(run?.project_name || '');
  const [scopeTimeline, setScopeTimeline] = React.useState(run?.timeline_name || '');
  // { msg, raw } — msg is the one-line user text, raw goes in the tooltip.
  const [applyError, setApplyError] = React.useState(null);
  // Right-click "Add to dictionary" menu: { x, y, word } or null.
  const [wordMenu, setWordMenu] = React.useState(null);
  const customInputRef = React.useRef(null);

  function showError(msg, raw) {
    if (raw) console.warn('[ResultOverlay] spellcheck:', raw);
    setApplyError({ msg, raw: raw || '' });
  }

  // Load items on mount
  React.useEffect(() => {
    if (!jobId || !window.resultsAPI) return;

    if (!run) {
      window.resultsAPI.listRuns(50)
        .then(res => {
          const found = (res?.data ?? []).find(r => r.job_id === jobId);
          if (found) {
            setRunLabel(found.label || found.item_type);
            setScopeProject(found.project_name || '');
            setScopeTimeline(found.timeline_name || '');
          }
        })
        .catch(() => {});
    }

    window.resultsAPI.getItems(jobId)
      .then(res => {
        const all = res?.data ?? [];
        setItems(all);
        // Start at the first pending item
        const firstPending = all.findIndex(i => i.state === 'pending');
        setCurrentIdx(firstPending >= 0 ? firstPending : 0);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
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
      if (e.key === 'Escape') {
        // The word menu's own listener closes the menu; don't also close the
        // overlay. Nothing closes while an apply/skip is in flight.
        if (wordMenu || saving) return;
        onClose();
        return;
      }
      // Arrow keys and Tab belong to the correction input while it has
      // focus (caret movement / focus order), so only navigate items when
      // focus is elsewhere.
      if (e.target === customInputRef.current) return;
      if (e.key === 'ArrowRight' || e.key === 'Tab') {
        e.preventDefault();
        goNext();
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [currentIdx, items.length, wordMenu, saving]);

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
    setApplyError(null);

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
            const raw = payload.reason || 'update_text returned result:false';
            showError(friendlySpellApplyError(raw), raw);
            setSaving(false);
            return;
          }
        } catch (err) {
          // Refuse-on-mismatch surfaces here. Show the message and bail
          // without writing a resolution row — the item stays pending so
          // the user can switch projects and try again.
          const raw = err?.error || err?.message || String(err);
          showError(friendlySpellApplyError(raw), raw);
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

  // Lower-case + straighten the curly apostrophe so renderer-side word matching
  // mirrors the main-process allowlist key (see spellcheck.js normalizeWord).
  function normalizeWord(w) {
    return String(w ?? '').replace(/’/g, "'").trim().toLowerCase();
  }

  // Right-click on a flagged word → add it to the custom dictionary. The word
  // becomes permanently allowed, so every still-pending item flagged for the
  // same word is skipped in one go (they're no longer misspellings).
  async function handleAddToDictionary(word) {
    setWordMenu(null);
    if (saving || !word || !window.spellcheckAPI?.addWord) return;
    setSaving(true);
    setApplyError(null);

    const res = await window.spellcheckAPI.addWord(word).catch(err => ({ ok: false, error: err?.message || String(err) }));
    if (!res || res.ok === false) {
      showError('Couldn’t add the word to the dictionary.', res?.error || 'addWord failed');
      setSaving(false);
      return;
    }

    // Skip every pending item flagged for this same word.
    const target = normalizeWord(word);
    const toSkip = items.filter(
      it => it.state === 'pending' && it.item_type === 'spellcheck' && normalizeWord(it.item_data?.word) === target
    );
    for (const it of toSkip) {
      await window.resultsAPI?.skipItem(jobId, it.item_key).catch(() => {});
    }
    const skipKeys = new Set(toSkip.map(it => it.item_key));
    setItems(prev => prev.map(it => (skipKeys.has(it.item_key) ? { ...it, state: 'skipped' } : it)));

    setSaving(false);
    goNextPending();
  }

  // Dismiss the word menu on outside click / Escape.
  React.useEffect(() => {
    if (!wordMenu) return;
    function handleDown(e) {
      if (!e.target.closest?.('.suggestion-menu')) setWordMenu(null);
    }
    function handleKey(e) {
      if (e.key === 'Escape') setWordMenu(null);
    }
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [wordMenu]);

  async function handleReopen() {
    if (!currentItem || saving) return;
    setSaving(true);
    setApplyError(null);

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
    window.leaderpassAPI.call('goto', { timecode: currentItem.item_data.timecode }).catch(err => {
      console.warn('[ResultOverlay] goto failed:', err?.error || err?.message || err);
    });
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
              ? <mark
                  key={i}
                  className="result-item-mark"
                  title="Right-click to add to dictionary"
                  onContextMenu={e => {
                    e.preventDefault();
                    setWordMenu({ x: e.clientX, y: e.clientY, word });
                  }}
                >{part}</mark>
              : <span key={i}>{part}</span>
          )}
        </div>

        {(d.track != null || d.timecode) && (
          <div className="result-item-meta">
            {d.track != null && <span>Track {d.track}</span>}
            {d.tool && <span>{d.tool}</span>}
            {d.timecode && (
              <button className="result-item-tc-btn" onClick={handleJumpToTimecode} title="Jump to this timecode in Resolve">
                {d.timecode}
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              </button>
            )}
          </div>
        )}

        <div className="result-item-suggestions">
          {loadingSuggestions && <p className="hint">Loading suggestions…</p>}
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
            <p className="hint">No suggestions. Type a correction below.</p>
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
          {item.state === 'skipped' ? 'Skipped' : `Replaced with “${res?.replacement ?? ''}”`}
        </p>
        <p className="result-item-context dim">{item.item_data?.clipText ?? ''}</p>
        {wasApplied && (
          <p className="hint">Already applied in Resolve. Reopening won’t undo it.</p>
        )}
      </div>
    );
  }

  function renderAllDone() {
    const appliedCount = items.filter(i => i.state === 'resolved').length;
    const skippedCount = items.filter(i => i.state === 'skipped').length;
    return (
      <div className="result-item-content all-done">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
        <p className="result-done-title">All {total} items reviewed</p>
        <p className="result-done-sub">{appliedCount} fixed · {skippedCount} skipped</p>
      </div>
    );
  }

  const isPending = !allDone && currentItem && currentItem.state === 'pending';
  const isReviewed = !allDone && currentItem && currentItem.state !== 'pending';

  return (
    <div className="tool-overlay spellcheck-review" role="dialog" aria-label={runLabel || 'Spelling review'}>
      <header className="tool-header">
        <h2 className="tool-title">{runLabel || 'Spelling review'}</h2>
        {(scopeProject || scopeTimeline) && (
          <span className="tool-subtitle">
            {scopeProject || 'Untitled project'}{scopeTimeline ? ` · ${scopeTimeline}` : ''}
          </span>
        )}
        <button className="tool-close" onClick={onClose} disabled={saving} aria-label="Close">
          <ResultCloseIcon />
        </button>
      </header>

      {/* Progress bar (shared flat track with the ATEM overlay) */}
      <div className="result-overlay-progress-track">
        <div className="result-overlay-progress-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="tool-body tool-body--report spellcheck-review-body">
        <div className="spellcheck-review-stage">
          {applyError && (
            <div className="notice error" role="alert" title={applyError.raw || undefined}>
              <span>{applyError.msg}</span>
              <button
                className="btn small ghost notice-action"
                onClick={() => setApplyError(null)}
              >
                Dismiss
              </button>
            </div>
          )}
          {allDone && renderAllDone()}
          {isReviewed && renderResolvedItem(currentItem)}
          {isPending && currentItem.item_type === 'spellcheck' && renderSpellcheckItem(currentItem)}
          {!allDone && !currentItem && (
            <p className="hint result-item-empty">{loaded ? 'Nothing to review.' : 'Loading…'}</p>
          )}
        </div>
      </div>

      <footer className="tool-footer tool-footer--report">
        {/* Item navigation: "4 of 12" plus prev/next (also ← / → keys). */}
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
              aria-label="Next item"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        )}

        {isPending && (
          <>
            <button className="btn ghost" onClick={handleSkip} disabled={saving}>
              Skip
            </button>
            <button
              className="btn primary"
              onClick={handleApply}
              disabled={saving || (!selectedSuggestion && !customValue.trim())}
            >
              {saving ? 'Applying…' : 'Apply'}
            </button>
          </>
        )}

        {isReviewed && (
          <>
            <button className="btn ghost" onClick={handleReopen} disabled={saving}>
              Reopen
            </button>
            <button className="btn primary" onClick={goNextPending} disabled={saving}>
              Next
            </button>
          </>
        )}

        {(allDone || !currentItem) && (
          <button className="btn primary" onClick={onClose} disabled={saving}>Done</button>
        )}
      </footer>

      {/* Right-click "Add to dictionary" menu (positioned at the cursor). */}
      {wordMenu && (
        <ul
          className="suggestion-menu"
          style={{ position: 'fixed', top: wordMenu.y, left: wordMenu.x }}
        >
          <li onClick={() => handleAddToDictionary(wordMenu.word)}>
            Add “{wordMenu.word}” to dictionary
          </li>
        </ul>
      )}
    </div>
  );
}
