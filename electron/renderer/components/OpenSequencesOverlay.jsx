/**
 * OpenSequencesOverlay — open every sequence (timeline) in a chosen media-pool
 * bin, one at a time, with a short settle between each.
 *
 * Mirrors the Export bin dropdown (list_media_bins) so the editor picks a
 * top-level bin the same way they do for export. On run it:
 *   1. list_bin_sequences  — fetch the timelines that live in the chosen bin
 *   2. open_sequence × N    — open each one, pausing SETTLE_MS between calls
 *
 * The loop is driven here (not in one long Python call) so the Resolve worker
 * keeps answering health pings between sequences — a big bin can't trip the
 * ~30s unresponsive watchdog and get the worker restarted mid-run. It also
 * gives the editor live per-sequence progress.
 *
 * Props:
 *   open       — boolean
 *   onClose    — () => void
 *   connected  — boolean (Resolve connection)
 *   onLog      — (msg: string) => void
 */
function OpenSequencesOverlay({ open, onClose, connected, onLog }) {
  const DEFAULT_BIN = 'SEQUENCES';
  // Beat between opening one sequence and starting the next. "A beat or two"
  // so Resolve fully loads each timeline before we switch away.
  const SETTLE_MS = 1500;

  const [stage, setStage] = React.useState('configure'); // 'configure' | 'running' | 'done'
  const [binName, setBinName] = React.useState(DEFAULT_BIN);

  // Bin dropdown source — same shape/behaviour as ExportDeliverOverlay.
  const [bins, setBins]               = React.useState([]);
  const [binsLoading, setBinsLoading] = React.useState(false);
  const [binsError, setBinsError]     = React.useState(null);

  const [busy, setBusy]       = React.useState(false);
  const [progress, setProgress] = React.useState([]); // [{ name, uid, status }]
  const [result, setResult]   = React.useState(null); // { error } | { binMissing } | { opened, failed, total }

  // Cancel guard so a close mid-run stops the loop touching state.
  const cancelRef = React.useRef(false);

  // Seed from preferences + reset when the overlay opens.
  React.useEffect(() => {
    if (!open) return;
    setStage('configure');
    setBusy(false);
    setProgress([]);
    setResult(null);
    cancelRef.current = false;

    if (!window.electronAPI?.getPreferences) {
      setBinName(DEFAULT_BIN);
      return;
    }
    window.electronAPI.getPreferences()
      .then((res) => setBinName(res?.data?.lastOpenSeqBin || DEFAULT_BIN))
      .catch(() => setBinName(DEFAULT_BIN));
  }, [open]);

  // Fetch top-level bins when the overlay opens (and we're connected). Empty /
  // error leaves the persisted value as the sole option so the editor can still
  // run; list_bin_sequences surfaces the real mismatch.
  React.useEffect(() => {
    if (!open) return;
    if (!connected) {
      setBins([]); setBinsError(null); setBinsLoading(false);
      return;
    }
    let cancelled = false;
    setBinsLoading(true);
    setBinsError(null);
    window.leaderpassAPI.call('list_media_bins')
      .then((res) => {
        if (cancelled) return;
        setBins(Array.isArray(res?.data?.bins) ? res.data.bins : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setBins([]);
        setBinsError(err?.error?.message || err?.error || err?.message || 'Could not load bins');
      })
      .finally(() => { if (!cancelled) setBinsLoading(false); });
    return () => { cancelled = true; };
  }, [open, connected]);

  // Escape-to-close (blocked while a run is in flight).
  React.useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onClose?.();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  function persistPrefs(patch) {
    if (!window.electronAPI?.updatePreferences) return;
    window.electronAPI.updatePreferences(patch).catch(() => {});
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function handleRun() {
    if (busy || !connected) return;
    setBusy(true);
    setStage('running');
    setResult(null);
    setProgress([]);
    persistPrefs({ lastOpenSeqBin: binName });
    onLog?.(`[open-sequences] Listing sequences in "${binName}"…`);

    let sequences = [];
    try {
      const res = await window.leaderpassAPI.call('list_bin_sequences', { bin_name: binName });
      if (!res?.data?.bin_found) {
        setResult({ binMissing: true });
        setStage('done');
        onLog?.(`[open-sequences] Bin "${binName}" not found in the project.`);
        setBusy(false);
        return;
      }
      sequences = Array.isArray(res.data.sequences) ? res.data.sequences : [];
    } catch (err) {
      const msg = err?.error?.message || err?.error || err?.message || String(err);
      setResult({ error: msg });
      setStage('done');
      onLog?.(`[open-sequences] Error: ${msg}`);
      setBusy(false);
      return;
    }

    if (sequences.length === 0) {
      setResult({ opened: 0, failed: 0, total: 0 });
      setStage('done');
      onLog?.(`[open-sequences] No sequences found in "${binName}".`);
      setBusy(false);
      return;
    }

    const rows = sequences.map((s) => ({ name: s.name, uid: s.uid || null, status: 'pending' }));
    setProgress(rows);
    onLog?.(`[open-sequences] Opening ${rows.length} sequence${rows.length === 1 ? '' : 's'}…`);

    let opened = 0;
    let failed = 0;
    for (let i = 0; i < rows.length; i++) {
      if (cancelRef.current) break;
      setProgress((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: 'opening' } : r)));
      try {
        const res = await window.leaderpassAPI.call('open_sequence', {
          ...(rows[i].uid ? { uid: rows[i].uid } : {}),
          name: rows[i].name
        });
        const ok = Boolean(res?.data?.result);
        if (ok) opened++; else failed++;
        setProgress((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: ok ? 'opened' : 'failed' } : r)));
      } catch (err) {
        failed++;
        setProgress((prev) => prev.map((r, idx) => (idx === i ? { ...r, status: 'failed' } : r)));
        const msg = err?.error?.message || err?.error || err?.message || String(err);
        onLog?.(`[open-sequences] "${rows[i].name}" failed: ${msg}`);
      }
      // Give Resolve a beat to finish loading before opening the next one.
      if (i < rows.length - 1 && !cancelRef.current) await sleep(SETTLE_MS);
    }

    if (cancelRef.current) return; // overlay closed mid-run
    onLog?.(`[open-sequences] Done — opened ${opened}/${rows.length}${failed ? `, ${failed} failed` : ''}.`);
    setResult({ opened, failed, total: rows.length });
    setStage('done');
    setBusy(false);
  }

  function requestClose() {
    if (busy) return;
    cancelRef.current = true;
    onClose?.();
  }

  function renderConfigure() {
    return (
      <div className="atem-configure">
        <div className="atem-dest-section">
          <p className="atem-field-label">Sequences bin</p>
          <select
            className="settings-input"
            value={binName}
            onChange={(e) => setBinName(e.target.value)}
            disabled={binsLoading}
          >
            {(() => {
              const options = [...bins];
              if (binName && !options.includes(binName)) options.unshift(binName);
              if (options.length === 0) options.push(DEFAULT_BIN);
              return options.map((name) => (
                <option key={name} value={name}>
                  {name}{!bins.includes(name) && bins.length > 0 ? ' (not in this project)' : ''}
                </option>
              ));
            })()}
          </select>
          <p className="atem-dest-hint" style={{ marginTop: 6 }}>
            {binsLoading
              ? 'Loading bins from Resolve…'
              : binsError
                ? `Couldn't load bins — using your last setting. (${binsError})`
                : bins.length === 0
                  ? 'No top-level bins detected — using your last setting.'
                  : `${bins.length} top-level bin${bins.length === 1 ? '' : 's'} from the current Resolve project.`}
          </p>
        </div>
        <p className="export-lpos-note">
          Every timeline in this bin is opened one at a time, with a short pause between each so Resolve can load them. The last one stays current.
        </p>
      </div>
    );
  }

  function renderProgressList() {
    if (progress.length === 0) {
      return (
        <div className="atem-loading" style={{ padding: '32px 0' }}>
          <span className="status-bar-spinner" style={{ width: 18, height: 18 }} />
          <span>Finding sequences in “{binName}”…</span>
        </div>
      );
    }
    const ICON = { pending: '·', opening: '…', opened: '✓', failed: '✕' };
    return (
      <div className="atem-file-list">
        {progress.map((r, i) => (
          <div key={`${r.name}_${i}`} className={`atem-file-row${r.status === 'opened' ? ' done' : ''}`}>
            <span className="atem-file-state-icon">
              {r.status === 'opening'
                ? <span className="status-bar-spinner" style={{ width: 12, height: 12 }} />
                : ICON[r.status]}
            </span>
            <span className="atem-file-name">{r.name}</span>
            {r.status === 'failed' && <span className="atem-file-cam">failed</span>}
          </div>
        ))}
      </div>
    );
  }

  function renderDone() {
    if (result?.error) {
      return <p className="atem-error">Couldn’t open sequences: {result.error}</p>;
    }
    if (result?.binMissing) {
      return (
        <div className="atem-done-state">
          <p className="atem-done-title">Bin not found</p>
          <p className="atem-done-sub">No top-level bin named “{binName}” in the current Resolve project.</p>
        </div>
      );
    }
    if (result && result.total === 0) {
      return (
        <div className="atem-done-state">
          <p className="atem-done-title">Nothing to open</p>
          <p className="atem-done-sub">The “{binName}” bin has no timelines in it.</p>
        </div>
      );
    }
    return (
      <div className="atem-progress-view">
        <div className="atem-done-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: result?.failed ? 'var(--accent)' : 'var(--success)' }}>
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <p className="atem-done-title">
            Opened {result?.opened}/{result?.total}
          </p>
          <p className="atem-done-sub">
            {result?.failed
              ? `${result.failed} couldn’t be opened — the last successful one is current.`
              : 'All sequences opened — the last one is current in Resolve.'}
          </p>
        </div>
        {renderProgressList()}
      </div>
    );
  }

  if (!open) return null;

  const canRun = connected && !busy;

  return (
    <div className="result-overlay atem-overlay" role="dialog" aria-label="Open Sequences">
      <header className="result-overlay-header">
        <button className="result-overlay-back" onClick={requestClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <span className="result-overlay-title">Open Sequences</span>
        <div className="atem-stage-pills">
          {['configure', 'running', 'done'].map((s, i) => (
            <span key={s} className={`atem-stage-pill${stage === s ? ' active' : ''}`}>{i + 1}</span>
          ))}
        </div>
      </header>

      <div className="atem-overlay-body">
        {!connected && stage === 'configure' && (
          <p className="atem-error">Resolve is not connected — open your project first.</p>
        )}
        {stage === 'configure' && renderConfigure()}
        {stage === 'running'   && renderProgressList()}
        {stage === 'done'      && renderDone()}
      </div>

      <footer className="result-overlay-actions">
        {stage === 'configure' && (
          <button className="btn" disabled={!canRun} onClick={handleRun}>
            Open Sequences
          </button>
        )}
        {stage === 'done' && (
          <button className="btn" onClick={onClose}>Done</button>
        )}
      </footer>
    </div>
  );
}
