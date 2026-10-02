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
  // Hierarchical view: [{ path, name, depth }] so sub-bins can be indented.
  const [binTree, setBinTree]         = React.useState([]);
  const [binsLoading, setBinsLoading] = React.useState(false);
  const [binsError, setBinsError]     = React.useState(null);

  const [busy, setBusy]       = React.useState(false);
  const [progress, setProgress] = React.useState([]); // [{ name, uid, status }]
  const [result, setResult]   = React.useState(null); // { error } | { binMissing } | { opened, failed, total }

  // Stop flag: set by the footer Stop button; the loop checks it before each
  // sequence and after each settle, then ends the run as "stopped".
  const cancelRef = React.useRef(false);
  const [stopping, setStopping] = React.useState(false);

  // Seed from preferences + reset when the overlay opens.
  React.useEffect(() => {
    if (!open) return;
    setStage('configure');
    setBusy(false);
    setProgress([]);
    setResult(null);
    setStopping(false);
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
      setBins([]); setBinTree([]); setBinsError(null); setBinsLoading(false);
      return;
    }
    let cancelled = false;
    setBinsLoading(true);
    setBinsError(null);
    window.leaderpassAPI.call('list_media_bins')
      .then((res) => {
        if (cancelled) return;
        setBins(Array.isArray(res?.data?.bins) ? res.data.bins : []);
        setBinTree(Array.isArray(res?.data?.bin_tree) ? res.data.bin_tree : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setBins([]); setBinTree([]);
        const msg = err?.error?.message || err?.error || err?.message || 'Could not load bins';
        setBinsError(String(msg));
        onLog?.(`[open-sequences] Couldn't load bins: ${msg}`);
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
    setStopping(false);
    cancelRef.current = false;
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
      if (cancelRef.current) {
        // Stopped while the bin was being listed: nothing was opened.
        setResult({ opened: 0, failed: 0, total: sequences.length, stopped: true });
        setStage('done');
        onLog?.('[open-sequences] Stopped.');
        setBusy(false);
        return;
      }
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
        if (!ok) onLog?.(`[open-sequences] "${rows[i].name}" didn't open (open_sequence returned false).`);
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

    // A Stop that lands during the last sequence still counts as a full run.
    const stopped = cancelRef.current && opened + failed < rows.length;
    if (stopped) {
      // Rows that never got their turn read as "Not opened".
      setProgress((prev) => prev.map((r) => (r.status === 'pending' ? { ...r, status: 'skipped' } : r)));
    }
    onLog?.(`[open-sequences] ${stopped ? 'Stopped' : 'Done'}: opened ${opened}/${rows.length}${failed ? `, ${failed} failed` : ''}.`);
    setResult({ opened, failed, total: rows.length, stopped });
    setStage('done');
    setBusy(false);
  }

  function requestClose() {
    if (busy) return;
    onClose?.();
  }

  function handleStop() {
    if (!busy || cancelRef.current) return;
    cancelRef.current = true;
    setStopping(true);
    onLog?.('[open-sequences] Stopping after the current sequence…');
  }

  function renderConfigure() {
    // Bin hint only for loading or a problem (one message per problem; the
    // not-connected notice already covers the offline case).
    let binHint = null;
    if (binsLoading) binHint = 'Loading bins…';
    else if (connected && binsError) binHint = 'Couldn’t load bins. Using your last bin.';
    else if (connected && bins.length === 0) binHint = 'No bins found. Using your last bin.';

    return (
      <div className="atem-dest-section">
        <p className="atem-field-label">Sequences bin</p>
        <select
          className="settings-input"
          value={binName}
          onChange={(e) => setBinName(e.target.value)}
          disabled={binsLoading}
        >
          {(() => {
            // Prefer the hierarchical tree (indented sub-bins); fall back to
            // the flat path list. `value` is always the full bin path.
            const tree = binTree.length
              ? binTree
              : bins.map((p) => ({ path: p, name: p, depth: 1 }));
            const paths = tree.map((b) => b.path);
            const options = [...tree];
            if (binName && !paths.includes(binName)) {
              options.unshift({ path: binName, name: binName, depth: 1 });
            }
            if (options.length === 0) options.push({ path: DEFAULT_BIN, name: DEFAULT_BIN, depth: 1 });
            return options.map((b) => {
              // Non-breaking spaces: <option> trims leading ASCII spaces.
              const indent = b.depth > 1 ? '   '.repeat(b.depth - 1) : '';
              const missing = !paths.includes(b.path) && paths.length > 0;
              return (
                <option key={b.path} value={b.path}>
                  {indent}{b.name}{missing ? ' (not in this project)' : ''}
                </option>
              );
            });
          })()}
        </select>
        {binHint && (
          <p className="hint" title={binsError || undefined}>{binHint}</p>
        )}
      </div>
    );
  }

  // Row state → shared .status-dot modifier + short label (same set as ATEM).
  const ROW_STATE = {
    pending: { dot: 'is-pending', label: 'Queued' },
    opening: { dot: 'is-active',  label: 'Opening' },
    opened:  { dot: 'is-done',    label: 'Opened' },
    failed:  { dot: 'is-error',   label: 'Failed' },
    skipped: { dot: 'is-skipped', label: 'Not opened' },
  };

  function renderProgressList() {
    if (progress.length === 0) {
      return (
        <div className="run-loading">
          <span className="spinner" />
          <span>Finding sequences in “{binName}”…</span>
        </div>
      );
    }
    return (
      <div className="run-list">
        {progress.map((r, i) => {
          const st = ROW_STATE[r.status] || ROW_STATE.pending;
          return (
            <div key={`${r.name}_${i}`} className={`run-row ${st.dot}`}>
              <span className={`status-dot ${st.dot}`} />
              <span className="run-row-name">{r.name}</span>
              <span className="run-row-state">{st.label}</span>
            </div>
          );
        })}
      </div>
    );
  }

  function renderDone() {
    if (result?.error) {
      return (
        <p className="notice error" title={result.error}>
          Couldn’t list the sequences in “{binName}”. Details are in the Console.
        </p>
      );
    }
    if (result?.binMissing) {
      return <p className="notice error">Bin “{binName}” not found.</p>;
    }
    if (result && result.total === 0) {
      return (
        <div className="run-summary">
          <p className="run-summary-title">Nothing to open</p>
          <p className="run-summary-sub">The “{binName}” bin has no timelines.</p>
        </div>
      );
    }
    const total = result?.total ?? 0;
    return (
      <>
        <div className="run-summary">
          <p className="run-summary-title">{result?.stopped ? 'Stopped' : 'Done'}</p>
          <p className="run-summary-sub">
            Opened {result?.opened ?? 0} of {total} sequence{total !== 1 ? 's' : ''}.
          </p>
          {result?.failed > 0 && (
            <p className="error-text">
              {result.failed} couldn’t be opened. Details are in the Console.
            </p>
          )}
        </div>
        {renderProgressList()}
      </>
    );
  }

  if (!open) return null;

  const canRun = connected && !busy;

  return (
    <div className="tool-overlay" role="dialog" aria-label="Open sequences">
      <header className="tool-header">
        <h2 className="tool-title">Open sequences</h2>
        <button
          className="tool-close"
          onClick={requestClose}
          disabled={busy}
          aria-label="Close"
          title={busy ? 'Stop the run to close' : 'Close'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <div className="tool-body tool-body--form">
        {!connected && stage === 'configure' && (
          <p className="notice error">Resolve not connected.</p>
        )}
        {stage === 'configure' && renderConfigure()}
        {stage === 'running'   && renderProgressList()}
        {stage === 'done'      && renderDone()}
      </div>

      <footer className="tool-footer tool-footer--form">
        {stage === 'configure' && (
          <button className="btn primary" disabled={!canRun} onClick={handleRun}>
            Open all
          </button>
        )}
        {stage === 'running' && (
          <button className="btn danger" onClick={handleStop} disabled={stopping}>
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        )}
        {stage === 'done' && (
          <button className="btn primary" onClick={requestClose}>Done</button>
        )}
      </footer>
    </div>
  );
}
