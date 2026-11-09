/**
 * CreateMulticamOverlay — build a multicam from a media-pool bin, optionally
 * with one timeline per recording span (helper/commands/create_multicam.py).
 *
 * Props:
 *   open       — boolean
 *   onClose    — () => void
 *   connected  — boolean (Resolve connection)
 *   onLog      — (msg: string) => void
 */
function CreateMulticamOverlay({ open, onClose, connected, onLog }) {
  const [stage, setStage] = React.useState('configure'); // 'configure' | 'running' | 'done'
  const [binTree, setBinTree] = React.useState([]);
  const [binsLoading, setBinsLoading] = React.useState(false);
  const [sourceBin, setSourceBin] = React.useState('');
  const [binName, setBinName] = React.useState('');
  const [nameEdited, setNameEdited] = React.useState(false);
  const [buildTimelines, setBuildTimelines] = React.useState(false);
  const [result, setResult] = React.useState(null); // { error } | handler output

  React.useEffect(() => {
    if (!open) return;
    setStage('configure');
    setSourceBin('');
    setBinName('');
    setNameEdited(false);
    setBuildTimelines(false);
    setResult(null);
  }, [open]);

  React.useEffect(() => {
    if (!open || !connected) {
      setBinTree([]); setBinsLoading(false);
      return;
    }
    let cancelled = false;
    setBinsLoading(true);
    window.leaderpassAPI.call('list_media_bins')
      .then((res) => { if (!cancelled) setBinTree(Array.isArray(res?.data?.bin_tree) ? res.data.bin_tree : []); })
      .catch((err) => {
        if (cancelled) return;
        setBinTree([]);
        onLog?.(`[multicam] Couldn't load bins: ${err?.error?.message || err?.error || err?.message || err}`);
      })
      .finally(() => { if (!cancelled) setBinsLoading(false); });
    return () => { cancelled = true; };
  }, [open, connected]);

  const busy = stage === 'running';

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

  function handleSourceChange(path) {
    setSourceBin(path);
    if (!nameEdited) setBinName(binTree.find((b) => b.path === path)?.name || '');
  }

  async function handleCreate() {
    setStage('running');
    onLog?.(`[multicam] Creating "${binName.trim()}" from ${sourceBin}…`);
    try {
      const res = await window.leaderpassAPI.call('create_multicam', {
        source_bin: sourceBin,
        bin_name: binName.trim(),
        build_timelines: buildTimelines,
      });
      const data = res?.data || {};
      setResult(data);
      onLog?.(`[multicam] Created ${data.multicam} in ${data.bin}` +
        (buildTimelines ? ` · ${(data.timelines_built || []).length} timeline(s)` : ''));
      (data.warnings || []).forEach((w) => onLog?.(`[multicam] ${w}`));
    } catch (err) {
      const msg = String(err?.error?.message || err?.error || err?.message || err);
      setResult({ error: msg });
      onLog?.(`[multicam] Failed: ${msg}`);
    }
    setStage('done');
  }

  function renderConfigure() {
    return (
      <div className="atem-configure">
        {!connected && <p className="notice error">Resolve not connected.</p>}

        <div className="atem-dest-section">
          <p className="atem-field-label">Source bin</p>
          <select
            className="settings-input"
            value={sourceBin}
            onChange={(e) => handleSourceChange(e.target.value)}
            disabled={binsLoading || !connected}
          >
            <option value="">{binsLoading ? 'Loading bins…' : 'Choose a bin'}</option>
            {binTree.map((b) => (
              <option key={b.path} value={b.path}>
                {b.depth > 1 ? '   '.repeat(b.depth - 1) : ''}{b.name}
              </option>
            ))}
          </select>
        </div>

        <div className="atem-dest-section">
          <p className="atem-field-label">Bin name</p>
          <input
            className="settings-input"
            type="text"
            value={binName}
            onChange={(e) => { setBinName(e.target.value); setNameEdited(true); }}
          />
          {nameInvalid && <p className="error-text">Bin name can’t contain /.</p>}
        </div>

        <div className="atem-resolve-toggle">
          <label className="atem-resolve-toggle-inner" style={{ cursor: 'pointer' }}>
            <p className="atem-field-label">Build timelines</p>
            <input
              type="checkbox"
              className="atem-session-checkbox"
              checked={buildTimelines}
              onChange={(e) => setBuildTimelines(e.target.checked)}
            />
          </label>
        </div>
      </div>
    );
  }

  function renderDone() {
    if (result?.error) {
      return <p className="notice error">{result.error}</p>;
    }
    const built = result?.timelines_built?.length || 0;
    const failed = result?.timelines_failed || 0;
    const skipped = result?.timelines_skipped || 0;
    return (
      <div className="run-summary">
        <p className="run-summary-title">{result?.multicam}</p>
        <p className="run-summary-sub">
          {result?.bin} · {result?.clips} clip{result?.clips !== 1 ? 's' : ''} · CAM {(result?.cameras || []).join(', ')}
        </p>
        {result?.cameras_left_out?.length > 0 && (
          <p className="run-summary-sub">Left out: CAM {result.cameras_left_out.join(', ')}</p>
        )}
        {buildTimelines && (
          <p className="run-summary-sub">
            {built} timeline{built !== 1 ? 's' : ''} built
            {skipped ? ` · ${skipped} skipped` : ''}
          </p>
        )}
        {failed > 0 && <p className="error-text">{failed} timeline{failed !== 1 ? 's' : ''} failed. Details are in the Console.</p>}
        {(result?.warnings || []).map((w) => <p key={w} className="hint">{w}</p>)}
      </div>
    );
  }

  if (!open) return null;

  const trimmedName = binName.trim();
  const nameInvalid = trimmedName.includes('/');
  const canCreate = connected && sourceBin && trimmedName && !nameInvalid;

  return (
    <div className="tool-overlay" role="dialog" aria-label="Create multicam">
      <header className="tool-header">
        <h2 className="tool-title">Create multicam</h2>
        <button className="tool-close" onClick={onClose} disabled={busy} aria-label="Close" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <div className="tool-body tool-body--form">
        {stage === 'configure' && renderConfigure()}
        {stage === 'running' && (
          <div className="run-loading">
            <span className="spinner" />
            <span>Creating multicam…</span>
          </div>
        )}
        {stage === 'done' && renderDone()}
      </div>

      <footer className="tool-footer tool-footer--form">
        {stage === 'configure' && (
          <button className="btn primary" disabled={!canCreate} onClick={handleCreate}>Create</button>
        )}
        {stage === 'done' && result?.error && (
          <button className="btn ghost" onClick={() => setStage('configure')}>Back</button>
        )}
        {stage === 'done' && (
          <button className="btn primary" onClick={onClose}>Done</button>
        )}
      </footer>
    </div>
  );
}
