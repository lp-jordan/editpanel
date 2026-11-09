/**
 * CreateMulticamOverlay — build a multicam from a media-pool bin, optionally
 * with one timeline per recording span (helper/commands/create_multicam.py).
 *
 * Props:
 *   open       — boolean
 *   onClose    — () => void
 *   connected  — boolean (Resolve connection)
 *   resolveProject — string (preselects the LPOS project of the same name)
 *   onLog      — (msg: string) => void
 */
const DEFAULT_TIMELINE_BIN = 'SEQUENCES';

function CreateMulticamOverlay({ open, onClose, connected, resolveProject, onLog }) {
  const [stage, setStage] = React.useState('configure'); // 'configure' | 'running' | 'done'
  const [binTree, setBinTree] = React.useState([]);
  const [binsLoading, setBinsLoading] = React.useState(false);
  const [sourceBin, setSourceBin] = React.useState('');
  const [mcName, setMcName] = React.useState('');
  const [nameEdited, setNameEdited] = React.useState(false);
  const [buildTimelines, setBuildTimelines] = React.useState(false);
  const [lposProjects, setLposProjects] = React.useState([]);
  const [lposProjectId, setLposProjectId] = React.useState('');
  const [firstCode, setFirstCode] = React.useState('');
  const [timelineBin, setTimelineBin] = React.useState(DEFAULT_TIMELINE_BIN);
  const [result, setResult] = React.useState(null); // { error } | handler output

  React.useEffect(() => {
    if (!open) return;
    setStage('configure');
    setSourceBin('');
    setMcName('');
    setNameEdited(false);
    setBuildTimelines(false);
    setLposProjectId('');
    setFirstCode('');
    setTimelineBin(DEFAULT_TIMELINE_BIN);
    setResult(null);
  }, [open]);

  React.useEffect(() => {
    if (!open || !buildTimelines || lposProjects.length || !window.cutThroughAPI) return;
    let cancelled = false;
    window.cutThroughAPI.listLposProjects().then((res) => {
      if (cancelled) return;
      const list = res?.data?.lposProjects || [];
      setLposProjects(list);
      const want = String(resolveProject || '').trim().toLowerCase();
      const match = want && list.find((p) => String(p.name).trim().toLowerCase() === want);
      if (match) setLposProjectId(match.id);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open, buildTimelines]);

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
    if (!nameEdited) setMcName(binTree.find((b) => b.path === path)?.name || '');
  }

  async function handleCreate() {
    setStage('running');
    const name = mcName.trim();
    onLog?.(`[multicam] Creating "${name}" from ${sourceBin}…`);
    let data = null;
    try {
      const res = await window.leaderpassAPI.call('create_multicam', {
        source_bin: sourceBin,
        multicam_name: name,
        reuse_existing: buildTimelines,
      });
      data = res?.data || {};
      onLog?.(`[multicam] ${data.reused ? 'Using existing' : 'Created'} ${data.multicam} in ${data.bin}`);
      (data.warnings || []).forEach((w) => onLog?.(`[multicam] ${w}`));

      if (buildTimelines && data.day) {
        const named = await window.cutThroughAPI.nameMulticamTimelines({
          day: data.day, label: name, projectId: lposProjectId, firstCode: firstCode.trim(),
        });
        if (!named?.ok) throw new Error(named?.error || 'Could not read the slate');
        const timelines = named.data.timelines;
        const tl = await window.leaderpassAPI.call('create_multicam_timelines', { multicam_name: name, timeline_bin: timelineBin, timelines });
        const uncoded = timelines.filter((t) => !t.code).length;
        const warnings = [...(data.warnings || [])];
        if (uncoded) warnings.push(`${uncoded} timeline${uncoded !== 1 ? 's' : ''} had no J-code.`);
        data = { ...data, ...tl?.data && { timelines_built: tl.data.built, timelines_skipped: tl.data.skipped.length, timelines_failed: tl.data.failed }, warnings };
        onLog?.(`[multicam] Timelines: ${(tl?.data?.built || []).join(', ') || 'none'}`);
      }
      setResult(data);
    } catch (err) {
      const msg = String(err?.error?.message || err?.error || err?.message || err);
      setResult({ error: msg, created: data?.multicam });
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
          <p className="atem-field-label">Multicam Sequence Name</p>
          <input
            className="settings-input"
            type="text"
            value={mcName}
            onChange={(e) => { setMcName(e.target.value); setNameEdited(true); }}
          />
          {nameInvalid && <p className="error-text">Name can’t contain /.</p>}
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

          {buildTimelines && (
            <>
              <div className="atem-dest-section" style={{ marginTop: 10 }}>
                <p className="atem-field-label">Timelines bin</p>
                <select className="settings-input" value={timelineBin} onChange={(e) => setTimelineBin(e.target.value)} disabled={binsLoading}>
                  {!binTree.some((b) => b.path === timelineBin) && <option value={timelineBin}>{timelineBin}</option>}
                  {binTree.map((b) => (
                    <option key={b.path} value={b.path}>
                      {b.depth > 1 ? '\u00A0\u00A0\u00A0'.repeat(b.depth - 1) : ''}{b.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="atem-dest-section" style={{ marginTop: 10 }}>
                <p className="atem-field-label">LPOS project</p>
                <select className="settings-input" value={lposProjectId} onChange={(e) => setLposProjectId(e.target.value)}>
                  <option value="">No slate</option>
                  {lposProjects.map((p) => (
                    <option key={p.id} value={p.id}>{p.client ? `${p.client} — ${p.name}` : p.name}</option>
                  ))}
                </select>
              </div>
              <div className="atem-dest-section" style={{ marginTop: 10 }}>
                <p className="atem-field-label">First J-code</p>
                <input
                  className="settings-input"
                  type="text"
                  value={firstCode}
                  disabled={!lposProjectId}
                  onChange={(e) => setFirstCode(e.target.value)}
                />
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  function renderDone() {
    if (result?.error) {
      return (
        <>
          {result.created && <p className="run-summary-sub">{result.created} is ready. Timelines weren’t built.</p>}
          <p className="notice error">{result.error}</p>
        </>
      );
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

  const trimmedName = mcName.trim();
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
