/**
 * CardIngestOverlay — camera card (SD / CFexpress) ingest to the NAS.
 *
 * Two views, driven by the main-process engine (workers/card_ingest.js):
 *   check — every mounted card, checked against the ledger and its destination:
 *           to copy / already on NAS / renamed / unfinalized; a destination per
 *           card; nothing copies until Start ingest
 *   run   — the engine's run snapshot: progress while running, then the report
 *           (safe to format, renames, failures) and an optional Resolve import
 *
 * The run lives in the main process, so this overlay can close and reopen
 * mid-copy. App opens it when a card is inserted.
 *
 * Props: open, onClose, resolveConnected, resolveProject, onLog
 */
const CARD_IMPORT_DEFAULT_BIN = 'FOOTAGE / CARDS';

function ciBytes(n) {
  if (!n || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1000)));
  return `${(n / Math.pow(1000, i)).toFixed(i < 2 ? 0 : 1)} ${units[i]}`;
}

function ciDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// Check-view file status → dot + label.
const CI_CHECK_STATE = {
  'copy':        { dot: 'is-pending', cls: 'accent',  label: () => 'Copy' },
  'rename':      { dot: 'is-pending', cls: 'info',    label: (f) => `Copy as ${f.destName}` },
  'on-nas':      { dot: 'is-skipped', cls: 'dim',     label: () => 'On NAS' },
  'unfinalized': { dot: 'is-error warning', cls: 'warning', label: () => 'Unfinalized · repair in camera' },
  'error':       { dot: 'is-error',   cls: 'danger',  label: () => 'Unreadable' },
};

// Run-view file state → dot + label.
const CI_RUN_STATE = {
  waiting:     { dot: 'is-pending', cls: 'dim',     label: () => 'Waiting' },
  copying:     { dot: 'is-active',  cls: 'info',    label: (f) => `Copying ${f.size ? Math.floor((f.copyBytes / f.size) * 100) : 0}%` },
  verifying:   { dot: 'is-active',  cls: 'info',    label: () => 'Verifying' },
  copied:      { dot: 'is-done',    cls: 'success', label: () => 'Verified' },
  'on-nas':    { dot: 'is-skipped', cls: 'dim',     label: () => 'On NAS' },
  unfinalized: { dot: 'is-error warning', cls: 'warning', label: () => 'Unfinalized' },
  failed:      { dot: 'is-error',   cls: 'danger',  label: () => 'Failed' },
  canceled:    { dot: 'is-skipped', cls: 'dim',     label: () => 'Canceled' },
};

// Thumbnails come from the main process as data URLs (the camera's own
// THMBNL JPG, a still's companion JPG, else one ffmpeg frame). Cached here
// for the session so reopening the overlay doesn't refetch.
const ciThumbCache = new Map();

function CiThumb({ root, relPath, size = 'row' }) {
  const key = `${root}|${relPath}`;
  const [url, setUrl] = React.useState(() => ciThumbCache.get(key));
  React.useEffect(() => {
    if (ciThumbCache.has(key)) { setUrl(ciThumbCache.get(key)); return undefined; }
    let alive = true;
    window.cardIngestAPI?.thumbnail(root, relPath).then(res => {
      const u = res?.ok ? res.data : null;
      ciThumbCache.set(key, u);
      if (alive) setUrl(u);
    });
    return () => { alive = false; };
  }, [key]);
  return url
    ? <img className={`ci-thumb ci-thumb--${size}`} src={url} alt="" loading="lazy" />
    : <span className={`ci-thumb ci-thumb--${size} is-empty`} aria-hidden="true" />;
}

const CI_STRIP_MAX = 8;

function CardIngestOverlay({ open, onClose, resolveConnected, resolveProject, onLog }) {
  const [cards, setCards]       = React.useState([]);
  const [dests, setDests]       = React.useState({});      // root → folder
  const [excluded, setExcluded] = React.useState(() => new Set());
  const [checks, setChecks]     = React.useState({});      // root → check result
  const [checking, setChecking] = React.useState(false);
  const [expanded, setExpanded] = React.useState(() => new Set());
  const [lastDest, setLastDest] = React.useState('');
  const [run, setRun]           = React.useState(null);
  const [starting, setStarting] = React.useState(false);
  const [error, setError]       = React.useState(null);
  const checkSeq = React.useRef(0);

  // Resolve import (report view)
  const [importBin, setImportBin]       = React.useState(CARD_IMPORT_DEFAULT_BIN);
  const [binTree, setBinTree]           = React.useState([]);
  const [importState, setImportState]   = React.useState('idle'); // idle|running|done|error
  const [importResult, setImportResult] = React.useState(null);

  // Open: pick up a run in flight (or its report), else list cards.
  React.useEffect(() => {
    if (!open || !window.cardIngestAPI) return;
    setError(null);
    setImportState('idle');
    setImportResult(null);
    window.cardIngestAPI.snapshot().then(r => setRun(r?.data || null));
    window.cardIngestAPI.lastDest().then(r => setLastDest(r?.data || ''));
    window.cardIngestAPI.listCards().then(r => { if (r?.ok) setCards(r.data || []); });
    const offCards  = window.cardIngestAPI.onCards(({ cards: next }) => setCards(next || []));
    const offUpdate = window.cardIngestAPI.onUpdate((snap) => setRun(snap));
    return () => { offCards(); offUpdate(); };
  }, [open]);

  // New cards start on the last-used destination.
  React.useEffect(() => {
    if (!lastDest) return;
    setDests(prev => {
      let changed = false;
      const next = { ...prev };
      for (const c of cards) if (!(c.root in next)) { next[c.root] = lastDest; changed = true; }
      return changed ? next : prev;
    });
  }, [cards, lastDest]);

  // Re-check whenever the card set or a destination changes.
  const cardKey = cards.map(c => c.root).join('|');
  const destKey = cards.map(c => dests[c.root] || '').join('|');
  React.useEffect(() => {
    if (!open || run || !window.cardIngestAPI) return;
    if (cards.length === 0) { setChecks({}); return; }
    const seq = ++checkSeq.current;
    setChecking(true);
    const ordered = [...cards].sort((a, b) => Number(excluded.has(a.root)) - Number(excluded.has(b.root)));
    window.cardIngestAPI.check(ordered.map(c => ({ root: c.root, dest: dests[c.root] || null })))
      .then(res => {
        if (seq !== checkSeq.current) return;
        if (!res?.ok) { setError(res?.error || 'Check failed'); return; }
        const map = {};
        for (const r of res.data || []) map[r.root] = r;
        setChecks(map);
        setError(null);
      })
      .finally(() => { if (seq === checkSeq.current) setChecking(false); });
  }, [open, !!run, cardKey, destKey]);

  // Bins for the Resolve import (report view only).
  const reportReady = !!run && run.state !== 'running';
  React.useEffect(() => {
    if (!open || !reportReady || !resolveConnected || !window.leaderpassAPI) { setBinTree([]); return; }
    let cancelled = false;
    window.leaderpassAPI.call('list_media_bins')
      .then(res => { if (!cancelled) setBinTree(Array.isArray(res?.data?.bin_tree) ? res.data.bin_tree : []); })
      .catch(() => { if (!cancelled) setBinTree([]); });
    return () => { cancelled = true; };
  }, [open, reportReady, resolveConnected]);

  React.useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onClose?.(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // ── Actions ─────────────────────────────────────────────

  async function pickDest(root) {
    const res = await window.dialogAPI?.pickFolder();
    if (res && !res.canceled && res.folderPath) setDests(prev => ({ ...prev, [root]: res.folderPath }));
  }

  function toggleInclude(root) {
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root); else next.add(root);
      return next;
    });
  }

  function toggleExpanded(root) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root); else next.add(root);
      return next;
    });
  }

  const startable = cards
    .map(c => checks[c.root])
    .filter(r => r && !r.error && !excluded.has(r.root) && r.summary.toCopy > 0);
  const missingDest = startable.some(r => !dests[r.root]);
  const startFiles = startable.reduce((s, r) => s + r.summary.toCopy, 0);
  const startBytes = startable.reduce((s, r) => s + r.summary.toCopyBytes, 0);

  async function handleStart() {
    if (starting || startable.length === 0 || missingDest) return;
    setStarting(true);
    setError(null);
    try {
      const res = await window.cardIngestAPI.start(startable.map(r => ({ root: r.root, dest: dests[r.root] })));
      if (!res?.ok) setError(res?.error || 'Could not start the ingest');
      else setRun(res.run);
    } finally {
      setStarting(false);
    }
  }

  async function handleDone() {
    await window.cardIngestAPI.dismiss();
    setRun(null);
    onClose?.();
  }

  async function handleImport() {
    if (!run || !window.leaderpassAPI) return;
    const files = run.cards.flatMap(c => c.files)
      .filter(f => f.kind === 'video' && (f.state === 'copied' || f.state === 'on-nas') && f.where)
      .map(f => ({ local_path: f.where, bin_segments: [] }));
    if (files.length === 0) return;
    setImportState('running');
    onLog?.(`[Cards] Importing ${files.length} clip(s) into Resolve: ${importBin}…`);
    try {
      const res = await window.leaderpassAPI.call('import_media', { parent_bin: importBin, files });
      const data = res?.data || {};
      setImportResult({ imported: data.imported ?? 0, failed: data.failed ?? 0 });
      setImportState('done');
    } catch (err) {
      const msg = err?.error?.message || err?.error || err?.message || 'import failed';
      onLog?.(`[Cards] Resolve import failed: ${msg}`);
      setImportState('error');
    }
  }

  // ── Check view ──────────────────────────────────────────

  function renderCheckCard(card) {
    const r = checks[card.root];
    const s = r && !r.error ? r.summary : null;
    const done = s && s.toCopy === 0;
    const isIncluded = !excluded.has(card.root) && !done;
    const isOpen = expanded.has(card.root);
    const meta = [card.formats.join(' + '), card.usedBytes != null ? `${ciBytes(card.usedBytes)} used` : null]
      .filter(Boolean).join(' · ');

    return (
      <section key={card.root} className={`ci-card${isIncluded ? ' is-included' : ''}`}>
        <div className="ci-card-head">
          <input
            type="checkbox"
            className="ci-check"
            checked={isIncluded}
            disabled={!s || done}
            onChange={() => toggleInclude(card.root)}
            aria-label={`Include ${card.label}`}
          />
          <div className="ci-card-name">
            <span className="ci-card-title">{card.label}</span>
            <span className="ci-card-meta">{meta}</span>
          </div>
          <div className="ci-card-tags">
            {!r && <span className="run-loading"><span className="spinner small" /><span>Checking…</span></span>}
            {r?.error && <span className="tag danger">{r.error}</span>}
            {s && s.toCopy > 0 && <span className="tag accent">{s.toCopy} to copy · {ciBytes(s.toCopyBytes)}</span>}
            {s && s.onNas > 0 && <span className="tag">{s.onNas} on NAS</span>}
            {s && s.renamed > 0 && <span className="tag info">{s.renamed} renamed</span>}
            {s && s.unfinalized > 0 && <span className="tag warning">{s.unfinalized} unfinalized</span>}
            {s && s.safeToFormat && <span className="tag success">Safe to format</span>}
            {s && s.mediaCount === 0 && s.unfinalized === 0 && <span className="tag">No media</span>}
            {r?.files?.length > 0 && (
              <button className="btn ghost small" onClick={() => toggleExpanded(card.root)}>
                {isOpen ? 'Hide files' : 'Show files'}
              </button>
            )}
          </div>
        </div>

        {r?.files?.some(f => f.kind !== 'unfinalized') && (
          <button className="ci-strip" onClick={() => toggleExpanded(card.root)} aria-label={`Show files on ${card.label}`}>
            {r.files.filter(f => f.kind !== 'unfinalized').slice(0, CI_STRIP_MAX).map(f => (
              <CiThumb key={f.relPath} root={card.root} relPath={f.relPath} size="strip" />
            ))}
            {r.files.filter(f => f.kind !== 'unfinalized').length > CI_STRIP_MAX && (
              <span className="ci-strip-more">+{r.files.filter(f => f.kind !== 'unfinalized').length - CI_STRIP_MAX}</span>
            )}
          </button>
        )}

        {s && !done && (
          <div className="ci-dest">
            <p className="section-label">Destination</p>
            <div className="ci-dest-row">
              <span className={`ci-path${dests[card.root] ? '' : ' is-empty'}`}>{dests[card.root] || 'Choose a folder'}</span>
              <button className="btn ghost" onClick={() => pickDest(card.root)}>Browse…</button>
            </div>
          </div>
        )}
        {done && s.onNas > 0 && (
          <p className="ci-done-where">{[...new Set(r.files.filter(f => f.where).map(f => f.where.replace(/[\\/][^\\/]*$/, '')))].join(' · ')}</p>
        )}

        {isOpen && r?.files && (
          <div className="ci-files">
            {r.files.map(f => {
              const st = CI_CHECK_STATE[f.status] || CI_CHECK_STATE.copy;
              return (
                <div key={f.relPath} className="ci-file" title={f.where || f.error || f.relPath}>
                  <span className={`status-dot ${st.dot}`} />
                  <CiThumb root={card.root} relPath={f.relPath} />
                  <span className="ci-file-name">{f.name}</span>
                  <span className="ci-file-size">{ciBytes(f.size)}</span>
                  <span className={`ci-file-state ${st.cls}`}>{st.label(f)}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  function renderCheck() {
    return (
      <>
        {error && <p className="notice error">{error}</p>}
        {cards.length === 0 && <p className="run-empty">No camera cards found.</p>}
        {cards.map(renderCheckCard)}
      </>
    );
  }

  // ── Run view ────────────────────────────────────────────

  function renderProgress() {
    const pct = run.workTotal > 0 ? Math.min(100, Math.floor((run.workDone / run.workTotal) * 100)) : 0;
    const left = run.speed > 0 ? (run.workTotal - run.workDone) / run.speed * 1000 : null;
    const all = run.cards.flatMap(c => c.files);
    const count = (st) => all.filter(f => f.state === st).length;
    return (
      <>
        <section className="ci-card">
          <div className="ci-overall">
            <span className="ci-overall-pct">{pct}%</span>
            <span className="ci-overall-meta">{ciBytes(run.copyBytes)} of {ciBytes(run.bytesTotal)}</span>
            <span className="ci-overall-meta ci-push">
              {run.cancelRequested ? 'Canceling…'
                : run.speed > 0 ? `${ciBytes(run.speed / 2)}/s · about ${ciDuration(left)} left` : 'Starting…'}
            </span>
          </div>
          <div className="run-progress-track ci-track-lg"><div className="run-progress-fill" style={{ width: `${pct}%` }} /></div>
          <div className="ci-counts">
            <span><b className="success">{count('copied')}</b> verified</span>
            <span><b className="info">{count('copying') + count('verifying')}</b> copying</span>
            <span>{count('waiting')} waiting</span>
            <span>{count('failed')} failed</span>
          </div>
        </section>
        {run.cards.map(renderRunCard)}
      </>
    );
  }

  function renderRunCard(card) {
    const copied = card.files.reduce((s, f) => s + (f.state === 'on-nas' ? 0 : (f.copyBytes || 0)), 0);
    const pct = card.bytesTotal > 0 ? Math.min(100, Math.floor((copied / card.bytesTotal) * 100)) : 100;
    return (
      <section key={card.root} className="ci-card">
        <div className="ci-card-head">
          <div className="ci-card-name">
            <span className="ci-card-title">{card.label}</span>
            <span className="ci-card-meta ci-mono">→ {card.dest}</span>
          </div>
          <span className="ci-card-meta ci-push">{ciBytes(copied)} of {ciBytes(card.bytesTotal)}</span>
        </div>
        <div className="ci-pad"><div className="run-progress-track"><div className="run-progress-fill" style={{ width: `${pct}%` }} /></div></div>
        <div className="ci-files">
          {card.files.map(f => {
            const st = CI_RUN_STATE[f.state] || CI_RUN_STATE.waiting;
            return (
              <div key={f.relPath} className="ci-file" title={f.error || f.where || f.relPath}>
                <span className={`status-dot ${st.dot}`} />
                <CiThumb root={card.root} relPath={f.relPath} />
                <span className="ci-file-name">{f.name}{f.destName && f.destName !== f.name ? ` → ${f.destName}` : ''}</span>
                <span className="ci-file-size">{ciBytes(f.size)}</span>
                <span className={`ci-file-state ${st.cls}`}>{st.label(f)}</span>
              </div>
            );
          })}
        </div>
      </section>
    );
  }

  function renderReportCard(card) {
    const rep = card.report || {};
    const notes = [
      ...card.files.filter(f => f.kind === 'unfinalized').map(f => ({
        key: f.relPath, cls: 'is-error warning', text: <><span className="ci-mono">{f.name}</span> · {ciBytes(f.size)} · unfinalized, not copied. Repair it in the camera, then check this card again.</>
      })),
      ...card.files.filter(f => f.state === 'copied' && f.destName !== f.name).map(f => ({
        key: f.relPath, cls: 'is-active', text: <><span className="ci-mono">{f.name} → {f.destName}</span> · a different {f.name} was already in the folder</>
      })),
      ...card.files.filter(f => f.state === 'failed').map(f => ({
        key: f.relPath, cls: 'is-error', text: <><span className="ci-mono">{f.name}</span> · {f.error || 'failed'}</>
      })),
    ];
    return (
      <section key={card.root} className="ci-card ci-report">
        <div className="ci-card-head">
          <div className="ci-card-name"><span className="ci-card-title">{card.label}</span></div>
          <span className="ci-push">
            {rep.safeToFormat
              ? <span className="tag success">Safe to format</span>
              : <span className="tag warning">Don’t format yet</span>}
          </span>
        </div>
        <div className="ci-stats">
          <div className="ci-stat"><b>{rep.copied || 0}</b><span>Copied · {ciBytes(rep.copiedBytes)}</span></div>
          <div className="ci-stat"><b>{rep.copied || 0}/{rep.copied || 0}</b><span>Verified</span></div>
          <div className="ci-stat"><b>{rep.onNas || 0}</b><span>Already on NAS</span></div>
          <div className="ci-stat"><b>{rep.renamed || 0}</b><span>Renamed</span></div>
          <div className="ci-stat"><b className={rep.failed ? 'danger' : ''}>{rep.failed || 0}</b><span>Failed</span></div>
        </div>
        {notes.length > 0 && (
          <div className="ci-notes">
            {notes.map(n => (
              <div key={n.key} className="ci-note"><span className={`status-dot ${n.cls}`} /><span>{n.text}</span></div>
            ))}
          </div>
        )}
        <div className="ci-dest-row">
          <span className="ci-card-meta ci-mono">{card.dest}</span>
          <button className="btn ghost small ci-push" onClick={() => window.cardIngestAPI.openFolder(card.dest)}>Open folder</button>
        </div>
      </section>
    );
  }

  function renderReport() {
    const videoCount = run.cards.flatMap(c => c.files)
      .filter(f => f.kind === 'video' && (f.state === 'copied' || f.state === 'on-nas')).length;
    const options = binTree.length ? [...binTree] : [];
    if (!options.some(b => b.path === importBin)) options.unshift({ path: importBin, name: importBin, depth: 1 });
    return (
      <>
        {run.cards.map(renderReportCard)}
        {videoCount > 0 && (
          <section className="ci-card ci-import">
            <div className="ci-card-name">
              <span className="ci-card-title">Import into Resolve</span>
              <span className="ci-card-meta">
                {resolveConnected ? `${videoCount} clips · ${resolveProject || 'Current project'}` : 'Resolve not connected'}
              </span>
            </div>
            {resolveConnected && importState !== 'done' && (
              <div className="ci-import-controls">
                <select className="settings-input" value={importBin} onChange={e => setImportBin(e.target.value)} disabled={importState === 'running'} aria-label="Import bin">
                  {options.map(b => (
                    <option key={b.path} value={b.path}>{b.depth > 1 ? '   '.repeat(b.depth - 1) : ''}{b.name}</option>
                  ))}
                </select>
                <button className="btn ghost" onClick={handleImport} disabled={importState === 'running'}>
                  {importState === 'running' ? 'Importing…' : 'Import'}
                </button>
              </div>
            )}
            {importState === 'done' && importResult && (
              <span className="ci-card-meta ci-push">
                {importResult.imported} imported{importResult.failed ? ` · ${importResult.failed} failed` : ''}
              </span>
            )}
            {importState === 'error' && <span className="tag danger ci-push">Import failed</span>}
          </section>
        )}
      </>
    );
  }

  // ── Frame ───────────────────────────────────────────────

  const running = !!run && run.state === 'running';
  const title = !run ? 'Card ingest'
    : running ? 'Card ingest'
    : run.state === 'canceled' ? 'Ingest canceled' : 'Ingest complete';
  const subtitle = !run ? (cards.length ? `${cards.length} card${cards.length !== 1 ? 's' : ''}` : '')
    : running ? `Copying ${run.cards.length} card${run.cards.length !== 1 ? 's' : ''}`
    : run.finishedAt ? ciDuration(run.finishedAt - run.startedAt) : '';

  return (
    <div className="tool-overlay" role="dialog" aria-label="Card ingest">
      <header className="tool-header">
        <h2 className="tool-title">{title}</h2>
        {subtitle && <span className="tool-subtitle">{subtitle}</span>}
        {!run && checking && cards.length > 0 && <span className="spinner small" aria-label="Checking" />}
        <button className="tool-close" onClick={() => onClose?.()} aria-label="Close" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <div className="tool-body tool-body--report">
        {!run && renderCheck()}
        {running && renderProgress()}
        {reportReady && renderReport()}
      </div>

      <footer className="tool-footer tool-footer--report">
        {!run && (
          <>
            {startable.length > 0 && (
              <span className="tool-footer-status">
                {missingDest ? 'Choose a destination for each card'
                  : `${startable.length} card${startable.length !== 1 ? 's' : ''} · ${startFiles} file${startFiles !== 1 ? 's' : ''} · ${ciBytes(startBytes)}`}
              </span>
            )}
            <button className="btn ghost" onClick={() => onClose?.()}>Cancel</button>
            <button className="btn primary" onClick={handleStart} disabled={starting || checking || startable.length === 0 || missingDest}>
              {starting ? 'Starting…' : 'Start ingest'}
            </button>
          </>
        )}
        {running && (
          <>
            <span className="tool-footer-status">Started {new Date(run.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
            <button className="btn danger" onClick={() => window.cardIngestAPI.cancel()} disabled={run.cancelRequested}>
              {run.cancelRequested ? 'Canceling…' : 'Cancel'}
            </button>
          </>
        )}
        {reportReady && (
          <button className="btn primary" onClick={handleDone} disabled={importState === 'running'}>Done</button>
        )}
      </footer>
    </div>
  );
}
