/**
 * CutThroughPage — Cut-through (beta): a day multicam → AI rough cuts.
 *
 * Front end for electron/workers/cut_through.js, which runs the cut_through/ pipeline. All run
 * state lives in the main process and arrives on cutThroughAPI.onUpdate, so leaving the page
 * never stops a run. Copy stays minimal: labels, empty states, errors.
 *
 * Layout (cleanup plan, docs/cut-through-audit-2026-11-11.md Part 3):
 *   Source (multicam · label · run folder)
 *   1 Prep · 2 Transcribe · 3 Videos · 4 Plan · 5 Build      ← the run, one primary button on the page
 *   Review: Check · Compare                                    ← after the build, shared timeline picker
 *   Settings (Advanced inside)
 * Colours carry one meaning each: gold = the next action, blue = running, green = done,
 * amber = needs a look / out of date, red = failed. Plain facts are plain text, not tags.
 *
 * Props:
 *   connected — Resolve connection (boolean)
 */
const CT_RUN = ['prep', 'transcribe', 'plan', 'build'];          // engine steps whose results feed the next

function ctDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function ctWhen(ts) {
  const d = new Date(ts);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

function ctMoney(x) {
  return Number.isFinite(x) ? `$${x < 10 ? x.toFixed(2) : x.toFixed(0)}` : '';
}

/** A batch still points at this label's transcript (prepared, at Anthropic, or ended and not collected). */
function ctBatchWaiting(vids) {
  const b = vids && vids.batch;
  return Boolean(b && (['draft', 'in_progress', 'canceling'].includes(b.status) || (b.status === 'ended' && !b.collected)));
}

/** Videos or section. A waiting batch keeps the label in videos, where its Discard / Cancel / Collect live
 *  (the switch is locked while it waits, so section mode would hide them with no way back). */
function ctPlanMode(picked, vids) {
  if (ctBatchWaiting(vids)) return 'videos';
  return picked || (vids && vids.active ? 'videos' : 'section');
}

/** "Done · 4m 12s", "Failed · Nov 9 3:30 PM", … for an engine step. */
function ctStatusText(st, now) {
  if (!st) return '';
  const took = st.earlier ? ctWhen(st.finishedAt) : ctDuration(st.finishedAt - st.startedAt);
  switch (st.status) {
    case 'running': return `Running · ${ctDuration(now - st.startedAt)}`;
    case 'done': return `Done · ${took}`;
    case 'failed': return `Failed · ${took}`;
    case 'canceled': return `Canceled · ${took}`;
    default: return '';
  }
}

const CT_DELIVERY = [['scripted', 'Scripted'], ['free', 'Free talk'], ['stage', 'Stage'], ['convo', 'Conversation']];
const CT_ROLE_LABEL = { wide: 'Wide', closeup: 'Close-up', slider: 'Slider', side: 'Side', other: 'Other' };

/** One progress line for everything that runs: phase · elapsed · time left, and a bar
 *  (determinate when there is a %). `eta` (ms) is a known total; otherwise it's worked out from %. */
function CtProgress({ text, startedAt, pct, eta, now }) {
  const elapsed = startedAt ? now - startedAt : null;
  let left = null;
  if (pct != null && pct >= 5 && pct < 100 && elapsed > 20000) left = (elapsed * (100 - pct)) / pct;
  else if (eta && elapsed != null && eta > elapsed) left = eta - elapsed;
  return (
    <div className="ct-progress">
      <div className="ct-progress-text">
        <span className="ct-progress-phase">{text}{elapsed != null ? <span className="dim"> · {ctDuration(elapsed)}</span> : null}</span>
        <span className="dim">{left != null ? `≈ ${ctDuration(left)} left` : ''}{pct != null ? `${left != null ? ' · ' : ''}${Math.round(pct)}%` : ''}</span>
      </div>
      <div className={`run-progress-track${pct == null ? ' is-indeterminate' : ''}`}>
        <div className="run-progress-fill" style={{ width: `${pct == null ? 100 : pct || 0}%` }} />
      </div>
    </div>
  );
}

/** A running engine step's progress as a CtProgress. */
function ctStepProgress(st, now, eta) {
  const p = st.progress || {};
  const pct = p.bar != null ? p.bar : p.overall;
  const text = p.phase || (p.angle ? `${p.angle} · mic ${p.mic}/${p.mics} · ${(p.doneMin || 0).toFixed(1)}/${(p.totalMin || 0).toFixed(1)} min` : 'Starting');
  return <CtProgress text={text} startedAt={p.phaseAt || st.startedAt} pct={pct == null ? null : pct} eta={eta} now={now} />;
}

function CtReport({ lines, live }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines && lines.length, live]);
  if (!lines || lines.length === 0) return null;
  return <pre ref={ref} className={`ct-report${live ? ' live' : ''}`}>{lines.join('\n')}</pre>;
}

/** One labelled row of a step's facts / options. Top level so typing in a row's input never remounts it. */
function CtRow({ label, children }) {
  return (
    <>
      <div className="ct-grid-label">{label}</div>
      <div className="ct-grid-value">{children}</div>
    </>
  );
}

/** "⋯" menu for a step's secondary actions: [{ label, onClick, disabled }]. */
function CtMenu({ items }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const list = items.filter(Boolean);
  if (!list.length) return null;
  return (
    <div className="ct-menu" ref={ref}>
      <button type="button" className={`btn small ghost ct-menu-btn${open ? ' is-active' : ''}`} aria-haspopup="menu" aria-expanded={open}
        aria-label="More" onClick={() => setOpen(!open)}>⋯</button>
      {open && (
        <div className="ct-menu-list" role="menu">
          {list.map((it) => (
            <button key={it.label} type="button" role="menuitem" className="ct-menu-item" disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick(); }}>{it.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One step of the run. Finished steps fold to their header (click the title to open); the running
 * step, the next step and anything failed or out of date stay open.
 */
function CtStep({ n, title, status, statusText, need, actions, menu, progress, errors, report, open, onToggle, children }) {
  const foldable = typeof onToggle === 'function';
  const hasBody = progress || (errors && errors.length) || report || (open && children);
  return (
    <section className={`panel ct-step is-${status}${n == null ? ' is-sub' : ''}`}>
      <div className="ct-step-head">
        {n != null && <span className={`ct-step-badge is-${status}`}>{status === 'done' ? '✓' : n}</span>}
        {foldable ? (
          <button type="button" className="ct-step-titles ct-step-toggle" aria-expanded={open} onClick={onToggle}>
            <h3 className="ct-step-title">{title}</h3>
            <span className="ct-step-status">{need || statusText}</span>
            <span className={`ct-chevron${open ? ' is-open' : ''}`} aria-hidden="true">›</span>
          </button>
        ) : (
          <div className="ct-step-titles">
            <h3 className="ct-step-title">{title}</h3>
            <span className="ct-step-status">{need || statusText}</span>
          </div>
        )}
        <div className="ct-step-actions">
          {actions}
          {menu && <CtMenu items={menu} />}
        </div>
      </div>
      {hasBody && (
        <div className="ct-step-body">
          {progress}
          {(errors || []).map((e, k) => <div key={k} className="notice error">{e}</div>)}
          {open && children}
          {report}
        </div>
      )}
    </section>
  );
}

/** This machine's readiness: scripts, transcription pack, GPU, Claude key. Shown only while
 *  something is missing or an install is running; the pack's own row lives in Settings. */
function CtSetup({ ct, now, onInstall, onCancel, onTest, onOpenSettings }) {
  const su = ct.setup || {};
  const set = ct.settings;
  const inst = su.installing;
  const avail = su.available;
  const pack = set.pack;
  const update = Boolean(pack && avail && avail.version !== pack.version);
  const noPython = !pack && !set.wxPythonFound;
  const noGpu = Array.isArray(su.gpus) && su.gpus.length === 0;
  const testFailed = su.test && su.test.ok === false;
  if (!(noPython || noGpu || !set.scriptsFound || !set.claudeKey || (inst && (inst.phase || inst.error)) || testFailed || update)) return null;
  const sizeGb = avail && avail.bytes ? ` (${(avail.bytes / 1e9).toFixed(1)} GB)` : '';
  return (
    <section className="panel ct-step is-attention">
      <div className="ct-step-head"><h3 className="ct-step-title">Setup</h3></div>
      <div className="ct-grid">
        {!set.scriptsFound && <CtRow label="Scripts"><span className="tag danger">Not found: {set.pipelineDir}</span></CtRow>}
        {(noPython || update || inst || testFailed) && (
          <CtRow label="Transcription">
            {inst && inst.phase ? (
              <div className="ct-grow-block">
                <CtProgress text={inst.phase} startedAt={null} pct={inst.bar != null ? inst.bar : inst.overall} now={now} />
                <button type="button" className="btn small danger" onClick={onCancel}>Cancel</button>
              </div>
            ) : (
              <>
                {noPython && <span className="tag warning">Not installed</span>}
                {update && <span className="dim">{pack.version} → {avail.version}</span>}
                {(noPython || update) && (
                  <button type="button" className="btn small" disabled={!avail || Boolean(ct.busy)} onClick={onInstall}>
                    {update ? 'Update' : 'Install'}{sizeGb}
                  </button>
                )}
                {!avail && su.availableError && <span className="tag danger">{su.availableError}</span>}
                {testFailed && <button type="button" className="btn small ghost" onClick={onTest}>Test again</button>}
              </>
            )}
            {inst && inst.error && <div className="notice error">{inst.error}</div>}
            {testFailed && <CtReport lines={su.test.lines || []} live={false} />}
          </CtRow>
        )}
        {noGpu && <CtRow label="GPU"><span className="tag warning">No NVIDIA GPU found</span></CtRow>}
        {!set.claudeKey && (
          <CtRow label="Claude key">
            <span className="tag warning">Not set</span>
            <button type="button" className="btn small ghost" onClick={onOpenSettings}>Add key</button>
          </CtRow>
        )}
      </div>
    </section>
  );
}

/** "Never cut from X to Y" for one multicam (Jordan 2026-11-10). Checks are shared with the main
 *  process (electron/shared/angle_rules.js), which refuses a set that fails them. */
function AngleRulesDialog({ mc, angles, roles, rules, busy, error, onSave, onCancel }) {
  const [no, setNo] = React.useState(() => new Set(rules));
  const [both, setBoth] = React.useState(true);
  const AR = window.AngleRules;
  const key = (a, b) => `${a}>${b}`;
  const res = AR ? AR.check(angles, [...no], roles) : { errors: [], warnings: [] };
  const short = (a) => a.replace(/^Camera\s+/i, 'Cam ');
  function toggle(a, b) {
    const next = new Set(no);
    const on = !next.has(key(a, b));
    for (const k of [key(a, b), ...(both ? [key(b, a)] : [])]) (on ? next.add(k) : next.delete(k));
    setNo(next);
  }
  return (
    <div className="export-picker-overlay ct-dialog-overlay" role="dialog" aria-modal="true" aria-label="Angle rules">
      <div className="export-picker ct-dialog ct-rules-dialog">
        <header className="export-picker-head">
          <h3>Angle rules{mc ? ` · ${mc}` : ''}</h3>
        </header>
        <div className="export-picker-body">
          <div className="ct-rules-grid" style={{ gridTemplateColumns: `max-content repeat(${angles.length}, 52px)` }}>
            <div className="ct-rules-corner dim">From ↓ To →</div>
            {angles.map((b) => (
              <div key={b} className="ct-rules-head">{short(b)}<span className="dim">{CT_ROLE_LABEL[roles[b]] || ''}</span></div>
            ))}
            {angles.map((a) => (
              <React.Fragment key={a}>
                <div className="ct-rules-row">{short(a)} <span className="dim">{CT_ROLE_LABEL[roles[a]] || ''}</span></div>
                {angles.map((b) => (a === b ? <div key={b} className="ct-rule-cell self" /> : (
                  <button key={b} type="button" className={`ct-rule-cell${no.has(key(a, b)) ? ' blocked' : ''}`}
                    aria-pressed={no.has(key(a, b))} title={`${a} → ${b}`} onClick={() => toggle(a, b)}>
                    {no.has(key(a, b)) ? '✕' : '→'}
                  </button>
                )))}
              </React.Fragment>
            ))}
          </div>
          <label className="ct-pair">
            <input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} /> Both ways
          </label>
          <div className="ct-rules-checks">
            {res.errors.map((t) => <div key={t} className="notice error">{t}</div>)}
            {res.warnings.map((t) => <div key={t} className="notice warning">{t}</div>)}
            {!res.errors.length && !res.warnings.length && (
              <div className="dim">{no.size ? `${no.size} cut${no.size === 1 ? '' : 's'} blocked` : 'No cuts blocked'}</div>
            )}
          </div>
          {error && <div className="notice error">{error}</div>}
        </div>
        <footer className="export-picker-foot">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || res.errors.length > 0} onClick={() => onSave([...no])}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Set code box (Jordan 2026-11-11): a frame from the slate angle; drag a box around the J-code.
 *  Saved per Resolve project and used as is by Read slate; Reset goes back to finding it. */
function SlateBoxDialog({ api, angle, onClose }) {
  const [frame, setFrame] = React.useState(null);
  const [index, setIndex] = React.useState(0);
  const [box, setBox] = React.useState(null);
  const [drag, setDrag] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const imgRef = React.useRef(null);
  React.useEffect(() => {
    let live = true;
    setBusy(true);
    api.getSlateFrame(index).then((res) => {
      if (!live) return;
      setBusy(false);
      if (!res || res.ok === false) { setError((res && res.error) || 'No frame'); return; }
      setError(null);
      setFrame(res.data);
      setBox((b) => b || res.data.box);
    });
    return () => { live = false; };
  }, [index]);
  const at = (e) => {
    const r = imgRef.current.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const rectOf = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  const shown = drag ? rectOf(drag.from, drag.to) : box;
  const pct = (b) => ({ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
  async function save(next) {
    setBusy(true);
    const res = await api.setSlateBox(next);
    setBusy(false);
    if (!res || res.ok === false) { setError((res && res.error) || 'Not saved'); return; }
    onClose(res);
  }
  return (
    <div className="export-picker-overlay ct-dialog-overlay" role="dialog" aria-modal="true" aria-label="Code box">
      <div className="export-picker ct-dialog ct-slatebox-dialog">
        <header className="export-picker-head">
          <h3>Code box{angle ? ` · ${angle}` : ''}</h3>
        </header>
        <div className="export-picker-body">
          <div className="ct-slatebox-stage">
            {frame ? (
              <div className="ct-slatebox-frame"
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); const p = at(e); setDrag({ from: p, to: p }); }}
                onPointerMove={(e) => { if (drag) setDrag({ ...drag, to: at(e) }); }}
                onPointerUp={() => {
                  if (!drag) return;
                  const r = rectOf(drag.from, drag.to);
                  setDrag(null);
                  if (r.w >= 0.01 && r.h >= 0.01) setBox(r);
                }}>
                <img ref={imgRef} src={frame.image} alt="Slate frame" draggable={false} />
                {!shown && frame.usual && <div className="ct-slatebox-rect is-usual" style={pct(frame.usual)} />}
                {shown && <div className="ct-slatebox-rect" style={pct(shown)} />}
              </div>
            ) : <div className="ct-slatebox-empty dim">{busy ? 'Loading frame…' : ''}</div>}
          </div>
          <div className="ct-slatebox-nav">
            <button type="button" className="btn small ghost" disabled={busy || !frame || frame.count < 2} onClick={() => setIndex(index - 1)} aria-label="Previous frame">‹</button>
            <span className="dim">{frame ? `${frame.index + 1} / ${frame.count} · ${frame.clip}` : ''}</span>
            <button type="button" className="btn small ghost" disabled={busy || !frame || frame.count < 2} onClick={() => setIndex(index + 1)} aria-label="Next frame">›</button>
          </div>
          {error && <div className="notice error">{error}</div>}
        </div>
        <footer className="export-picker-foot">
          {frame && frame.box && <button type="button" className="btn ghost" disabled={busy} onClick={() => save(null)}>Reset</button>}
          <button type="button" className="btn ghost" disabled={busy} onClick={() => onClose(null)}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !box} onClick={() => save(box)}>Save</button>
        </footer>
      </div>
    </div>
  );
}

/** One video of the day as a table row: tick · name · start–end · length · type · status · flags · join. */
function CtVideoRow({ v, next, soloDefault, locked, busy, estimate, onPatch, onRetry, onJoin, onSplit }) {
  const [name, setName] = React.useState(v.name);
  React.useEffect(() => { setName(v.name); }, [v.name]);
  const delivery = v.delivery || (v.kind === 'convo' ? 'convo' : soloDefault);
  const st = (v.plan && v.plan.status) || 'none';
  const flags = v.flags || [];
  return (
    <div className={`ct-vrow${v.include ? '' : ' is-off'}`} role="row">
      <input type="checkbox" checked={v.include} disabled={locked} aria-label={`Include ${v.name}`}
        onChange={(e) => onPatch({ include: e.target.checked })} />
      <input className="settings-input ct-vname" value={name} disabled={locked} aria-label="Timeline name"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => { if (name.trim() && name !== v.name) onPatch({ name }); else setName(v.name); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      <span className="ct-vtc" title={`${v.fromTc} – ${v.toTc}`}>{v.fromTc}<span className="dim"> – </span>{v.toTc}</span>
      <span className="ct-vlen dim">{v.minutes.toFixed(1)} min</span>
      <select className="settings-input ct-vtype" value={delivery} disabled={locked} aria-label="Type"
        onChange={(e) => onPatch({ delivery: e.target.value })}>
        {CT_DELIVERY.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
      </select>
      <span className="ct-vstatus">
        {st === 'planned' && <span className="tag success">Planned{v.plan.via === 'batch' ? ' · batch' : ''}</span>}
        {st === 'queued' && <span className="tag info">In batch</span>}
        {st === 'failed' && <span className="tag danger" title={v.plan.error || ''}>Failed</span>}
        {st === 'failed' && !locked && <button type="button" className="btn small ghost" disabled={busy} onClick={onRetry}>Retry</button>}
        {estimate && <span className="dim">≈ {ctMoney(estimate.usd)}</span>}
      </span>
      <span className="ct-vflags">
        {v.joined && <span className="tag info" title="Joined by hand">Joined</span>}
        {flags.length > 0 && (
          <span className="tag warning" title={flags.join('\n')}>{flags.length === 1 ? flags[0] : `${flags[0]} +${flags.length - 1}`}</span>
        )}
      </span>
      <span className="ct-vjoin">
        {v.joined && onSplit && <button type="button" className="btn small ghost" disabled={locked} onClick={onSplit} title="Undo the join">Split</button>}
        {next && onJoin && (
          <button type="button" className="btn small ghost ct-join" disabled={locked} onClick={onJoin}
            title={`Join with ${next.name} (one video)`} aria-label={`Join ${v.name} with ${next.name}`}>Join ↓</button>
        )}
      </span>
    </div>
  );
}

function CutThroughPage({ connected }) {
  const api = window.cutThroughAPI;
  const [ct, setCt] = React.useState(null);
  const [now, setNow] = React.useState(Date.now());
  const [labelDraft, setLabelDraft] = React.useState('');
  const [minutes, setMinutes] = React.useState('');
  const [planForm, setPlanForm] = React.useState({ start: '', end: '', delivery: 'scripted', useMarks: false });
  const [rolesDraft, setRolesDraft] = React.useState({});
  const [rulesOpen, setRulesOpen] = React.useState(false);
  const [boxOpen, setBoxOpen] = React.useState(false);
  const [rulesBusy, setRulesBusy] = React.useState(false);
  const [bins, setBins] = React.useState([]);
  const [timelines, setTimelines] = React.useState([]);
  const [reviewTimeline, setReviewTimeline] = React.useState('');
  const [openReports, setOpenReports] = React.useState({});
  const [unfolded, setUnfolded] = React.useState({});          // key → true/false, the editor's own choice
  const [errors, setErrors] = React.useState({});
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [settingsDraft, setSettingsDraft] = React.useState({ pipelineDir: '', wxPython: '' });
  const [keyDraft, setKeyDraft] = React.useState('');
  const [directionDraft, setDirectionDraft] = React.useState('');
  const [planMode, setPlanMode] = React.useState(null);
  const [offsetDraft, setOffsetDraft] = React.useState('');
  const [firstCodeDraft, setFirstCodeDraft] = React.useState(null);
  const settingsRef = React.useRef(null);
  const keyRef = React.useRef(null);
  const ctLabel = ct && ct.label;
  React.useEffect(() => { setDirectionDraft((ct && ct.direction) || ''); setLabelDraft(ctLabel || ''); }, [ctLabel]);

  const apply = React.useCallback((res, key) => {
    if (res && res.data) setCt(res.data);
    setErrors((prev) => ({ ...prev, [key]: res && res.ok === false ? res.error : null }));
    return res;
  }, []);

  // Initial state + live updates from main.
  React.useEffect(() => {
    if (!api) return undefined;
    api.getState().then((res) => {
      if (res?.data) {
        setCt(res.data);
        setLabelDraft(res.data.label || '');
        setSettingsDraft({ pipelineDir: res.data.settings.pipelineDir, wxPython: res.data.settings.wxPython, packFolder: res.data.settings.packFolder });
      }
    });
    if (api.checkSetup) api.checkSetup();
    return api.onUpdate((data) => setCt(data));
  }, []);

  function loadTimelines() {
    window.leaderpassAPI.call('list_timelines')
      .then((res) => setTimelines((res?.data?.timelines || []).map((t) => t.name).filter((n) => n && !n.startsWith('__SPIKE_') && !n.startsWith('Cut-through temp'))))
      .catch(() => setTimelines([]));
  }

  // another project (or multicam) has its own angle roles: drop this page's unsaved edits
  const roleKey = `${ct?.project || ''}|${ct?.mc || ''}`;
  React.useEffect(() => { setRolesDraft({}); }, [roleKey]);

  // Multicams + bins whenever Resolve (re)connects.
  React.useEffect(() => {
    if (!api || !connected) return;
    api.listMulticams().then((res) => apply(res, 'multicams'));
    window.leaderpassAPI.call('list_media_bins')
      .then((res) => setBins(Array.isArray(res?.data?.bins) ? res.data.bins : []))
      .catch(() => setBins([]));
    loadTimelines();
  }, [connected]);

  // The build adds timelines after connect, so reload when a build finishes.
  const buildFinished = ct && ct.steps && ct.steps.build && ct.steps.build.finishedAt;
  React.useEffect(() => { if (connected && buildFinished) loadTimelines(); }, [buildFinished]);

  const showVideos = ct && ctPlanMode(planMode, ct.videos) === 'videos';
  React.useEffect(() => {
    if (showVideos && api && api.listLposProjects && !(ct.lposProjects || []).length && !ct.lposLoading) api.listLposProjects().then((res) => apply(res, 'lpos'));
  }, [showVideos]);

  React.useEffect(() => { setFirstCodeDraft(null); }, [ct && ct.project, ct && ct.label]);

  const ticking = ct && (ct.busy || (ct.setup && ct.setup.installing && ct.setup.installing.phase));
  React.useEffect(() => {
    if (!ticking) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [Boolean(ticking)]);

  if (!api) return <div className="notice error">Cut-through needs a newer EditPanel build.</div>;
  if (!ct) return <div className="hint">Loading…</div>;

  // ── state the page is built from ──────────────────────────────────────────
  const steps = ct.steps;
  const day = steps.prep.data;
  const runFolder = ct.settings.runFolder;
  const stepRunning = Boolean(ct.busy);
  const needsFolder = Boolean(ct.project) && !runFolder;
  const busy = stepRunning || needsFolder;   // no folder yet: everything waits for it
  const mcOptions = ct.multicams || [];
  const mcKnown = !ct.mc || mcOptions.some((m) => m.name === ct.mc);
  const dupe = mcOptions.find((m) => m.name === ct.mc && m.duplicate);
  const solo = ct.planKind === 'solo';
  const vids = ct.videos;
  const list = (vids && vids.videos) || [];
  const est = ct.estimate;
  const firstCode = firstCodeDraft !== null ? firstCodeDraft : ((vids && vids.firstCode) || '');
  const mode = ctPlanMode(planMode, vids);
  const batch = vids && vids.batch;
  const batchLive = Boolean(batch && ['in_progress', 'canceling'].includes(batch.status));
  const batchDraft = Boolean(batch && batch.status === 'draft');
  const batchToCollect = Boolean(batch && batch.status === 'ended' && !batch.collected);
  const batchWaiting = ctBatchWaiting(vids);   // a batch still points at this transcript
  const soloDefault = ['scripted', 'free', 'stage'].includes(planForm.delivery) ? planForm.delivery : 'scripted';
  const lposPick = ct.settings.lposProject;
  const delivery = solo ? (planForm.delivery === 'convo' ? 'scripted' : planForm.delivery) : (planForm.delivery === 'stage' ? 'stage' : 'convo');
  const angleNo = (a) => Number((/(\d+)\s*$/.exec(a) || [])[1] || 999);
  // Build finds angles by the names Prep saved, so they must be final (and "Camera N") before Transcribe
  const oddAngle = (a) => !/^Camera \d+$/.test(a) && !/slate/i.test(a);
  const sortedAngles = [...(day?.angles || [])].sort((x, y) => angleNo(x) - angleNo(y));
  const oddAngles = sortedAngles.filter(oddAngle);
  // what each angle is (saved per Resolve project in the main process; the draft is this page's edits)
  const roles = { ...(ct.angleRoles || {}), ...rolesDraft };
  const micAngles = solo ? [] : (day?.micAngles || []);
  // angle rules: only between angles a cut can use (not "Don't use"); mic angles are close-ups
  const usable = sortedAngles.filter((a) => roles[a] !== 'skip' || micAngles.includes(a));
  const ruleCount = (ct.angleRules || []).filter((r) => r.split('>').every((a) => usable.includes(a))).length;
  const seqBin = ct.settings.seqBin;
  const binChoices = bins.includes(seqBin) || !seqBin ? bins : [seqBin, ...bins];
  const audioChoice = day && day.audioSource === 'camera' ? (day.mics[0] || {}).angle || '' : '';
  const slateRun = ct.slateInfo && ct.slateInfo.running;
  const transcribed = steps.transcribe.status === 'done';
  const planForm_ = { roles, direction: directionDraft, delivery: soloDefault };

  // A finished step is out of date when a step it reads from finished after it.
  const RUN_TITLES = { prep: 'Prep', transcribe: 'Transcribe', plan: 'Plan', build: 'Build' };
  function staleBy(key) {
    const st = steps[key];
    if (st.status !== 'done' || !st.finishedAt) return null;
    const i = CT_RUN.indexOf(key);
    for (let k = i - 1; k >= 0; k -= 1) {
      const up = steps[CT_RUN[k]];
      if (up.status === 'done' && up.finishedAt && up.finishedAt > st.finishedAt + 1000) return RUN_TITLES[CT_RUN[k]];
    }
    return null;
  }
  const stale = { prep: null, transcribe: staleBy('transcribe'), plan: staleBy('plan'), build: staleBy('build') };
  const ok = (key) => steps[key].status === 'done' && !stale[key];

  // What stops a step from running, as the one thing it needs (shown in place of its status).
  const needs = {
    prep: !connected ? 'Needs Resolve' : !ct.mc ? 'Needs a multicam' : !ct.label ? 'Needs a label' : needsFolder ? 'Needs a run folder' : null,
    transcribe: !day ? 'Needs Prep' : oddAngles.length ? 'Rename angles to "Camera N", then Prep again'
      : batchWaiting ? 'A batch is waiting on this transcript' : null,
    videos: !transcribed ? 'Needs Transcribe' : null,
    plan: !transcribed ? 'Needs Transcribe' : mode === 'videos' && !list.length ? 'Needs videos' : !ct.planKind ? 'Needs Prep' : null,
    build: !connected ? 'Needs Resolve' : !(mode === 'videos' ? ct.videosReady : ct.planExists) ? 'Needs a plan' : null,
    review: !connected ? 'Needs Resolve' : !transcribed ? 'Needs Transcribe' : null
  };

  // The one next action on the page (its button is the only filled one).
  function nextAction() {
    if (needsFolder) return 'folder';
    if (!ct.mc || !ct.label || stepRunning) return null;
    if (!ok('prep')) return 'prep';
    if (!ok('transcribe')) return 'transcribe';
    if (mode === 'videos') {
      if (batchDraft) return 'batch-send';
      if (batchToCollect) return 'batch-collect';
      if (batchLive) return null;
      if (!list.length) return 'find';
      if (!ct.videosReady || stale.plan) return 'plan';
    } else if (!ok('plan')) return 'plan';
    if (!ok('build')) return 'build';
    return null;
  }
  const next = nextAction();
  const btn = (id, extra = '') => `btn small${id === next ? '' : ' ghost'}${extra}`;

  async function call(key, fn) {
    setErrors((prev) => ({ ...prev, [key]: null }));
    try {
      return apply(await fn(), key);
    } catch (err) {
      setErrors((prev) => ({ ...prev, [key]: err?.message || String(err) }));
      return null;
    }
  }

  async function chooseRunFolder() {
    const picked = await window.dialogAPI.pickFolder();
    if (!picked || picked.canceled) return;
    await call('folder', () => api.setRunFolder({ folder: picked.folderPath }));
  }

  function commitLabel() {
    if ((labelDraft || '') === (ct.label || '')) return;
    call('select', () => api.select({ mc: ct.mc, label: labelDraft })).then((res) => {
      if (res?.data) setLabelDraft(res.data.label || '');
    });
  }

  function openSettingsAtKey() {
    setSettingsOpen(true);
    setTimeout(() => {
      if (settingsRef.current) settingsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (keyRef.current) keyRef.current.focus();
    }, 0);
  }

  function reportLines(st) {
    return st.status === 'running' ? st.log : (st.report && st.report.length ? st.report : st.log);
  }

  // A step is open while it runs, failed, is out of date or is next; otherwise the editor's choice.
  function isOpen(key, auto) {
    return unfolded[key] !== undefined ? unfolded[key] : auto;
  }
  const toggle = (key, cur) => () => setUnfolded({ ...unfolded, [key]: !cur });

  /** Report + Open file in a step's ⋯ menu, and the report itself when shown (always when it failed). */
  function reportBits(key, st) {
    const lines = reportLines(st);
    const has = lines && lines.length > 0;
    const shown = has && (st.status === 'failed' || openReports[key]);
    const items = [
      has && { label: openReports[key] ? 'Hide report' : 'Show report', onClick: () => setOpenReports({ ...openReports, [key]: !openReports[key] }) },
      st.reportFile && st.status !== 'running' && { label: 'Open report file', onClick: () => call(key, () => api.openFile(st.reportFile).then((r) => (r && r.ok === false ? r : { ok: true }))) }
    ];
    const el = shown ? <CtReport lines={lines} live={st.status === 'running'} /> : null;
    return { items, el };
  }

  function statusOf(key) {
    const st = steps[key];
    if (stale[key]) return 'stale';
    return st.status;
  }
  function statusTextOf(key) {
    if (stale[key]) return `Out of date · ${stale[key]} ran again`;
    return ctStatusText(steps[key], now);
  }
  const errs = (key, extra = []) => [steps[key] && steps[key].error, errors[key], ...extra.map((k) => errors[k])].filter(Boolean);
  const cancelBtn = (key) => (
    <button type="button" className="btn small danger" disabled={ct.cancelable === false} title={ct.cancelable === false ? 'This part can\'t be stopped' : ''}
      onClick={() => call(key, () => api.cancel())}>Cancel</button>
  );

  // ── 1 Prep ────────────────────────────────────────────────────────────────
  function renderPrep() {
    const st = steps.prep;
    const r = reportBits('prep', st);
    const running = st.status === 'running';
    const open = isOpen('prep', running || st.status === 'failed' || next === 'prep' || (day && oddAngles.length > 0) || !day);
    return (
      <CtStep key="prep" n={1} title="Prep" status={statusOf('prep')} statusText={statusTextOf('prep')}
        need={!running && st.status !== 'done' ? needs.prep : null}
        open={open} onToggle={day ? toggle('prep', open) : null}
        actions={!running && (
          <button type="button" className={btn('prep')} disabled={busy || Boolean(needs.prep)} title={needs.prep || ''}
            onClick={() => call('prep', () => api.runPrep({ audioAngle: audioChoice }))}>{st.status === 'pending' ? 'Prep' : 'Prep again'}</button>
        )}
        menu={r.items} progress={running ? ctStepProgress(st, now) : null} errors={errs('prep')} report={r.el}>
        {day && (
          <div className="ct-grid">
            {day.multicam !== ct.mc && <CtRow label="Multicam"><span className="dim">{day.multicam}</span></CtRow>}
            {day.lengthMin != null && (
              <CtRow label="Length"><span>{day.lengthMin.toFixed(1)} min</span><span className="dim">{day.fps?.toFixed(3)} fps</span></CtRow>
            )}
            <CtRow label="Angles">
              <div className="ct-angles">
                {sortedAngles.map((a) => (
                  <div key={a} className={`ct-angle${oddAngle(a) ? ' is-odd' : ''}`}>
                    <span className="ct-angle-name">{a}</span>
                    {micAngles.includes(a) ? <span className="dim">Close-up · mic</span> : (
                      <select className="settings-input ct-select" value={roles[a] || 'other'} disabled={stepRunning} aria-label={`${a} role`}
                        onChange={(e) => setRolesDraft({ ...rolesDraft, [a]: e.target.value })}>
                        <option value="wide">Wide</option>
                        <option value="closeup">Close-up</option>
                        <option value="slider">Slider</option>
                        <option value="side">Side</option>
                        <option value="other">Other</option>
                        <option value="skip">Don't use</option>
                      </select>
                    )}
                  </div>
                ))}
              </div>
              {oddAngles.length > 0 && <div className="notice warning">Rename {oddAngles.join(', ')} to "Camera N" in Resolve, then Prep again.</div>}
            </CtRow>
            {ct.mc && sortedAngles.length > 1 && (
              <CtRow label="Angle rules">
                <span className={ruleCount ? '' : 'dim'}>{ruleCount ? `${ruleCount} cut${ruleCount === 1 ? '' : 's'} blocked` : 'None'}</span>
                <button type="button" className="btn small ghost" disabled={stepRunning} onClick={() => { setErrors((e) => ({ ...e, rules: null })); setRulesOpen(true); }}>Edit</button>
              </CtRow>
            )}
            <CtRow label="Audio">
              {(day.cameraAudioAngles.length > 0 || day.wavMics > 0) && (
                <select className="settings-input ct-audio" value={audioChoice} disabled={busy || !connected} aria-label="Audio source"
                  onChange={(e) => call('prep', () => api.runPrep({ audioAngle: e.target.value }))}>
                  {day.wavMics > 0 && <option value="">Mic WAVs</option>}
                  {day.cameraAudioAngles.map((a) => <option key={a} value={a}>{a} camera audio</option>)}
                </select>
              )}
              <div className="ct-mics">
                {day.mics.map((m, i) => (
                  <div key={i} className="ct-mic">
                    <span className="ct-mic-name" title={m.name}>{m.name}</span>
                    <span className="dim ct-mic-range">{m.fromMin.toFixed(1)}–{m.toMin.toFixed(1)} min</span>
                    <span className="dim">{m.angle}{m.camera && day.audioSource !== 'camera' ? ' · camera audio' : ''}</span>
                    {!m.found && <span className="tag danger">File missing</span>}
                  </div>
                ))}
              </div>
            </CtRow>
            {est && est.day && (
              <CtRow label="Estimate">
                <span>≈ {ctMoney(est.day.live)} live · {ctMoney(est.day.batch)} batch</span>
                {est.day.guess && <span className="tag warning" title="No conversation runs yet">Guess</span>}
                <span className="dim">{est.day.kind === 'convo' ? 'Conversation' : 'Solo'} · transcribe ≈ {est.day.transcribeMin} min{est.day.tracks > 1 ? ` (${est.day.tracks} tracks)` : ''}</span>
              </CtRow>
            )}
          </div>
        )}
      </CtStep>
    );
  }

  // ── 2 Transcribe ──────────────────────────────────────────────────────────
  function renderTranscribe() {
    const st = steps.transcribe;
    const r = reportBits('transcribe', st);
    const running = st.status === 'running';
    const eta = est && est.day && est.day.transcribeMin ? est.day.transcribeMin * 60000 : null;
    return (
      <CtStep key="transcribe" n={2} title="Transcribe" status={statusOf('transcribe')} statusText={statusTextOf('transcribe')}
        need={!running && !ok('transcribe') ? needs.transcribe : null} open={false}
        actions={running ? cancelBtn('transcribe') : (
          <button type="button" className={btn('transcribe')} disabled={busy || Boolean(needs.transcribe)} title={needs.transcribe || ''}
            onClick={() => call('transcribe', () => api.runTranscribe({ minutes }))}>{st.status === 'pending' ? 'Transcribe' : 'Transcribe again'}</button>
        )}
        menu={r.items} progress={running ? ctStepProgress(st, now, eta) : null} errors={errs('transcribe')} report={r.el} />
    );
  }

  // ── 3 Videos: what to cut — the whole day split into videos (slate), or one section ──
  function renderVideos() {
    const locked = busy || batchWaiting;
    const ticked = list.filter((v) => v.include);
    const offset = vids && vids.offset;
    const status = slateRun ? 'running' : mode === 'videos' ? (list.length ? 'done' : 'pending') : (transcribed ? 'done' : 'pending');
    const statusText = slateRun ? 'Reading the slate'
      : mode === 'videos' ? (list.length ? `${ticked.length} of ${list.length} ticked · ${ticked.reduce((t, v) => t + v.minutes, 0).toFixed(1)} min` : '')
        : planForm.useMarks && ct.marks ? `Resolve In/Out · ${ct.marks.minutes.toFixed(1)} min` : planForm.start || planForm.end ? 'One section' : 'Whole day';
    const open = isOpen('videos', transcribed || Boolean(slateRun));
    const menu = mode === 'videos' ? [
      { label: 'Refresh LPOS projects', onClick: () => call('lpos', () => api.listLposProjects()), disabled: ct.lposLoading },
      list.length > 0 && { label: 'Find again', onClick: () => call('videos', () => api.findVideos({ offsetSec: offsetDraft, firstCode })), disabled: locked || !transcribed }
    ] : null;
    let actions = null;
    if (slateRun) actions = cancelBtn('videos');
    else if (mode === 'videos' && !list.length) {
      actions = (
        <button type="button" className={btn('find')} disabled={locked || Boolean(needs.videos)} title={needs.videos || ''}
          onClick={() => call('videos', () => api.findVideos({ offsetSec: offsetDraft, firstCode }))}>Find videos</button>
      );
    }
    return (
      <CtStep key="videos" n={3} title="Videos" status={status} statusText={statusText}
        need={!transcribed ? needs.videos : null} open={open} onToggle={toggle('videos', open)}
        actions={actions} menu={menu}
        progress={slateRun ? <CtProgress text={slateRun.phase || 'Reading the slate'} startedAt={slateRun.startedAt} pct={slateRun.bar != null ? slateRun.bar : null} now={now} /> : null}
        errors={[errors.videos, errors.lpos].filter(Boolean)}>
        <div className="ct-grid">
          <CtRow label="Cut">
            <div className="ct-seg" role="radiogroup" aria-label="What to cut">
              {[['videos', 'Videos (slate)'], ['section', 'One section']].map(([k, t]) => (
                <button key={k} type="button" role="radio" aria-checked={mode === k} className={`ct-seg-btn${mode === k ? ' is-on' : ''}`}
                  disabled={busy || batchWaiting} onClick={() => setPlanMode(k)}>{t}</button>
              ))}
            </div>
          </CtRow>
          {mode === 'section' && (
            <CtRow label="Section">
              <label className="ct-check">
                <input type="checkbox" checked={planForm.useMarks} disabled={!connected || stepRunning}
                  onChange={(e) => {
                    setPlanForm({ ...planForm, useMarks: e.target.checked });
                    if (e.target.checked) call('videos', () => api.readMarks());
                  }} />
                <span>Resolve In/Out</span>
              </label>
              <input className="settings-input ct-tc" disabled={planForm.useMarks || stepRunning} aria-label="From"
                placeholder={day?.startTc || 'From'} value={planForm.useMarks ? (ct.marks?.fromTc || '') : planForm.start}
                onChange={(e) => setPlanForm({ ...planForm, start: e.target.value })} />
              <span className="dim">→</span>
              <input className="settings-input ct-tc" disabled={planForm.useMarks || stepRunning} aria-label="To"
                placeholder={day?.endTc || 'To'} value={planForm.useMarks ? (ct.marks?.toTc || '') : planForm.end}
                onChange={(e) => setPlanForm({ ...planForm, end: e.target.value })} />
            </CtRow>
          )}
          {mode === 'videos' && (
            <>
              <CtRow label="Slate">
                <select className="settings-input ct-grow-input" value={lposPick ? lposPick.id : ''} disabled={locked} aria-label="LPOS slate project"
                  onChange={(e) => {
                    const p = (ct.lposProjects || []).find((x) => x.id === e.target.value);
                    call('videos', () => api.updateSettings({ lposProject: p ? { id: p.id, name: p.name } : null }));
                  }}>
                  <option value="">{ct.lposLoading ? 'Loading…' : 'No slate (one video per recording)'}</option>
                  {lposPick && !(ct.lposProjects || []).some((p) => p.id === lposPick.id) && <option value={lposPick.id}>{lposPick.name}</option>}
                  {(ct.lposProjects || []).map((p) => <option key={p.id} value={p.id}>{p.client ? `${p.client} — ${p.name}` : p.name}</option>)}
                </select>
                {ct.lposError && <span className="tag danger">{ct.lposError}</span>}
              </CtRow>
              {lposPick && (
                <CtRow label="Offset · first code">
                  <input className="settings-input ct-num" inputMode="decimal" aria-label="Slate offset in seconds" disabled={locked}
                    placeholder={offset ? `Auto ${offset.auto} s` : 'Auto'} value={offsetDraft}
                    onChange={(e) => setOffsetDraft(e.target.value.replace(/[^\d.\-]/g, ''))} />
                  <input className="settings-input ct-num" aria-label="First J-code on this multicam" disabled={locked}
                    placeholder="First code" value={firstCode} onChange={(e) => setFirstCodeDraft(e.target.value)} />
                  {offset && <span className="dim ct-num-text">{offset.manual ? `using ${offset.used} s` : `auto ${offset.auto} s`}{vids.notes != null ? ` · ${vids.notes} J-codes` : ''}</span>}
                </CtRow>
              )}
              {day && (
                <CtRow label="Slate angle">
                  <select className="settings-input ct-select" aria-label="Slate angle" disabled={locked || Boolean(slateRun)} value={ct.slateAngle || ''}
                    onChange={(e) => call('videos', () => api.setSlateAngle(e.target.value))}>
                    <option value="">Off</option>
                    {sortedAngles.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                  {api.getSlateFrame && (
                    <button type="button" className="btn small ghost" disabled={locked || !ct.slateAngle || Boolean(slateRun)}
                      onClick={() => setBoxOpen(true)}>{ct.slateBox ? 'Code box · set' : 'Code box'}</button>
                  )}
                  {!slateRun && (
                    <button type="button" className="btn small ghost" disabled={locked || !ct.slateAngle || !transcribed}
                      onClick={() => call('videos', () => api.readSlate())}>{ct.slateInfo && (ct.slateInfo.frames || ct.slateInfo.boxMissing) ? 'Read again' : 'Read slate'}</button>
                  )}
                  {!slateRun && ct.slateInfo && ct.slateInfo.frames
                    ? <span className="dim ct-num-text">{ct.slateInfo.codes} codes · {ct.slateInfo.unreadable} unreadable{ct.slateInfo.cost ? ` · ${ctMoney(ct.slateInfo.cost)}` : ''}</span>
                    : null}
                  {!slateRun && ct.slateInfo && (ct.slateInfo.needsClaude > 0 || ct.slateInfo.boxMissing) && (
                    <>
                      <span className="tag warning">{ct.slateInfo.boxMissing ? 'Code tile not found' : `${ct.slateInfo.needsClaude} frames unread`}</span>
                      <button type="button" className="btn small ghost" disabled={locked || !ct.slateInfo.hasKey}
                        title={ct.slateInfo.hasKey ? '' : 'Add a Claude API key in Settings'}
                        onClick={() => call('videos', () => api.readSlate({ useClaude: true }))}>
                        Ask Claude{ct.slateInfo.estimate ? ` · ≈ ${ctMoney(Math.max(0.01, ct.slateInfo.estimate))}` : ''}
                      </button>
                    </>
                  )}
                </CtRow>
              )}
              {list.length > 0 && (
                <div className="ct-vtable" role="table" aria-label="Videos">
                  <div className="ct-vrow ct-vhead" role="row">
                    <span />
                    <span>Name</span>
                    <span>Start – End</span>
                    <span>Length</span>
                    <span>Type</span>
                    <span>Plan</span>
                    <span>Flags</span>
                    <span />
                  </div>
                  {list.map((v, i) => (
                    <CtVideoRow key={v.id} v={v} next={list[i + 1]} soloDefault={soloDefault} locked={locked} busy={busy}
                      estimate={batchDraft && batch.items ? batch.items[v.id] : null}
                      onPatch={(patch) => call('videos', () => api.updateVideo(v.id, patch))}
                      onRetry={() => call('plan', () => api.planVideos({ ...planForm_, ids: [v.id] }))}
                      onJoin={api.joinVideos ? () => call('videos', () => api.joinVideos([v.id, list[i + 1].id])) : null}
                      onSplit={api.splitVideo ? () => call('videos', () => api.splitVideo(v.id)) : null} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </CtStep>
    );
  }

  // ── 4 Plan: how to cut — Claude's edit (live or a half-price batch) ────────
  function renderPlan() {
    const st = steps.plan;
    const r = reportBits('plan', st);
    const running = st.status === 'running';
    const summary = st.data;
    const editing = ct.planKind && !running;
    const vsum = mode === 'videos' && list.length ? `${list.filter((v) => v.include && v.plan && v.plan.status === 'planned').length} of ${list.filter((v) => v.include).length} planned` : null;
    const open = isOpen('plan', running || st.status === 'failed' || next === 'plan' || batchWaiting || Boolean(stale.plan));
    const tickedEst = est && est.ticked;
    const formLocked = stepRunning || batchWaiting;

    let actions = null;
    if (running) actions = cancelBtn('plan');
    else if (mode === 'videos' && batchDraft) {
      actions = (
        <>
          <button type="button" className="btn small ghost" disabled={busy || ct.sending} onClick={() => call('plan', () => api.discardBatch())}>Discard</button>
          <button type="button" className={btn('batch-send')} disabled={busy || ct.sending} onClick={() => call('plan', () => api.submitBatch())}>
            {ct.sending ? 'Sending…' : `Send batch · ≈ ${ctMoney(batch.estimate)}`}
          </button>
        </>
      );
    } else if (mode === 'videos' && batchLive) {
      actions = (
        <button type="button" className="btn small danger" disabled={batch.status === 'canceling'} onClick={() => call('plan', () => api.cancelBatch())}>Cancel batch</button>
      );
    } else if (mode === 'videos' && batchToCollect) {
      actions = <button type="button" className={btn('batch-collect')} disabled={busy} onClick={() => call('plan', () => api.collectBatch())}>Collect</button>;
    } else if (mode === 'videos') {
      const dis = busy || Boolean(needs.plan);
      actions = (
        <>
          <button type="button" className="btn small ghost" disabled={dis} title={needs.plan || 'Half price, back within 24 h'}
            onClick={() => call('plan', () => api.prepareBatch(planForm_))}>Batch{tickedEst ? ` · ≈ ${ctMoney(tickedEst.batch)}` : ''}</button>
          <button type="button" className={btn('plan')} disabled={dis} title={needs.plan || ''}
            onClick={() => call('plan', () => api.planVideos(planForm_))}>{ct.videosReady ? 'Plan again' : 'Plan'}{tickedEst ? ` · ≈ ${ctMoney(tickedEst.live)}` : ''}</button>
        </>
      );
    } else if (ct.planKind) {
      actions = (
        <button type="button" className={btn('plan')} disabled={busy || Boolean(needs.plan)} title={needs.plan || ''}
          onClick={() => call('plan', () => api.runPlan({ ...planForm, delivery, roles, direction: directionDraft }))}>{ct.planExists ? 'Plan again' : 'Plan'}</button>
      );
    }
    const menu = [
      ...r.items,
      mode === 'section' && ct.planExists && { label: 'Use existing plan', onClick: () => call('plan', () => api.useExistingPlan()), disabled: busy },
      mode === 'videos' && batchLive && { label: 'Refresh batch', onClick: () => call('plan', () => api.refreshBatch()) }
    ];
    return (
      <CtStep key="plan" n={4} title="Plan" status={statusOf('plan')}
        statusText={stale.plan ? statusTextOf('plan') : batchLive ? 'Batch in the queue' : vsum || statusTextOf('plan')}
        need={!running && !ok('plan') ? needs.plan : null} open={open} onToggle={toggle('plan', open)}
        actions={actions} menu={menu} progress={running ? ctStepProgress(st, now) : null} errors={errs('plan')} report={r.el}>
        <div className="ct-grid">
          {editing && (
            <>
              <CtRow label={mode === 'videos' ? 'Solo videos' : 'Delivery'}>
                <select className="settings-input ct-select" value={mode === 'videos' ? soloDefault : delivery} disabled={formLocked} aria-label="Delivery"
                  onChange={(e) => setPlanForm({ ...planForm, delivery: e.target.value })}>
                  {(solo || mode === 'videos') && <option value="scripted">Scripted</option>}
                  {(solo || mode === 'videos') && <option value="free">Free talk</option>}
                  {!solo && mode !== 'videos' && <option value="convo">Conversation</option>}
                  <option value="stage">Stage</option>
                </select>
                <span className="dim">{ct.settings.claudeModel === 'claude-sonnet-5-5' ? 'Sonnet 5.5' : 'Opus 5.5'}</span>
              </CtRow>
              <CtRow label="Direction">
                <textarea className="settings-input ct-direction" rows={3} value={directionDraft} aria-label="Direction for Claude" disabled={formLocked}
                  onChange={(e) => setDirectionDraft(e.target.value)} />
              </CtRow>
            </>
          )}
          {batch && mode === 'videos' && (
            <CtRow label="Batch">
              {batchDraft && (
                <span>{Object.keys(batch.items || {}).length} videos · ≈ {ctMoney(batch.estimate)} <span className="dim">(live ≈ {ctMoney(batch.liveEstimate)})</span></span>
              )}
              {batchDraft && (batch.skipped || []).map((x) => <span key={x} className="tag warning">{x}</span>)}
              {batchDraft && (batch.replans || []).length > 0 && (
                <span className="tag warning" title={batch.replans.join(', ')}>{batch.replans.length} already planned</span>
              )}
              {batchLive && batch.counts && (
                <div className="ct-grow-block">
                  <CtProgress text={`Sent ${batch.submittedAt ? ctWhen(batch.submittedAt) : ''}`} startedAt={null} now={now}
                    pct={Math.round(((batch.counts.succeeded + batch.counts.errored + batch.counts.canceled + batch.counts.expired) / Math.max(1, Object.keys(batch.items || {}).length)) * 100)} />
                </div>
              )}
              {!batchDraft && !batchLive && (
                <span className="dim">{batch.collected ? 'Collected' : 'Ended'}{batch.spent != null ? ` · ${ctMoney(batch.spent)}` : ''}</span>
              )}
              {batch.collectError && <span className="tag danger">{batch.collectError}</span>}
            </CtRow>
          )}
          {mode === 'videos' && est && est.spent ? (
            <CtRow label="Spent"><span className="dim">{ctMoney(est.spent.usd)} on {est.spent.videos} planned</span></CtRow>
          ) : null}
          {summary && summary.pieces !== undefined && mode === 'section' && (
            <CtRow label="Result">
              <span>{summary.pieces} pieces · {summary.removals} removals{summary.keptMin != null ? ` · ${summary.keptMin.toFixed(1)} min kept` : ''}</span>
              <span className="dim">{Object.entries(summary.angles).map(([a, n]) => `${a} × ${n}`).join(' · ')}</span>
              {ct.mc && summary.multicam && summary.multicam !== ct.mc && <span className="tag warning">Plan is for {summary.multicam}</span>}
            </CtRow>
          )}
        </div>
      </CtStep>
    );
  }

  // ── 5 Build ───────────────────────────────────────────────────────────────
  function renderBuild() {
    const st = steps.build;
    const r = reportBits('build', st);
    const running = st.status === 'running';
    const open = isOpen('build', running || st.status === 'failed' || next === 'build');
    return (
      <CtStep key="build" n={5} title="Build" status={statusOf('build')} statusText={statusTextOf('build')}
        need={!running && !ok('build') ? needs.build : null} open={open} onToggle={toggle('build', open)}
        actions={!running && (
          <button type="button" className={btn('build')} disabled={busy || Boolean(needs.build)} title={needs.build || ''}
            onClick={() => call('build', () => api.runBuild({}))}>
            {st.status === 'pending' ? 'Build' : 'Build again'}{mode === 'videos' && ct.videosReady ? ` · ${ct.videosReady}` : ''}
          </button>
        )}
        menu={r.items} progress={running ? ctStepProgress(st, now) : null} errors={errs('build')} report={r.el}>
        <div className="ct-grid">
          <CtRow label="Sequence bin">
            <select className="settings-input ct-select" value={seqBin || ''} disabled={stepRunning} aria-label="Sequence bin"
              onChange={(e) => call('build', () => api.updateSettings({ seqBin: e.target.value }))}>
              <option value="">Leave in place</option>
              {binChoices.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </CtRow>
        </div>
      </CtStep>
    );
  }

  // ── Review: Check (runs after every Build) and Compare, one timeline picker ──
  function renderReview() {
    const roughBase = ct.label && !(vids && vids.active) ? `${ct.label} rough cut` : '';
    const anyRun = ['check', 'compare', 'score'].some((k) => steps[k] && steps[k].status === 'running');
    const sub = (key, title, verb, result) => {
      const st = steps[key];
      const r = reportBits(key, st);
      const running = st.status === 'running';
      return (
        <CtStep key={key} n={null} title={title} status={st.status} statusText={ctStatusText(st, now)}
          need={!running && st.status === 'pending' ? needs.review : null} open
          actions={!running && (
            <button type="button" className="btn small ghost" disabled={busy || Boolean(needs.review)} title={needs.review || ''}
              onClick={() => call(key, () => (key === 'check' ? api.runCheck({ timeline: reviewTimeline })
                : key === 'score' ? api.runScore() : api.runCompare({ timeline: reviewTimeline })))}>
              {st.status === 'pending' ? verb : `${verb} again`}
            </button>
          )}
          menu={r.items} progress={running ? ctStepProgress(st, now) : null} errors={errs(key)} report={r.el}>
          {st.data && <div className="ct-result">{result(st.data)}</div>}
        </CtStep>
      );
    };
    return (
      <section className="ct-review">
        <div className="ct-review-head">
          <h3 className="ct-review-title">Review</h3>
          <select className="settings-input ct-grow-input" value={reviewTimeline} disabled={anyRun} aria-label="Timeline to review"
            onFocus={loadTimelines} onChange={(e) => setReviewTimeline(e.target.value)}>
            <option value="">{roughBase ? `All ${roughBase}s` : 'All rough cuts'}</option>
            {timelines.filter((t) => !roughBase || t !== roughBase).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        {sub('check', 'Check', 'Check', (d) => (
          <>
            <span className="ct-swatch red" title="Red markers">{d.red}</span>
            <span className="ct-swatch yellow" title="Yellow markers">{d.yellow}</span>
            {d.repeats ? <span className="ct-swatch purple" title="Repeats">{d.repeats}</span> : null}
            <span className="dim">{Object.entries(d.kinds || {}).map(([k, n]) => `${k} × ${n}`).join(' · ')}</span>
          </>
        ))}
        {sub('compare', 'Compare', 'Compare', (d) => (
          <span className="dim">
            {d.changed} of {d.timelines} changed · words +{d.restored} −{d.cut}
            {d.finished || d.clipped ? ` · word ends +${d.finished || 0} −${d.clipped || 0}` : ''}
          </span>
        ))}
        {steps.score && sub('score', 'Score', 'Score', (d) => (
          <span className="dim">
            {d.changes} changes · Check {d.check.caught}/{d.check.flags} · joins {d.join.caught}/{d.join.flags} · read {d.read.caught}/{d.read.flags}
          </span>
        ))}
      </section>
    );
  }

  return (
    <div className="page-stack ct-page">
      <div className="ct-head">
        <h2 className="section-title">Cut-through</h2>
        <span className="tag ct-beta">Beta</span>
        {ct.project && <span className="dim ct-project">{ct.project}</span>}
      </div>

      {batchLive && (
        <div className="ct-banner" role="status">
          Batch in the queue{batch.counts ? ` · ${batch.counts.succeeded + batch.counts.errored + batch.counts.canceled + batch.counts.expired}/${Object.keys(batch.items || {}).length}` : ''}
          {batch.submittedAt ? ` · sent ${ctWhen(batch.submittedAt)}` : ''}
        </div>
      )}

      <CtSetup ct={ct} now={now}
        onInstall={() => call('setup', () => api.installPack())}
        onCancel={() => call('setup', () => api.cancel())}
        onTest={() => call('setup', () => api.testPack())}
        onOpenSettings={openSettingsAtKey} />
      {errors.setup && <div className="notice error">{errors.setup}</div>}

      <section className="panel ct-panel">
        <div className="ct-grid">
          <CtRow label="Multicam">
            <select className="settings-input ct-grow-input" value={ct.mc || ''} disabled={stepRunning} aria-label="Multicam"
              onChange={(e) => call('select', () => api.select({ mc: e.target.value || null }))}>
              <option value="">{!connected ? 'Resolve not connected' : ct.multicamsLoading ? 'Loading…' : mcOptions.length ? 'Choose…' : 'No multicams'}</option>
              {!mcKnown && <option value={ct.mc}>{ct.mc}</option>}
              {mcOptions.map((m, i) => (
                <option key={`${m.name}-${i}`} value={m.name}>{m.bin ? `${m.name} — ${m.bin}` : m.name}</option>
              ))}
            </select>
            <button type="button" className="btn small ghost" disabled={!connected || stepRunning || ct.multicamsLoading}
              onClick={() => call('multicams', () => api.listMulticams())} aria-label="Refresh multicams">Refresh</button>
          </CtRow>
          <CtRow label="Label">
            <input className="settings-input ct-label" value={labelDraft} disabled={stepRunning} aria-label="Label"
              onChange={(e) => setLabelDraft(e.target.value)} onBlur={commitLabel}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          </CtRow>
          {ct.project && (
            <CtRow label="Run folder">
              {runFolder ? <span className="ct-path" title={runFolder}>{runFolder}</span> : <span className="tag warning">Not set</span>}
              <button type="button" className={`btn small${next === 'folder' ? '' : ' ghost'}`} disabled={stepRunning} onClick={chooseRunFolder}>{runFolder ? 'Change' : 'Choose'}</button>
            </CtRow>
          )}
        </div>
        {errors.folder && <div className="notice error">{errors.folder}</div>}
        {ct.multicamsError && <div className="notice error">{ct.multicamsError}</div>}
        {dupe && <div className="notice warning">More than one multicam is named {ct.mc}</div>}
        {errors.select && <div className="notice error">{errors.select}</div>}
        {errors.multicams && <div className="notice error">{errors.multicams}</div>}
      </section>

      {renderPrep()}
      {renderTranscribe()}
      {renderVideos()}
      {renderPlan()}
      {renderBuild()}
      {renderReview()}

      {rulesOpen && (
        <AngleRulesDialog mc={ct.mc} angles={usable} roles={roles} rules={ct.angleRules || []} busy={rulesBusy} error={errors.rules}
          onCancel={() => setRulesOpen(false)}
          onSave={(list_) => {
            setRulesBusy(true);
            call('rules', () => api.saveAngleRules({ rules: list_, roles })).then((r) => {
              setRulesBusy(false);
              if (r) setRulesOpen(false);
            });
          }} />
      )}

      {boxOpen && (
        <SlateBoxDialog api={api} angle={ct.slateAngle} onClose={(res) => { if (res) apply(res, 'videos'); setBoxOpen(false); }} />
      )}

      <section className="panel ct-step ct-settings" ref={settingsRef}>
        <div className="ct-step-head">
          <button type="button" className="ct-step-titles ct-step-toggle" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}>
            <h3 className="ct-step-title">Settings</h3>
            <span className={`ct-chevron${settingsOpen ? ' is-open' : ''}`} aria-hidden="true">›</span>
          </button>
        </div>
        {settingsOpen && (
          <div className="ct-grid">
            <CtRow label="Claude model">
              <select className="settings-input ct-select" value={ct.settings.claudeModel} disabled={stepRunning}
                onChange={(e) => call('settings', () => api.updateSettings({ claudeModel: e.target.value }))}>
                <option value="claude-opus-5-5">Opus 5.5</option>
                <option value="claude-sonnet-5-5">Sonnet 5.5</option>
              </select>
            </CtRow>
            <CtRow label="Claude API key">
              <input ref={keyRef} className="settings-input ct-grow-input" type="password" autoComplete="off" value={keyDraft}
                placeholder={ct.settings.claudeKey || 'Not set'}
                onChange={(e) => setKeyDraft(e.target.value)}
                onBlur={() => {
                  if (!keyDraft.trim()) return;
                  call('settings', () => api.updateSettings({ anthropicKey: keyDraft.trim() })).then(() => setKeyDraft(''));
                }} />
            </CtRow>
            <CtRow label="Energy hints">
              <input type="checkbox" checked={ct.settings.energyHints !== false} disabled={stepRunning} aria-label="Energy hints"
                onChange={(e) => call('settings', () => api.updateSettings({ energyHints: e.target.checked }))} />
            </CtRow>
            <CtRow label="Slider motion">
              <input type="checkbox" checked={ct.settings.sliderMotion !== false} disabled={stepRunning} aria-label="Slider motion"
                onChange={(e) => call('settings', () => api.updateSettings({ sliderMotion: e.target.checked }))} />
            </CtRow>
            <CtRow label="Transcription pack">
              <span className="dim">{ct.settings.pack ? ct.settings.pack.version : 'Not installed'}</span>
              {ct.settings.pack && (
                <button type="button" className="btn small ghost" disabled={Boolean(ct.setup && (ct.setup.installing || (ct.setup.test && ct.setup.test.running)))}
                  onClick={() => call('settings', () => api.testPack())}>{ct.setup && ct.setup.test && ct.setup.test.running ? 'Testing…' : 'Test'}</button>
              )}
              {ct.setup && ct.setup.test && ct.setup.test.ok && <span className="tag success">OK</span>}
            </CtRow>
            <CtRow label="">
              <button type="button" className="ct-link" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(!advancedOpen)}>
                {advancedOpen ? 'Hide advanced' : 'Advanced'}
              </button>
            </CtRow>
            {advancedOpen && (
              <>
                <CtRow label="Transcribe minutes">
                  <input className="settings-input ct-num" inputMode="numeric" placeholder="All" value={minutes} aria-label="Transcribe only the first minutes"
                    onChange={(e) => setMinutes(e.target.value.replace(/[^\d.]/g, ''))} />
                </CtRow>
                <CtRow label="Cut-through folder">
                  <input className="settings-input ct-grow-input" value={settingsDraft.pipelineDir} disabled={stepRunning}
                    onChange={(e) => setSettingsDraft({ ...settingsDraft, pipelineDir: e.target.value })}
                    onBlur={() => call('settings', () => api.updateSettings({ pipelineDir: settingsDraft.pipelineDir }))} />
                </CtRow>
                <CtRow label="Pack folder">
                  <input className="settings-input ct-grow-input" value={settingsDraft.packFolder || ''}
                    onChange={(e) => setSettingsDraft({ ...settingsDraft, packFolder: e.target.value })}
                    onBlur={() => call('settings', () => api.updateSettings({ packFolder: settingsDraft.packFolder }).then((r) => { api.checkSetup(); return r; }))} />
                </CtRow>
                <CtRow label="Whisper Python">
                  <input className="settings-input ct-grow-input" value={settingsDraft.wxPython} disabled={stepRunning}
                    onChange={(e) => setSettingsDraft({ ...settingsDraft, wxPython: e.target.value })}
                    onBlur={() => call('settings', () => api.updateSettings({ wxPython: settingsDraft.wxPython }))} />
                </CtRow>
              </>
            )}
          </div>
        )}
        {errors.settings && <div className="notice error">{errors.settings}</div>}
      </section>
    </div>
  );
}
