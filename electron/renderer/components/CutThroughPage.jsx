/**
 * CutThroughPage — Cut-through (beta): a day multicam → AI rough cuts.
 *
 * Front end for electron/workers/cut_through.js, which runs the cut_through/
 * pipeline (prep → transcribe → plan → build → check). All run state lives in the
 * main process and arrives on cutThroughAPI.onUpdate, so leaving the page
 * never stops a run. Copy stays minimal: labels, empty states, errors.
 *
 * Props:
 *   connected — Resolve connection (boolean)
 */
const CT_STEPS = [
  { key: 'prep', title: 'Prep' },
  { key: 'transcribe', title: 'Transcribe' },
  { key: 'plan', title: 'Plan' },
  { key: 'build', title: 'Build' },
  { key: 'check', title: 'Check' },
  { key: 'compare', title: 'Compare' }
];

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

function ctStatusText(st, now) {
  if (!st) return '';
  switch (st.status) {
    case 'running': return `Running · ${ctDuration(now - st.startedAt)}`;
    case 'done': return st.earlier ? `Done · ${ctWhen(st.finishedAt)}` : `Done · ${ctDuration(st.finishedAt - st.startedAt)}`;
    case 'failed': return st.earlier ? `Failed · ${ctWhen(st.finishedAt)}` : `Failed · ${ctDuration(st.finishedAt - st.startedAt)}`;
    case 'canceled': return `Canceled · ${ctDuration(st.finishedAt - st.startedAt)}`;
    default: return 'Pending';
  }
}

const CT_DOT = { pending: 'is-pending', running: 'is-active', done: 'is-done', failed: 'is-error', canceled: 'is-skipped' };

const CT_DELIVERY = [['scripted', 'Scripted'], ['free', 'Free talk'], ['stage', 'Stage'], ['convo', 'Conversation']];

function ctMoney(x) {
  return Number.isFinite(x) ? `$${x < 10 ? x.toFixed(2) : x.toFixed(0)}` : '';
}

/** One video of the day: tick, name, where, type, flags, plan status. */
function CtVideoRow({ v, soloDefault, locked, busy, onPatch, onRetry, estimate }) {
  const [name, setName] = React.useState(v.name);
  React.useEffect(() => { setName(v.name); }, [v.name]);
  const delivery = v.delivery || (v.kind === 'convo' ? 'convo' : soloDefault);
  const st = (v.plan && v.plan.status) || 'none';
  return (
    <div className={`ct-video${v.include ? '' : ' is-off'}`}>
      <input type="checkbox" checked={v.include} disabled={locked} aria-label={`Include ${v.name}`}
        onChange={(e) => onPatch({ include: e.target.checked })} />
      <input className="settings-input ct-video-name" value={name} disabled={locked} aria-label="Timeline name"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => { if (name.trim() && name !== v.name) onPatch({ name }); else setName(v.name); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      <span className="dim ct-video-when">{v.fromTc} · {v.minutes.toFixed(1)} min</span>
      <select className="settings-input ct-video-type" value={delivery} disabled={locked} aria-label="Type"
        onChange={(e) => onPatch({ delivery: e.target.value })}>
        {CT_DELIVERY.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
      </select>
      <span className="ct-video-tags">
        {v.flags.map((f) => <span key={f} className="tag warning">{f}</span>)}
        {estimate && <span className="tag">≈ {ctMoney(estimate.usd)}</span>}
        {st === 'planned' && <span className="tag success">Planned{v.plan.via === 'batch' ? ' · batch' : ''}</span>}
        {st === 'queued' && <span className="tag info">In batch</span>}
        {st === 'failed' && <span className="tag danger" title={v.plan.error || ''}>Failed</span>}
        {st === 'failed' && !locked && (
          <button type="button" className="btn small ghost" disabled={busy} onClick={onRetry}>Retry</button>
        )}
      </span>
    </div>
  );
}

function CtReport({ lines, live }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines && lines.length, live]);
  if (!lines || lines.length === 0) return null;
  return <pre ref={ref} className={`ct-report${live ? ' live' : ''}`}>{lines.join('\n')}</pre>;
}

/** What a running step is doing right now: its phase + time in it, and a bar when there is one. */
function CtLive({ p, now }) {
  const pct = p.bar != null ? p.bar : p.overall;
  const text = p.phase
    ? `${p.phase}${p.phaseAt ? ` · ${ctDuration(now - p.phaseAt)}` : ''}`
    : `${p.angle} · ${p.mic}/${p.mics} · ${p.doneMin.toFixed(1)}/${p.totalMin.toFixed(1)} min`;
  return (
    <div className="ct-progress">
      <div className="ct-progress-text">
        <span>{text}</span>
        {pct != null && <span className="dim">{pct}%</span>}
      </div>
      <div className={`run-progress-track${pct == null ? ' is-indeterminate' : ''}`}>
        <div className="run-progress-fill" style={{ width: `${pct == null ? 100 : pct || 0}%` }} />
      </div>
    </div>
  );
}

/** One labelled row of a step's facts / options: label on the left, the content beside it.
 *  Top level (not inside the page) so typing in a row's input never remounts it. */
function CtRow({ label, children }) {
  return (
    <>
      <div className="ct-grid-label">{label}</div>
      <div className="ct-grid-value">{children}</div>
    </>
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
  const [bins, setBins] = React.useState([]);
  const [timelines, setTimelines] = React.useState([]);
  const [checkTimeline, setCheckTimeline] = React.useState('');
  const [compareTimeline, setCompareTimeline] = React.useState('');
  const [openReports, setOpenReports] = React.useState({});
  const [errors, setErrors] = React.useState({});
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsDraft, setSettingsDraft] = React.useState({ pipelineDir: '', wxPython: '' });
  const [keyDraft, setKeyDraft] = React.useState('');
  const [directionDraft, setDirectionDraft] = React.useState('');
  const [planMode, setPlanMode] = React.useState(null);
  const [offsetDraft, setOffsetDraft] = React.useState('');
  const [firstCodeDraft, setFirstCodeDraft] = React.useState(null);
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
        setSettingsDraft({ pipelineDir: res.data.settings.pipelineDir, wxPython: res.data.settings.wxPython });
      }
    });
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

  const showVideos = ct && (planMode || (ct.videos && ct.videos.active ? 'videos' : 'section')) === 'videos';
  React.useEffect(() => {
    if (showVideos && api && api.listLposProjects && !(ct.lposProjects || []).length && !ct.lposLoading) api.listLposProjects().then((res) => apply(res, 'lpos'));
  }, [showVideos]);

  React.useEffect(() => { setFirstCodeDraft(null); }, [ct && ct.project, ct && ct.label]);

  const running = ct && ct.busy;
  React.useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  if (!api) return <div className="notice error">Cut-through needs a newer EditPanel build.</div>;
  if (!ct) return <div className="hint">Loading…</div>;

  const steps = ct.steps;
  const day = steps.prep.data;
  const runFolder = ct.settings.runFolder;
  const stepRunning = Boolean(ct.busy);
  const needsFolder = Boolean(ct.project) && !runFolder;
  const busy = stepRunning || needsFolder;   // no folder yet: everything waits for it

  async function chooseRunFolder() {
    const picked = await window.dialogAPI.pickFolder();
    if (!picked || picked.canceled) return;
    await call('folder', () => api.setRunFolder({ folder: picked.folderPath }));
  }

  const nextKey = (CT_STEPS.find((s) => steps[s.key].status !== 'done') || {}).key;
  const btnClass = (key) => `btn small${key === nextKey ? '' : ' ghost'}`;

  async function call(key, fn) {
    setErrors((prev) => ({ ...prev, [key]: null }));
    try {
      return apply(await fn(), key);
    } catch (err) {
      setErrors((prev) => ({ ...prev, [key]: err?.message || String(err) }));
      return null;
    }
  }

  function pickMulticam(name) {
    call('select', () => api.select({ mc: name || null }));
  }

  function commitLabel() {
    if ((labelDraft || '') === (ct.label || '')) return;
    call('select', () => api.select({ mc: ct.mc, label: labelDraft })).then((res) => {
      if (res?.data) setLabelDraft(res.data.label || '');
    });
  }

  const mcOptions = ct.multicams || [];
  const mcKnown = !ct.mc || mcOptions.some((m) => m.name === ct.mc);
  const dupe = mcOptions.find((m) => m.name === ct.mc && m.duplicate);
  const solo = ct.planKind === 'solo';
  const vids = ct.videos;
  const firstCode = firstCodeDraft !== null ? firstCodeDraft : ((vids && vids.firstCode) || '');
  const mode = planMode || (vids && vids.active ? 'videos' : 'section');
  const batch = vids && vids.batch;
  const batchLive = Boolean(batch && ['in_progress', 'canceling'].includes(batch.status));
  const batchDraft = Boolean(batch && batch.status === 'draft');
  const soloDefault = ['scripted', 'free', 'stage'].includes(planForm.delivery) ? planForm.delivery : 'scripted';
  const lposPick = ct.settings.lposProject;
  const delivery = solo ? (planForm.delivery === 'convo' ? 'scripted' : planForm.delivery) : (planForm.delivery === 'stage' ? 'stage' : 'convo');
  const angleNo = (a) => Number((/(\d+)\s*$/.exec(a) || [])[1] || 999);
  const sortedAngles = [...(day?.angles || [])].sort((x, y) => angleNo(x) - angleNo(y));
  // what each angle is (saved per Resolve project in the main process; the draft is this page's edits)
  const roles = { ...(ct.angleRoles || {}), ...rolesDraft };
  const micAngles = solo ? [] : (day?.micAngles || []);
  const seqBin = ct.settings.seqBin;
  const binChoices = bins.includes(seqBin) || !seqBin ? bins : [seqBin, ...bins];

  function reportLines(st) {
    return st.status === 'running' ? st.log : (st.report && st.report.length ? st.report : st.log);
  }

  const audioChoice = day && day.audioSource === 'camera' ? (day.mics[0] || {}).angle || '' : '';

  function renderVideos() {
    const locked = busy || batchLive || batchDraft;
    const list = (vids && vids.videos) || [];
    const ticked = list.filter((v) => v.include);
    const offset = vids && vids.offset;
    return (
      <>
        <CtRow label="Slate">
          <select className="settings-input ct-grow-input" value={lposPick ? lposPick.id : ''} disabled={locked}
            onChange={(e) => {
              const p = (ct.lposProjects || []).find((x) => x.id === e.target.value);
              call('plan', () => api.updateSettings({ lposProject: p ? { id: p.id, name: p.name } : null }));
            }}>
            <option value="">{ct.lposLoading ? 'Loading…' : 'No slate (one video per recording)'}</option>
            {lposPick && !(ct.lposProjects || []).some((p) => p.id === lposPick.id) && <option value={lposPick.id}>{lposPick.name}</option>}
            {(ct.lposProjects || []).map((p) => <option key={p.id} value={p.id}>{p.client ? `${p.client} — ${p.name}` : p.name}</option>)}
          </select>
          <button type="button" className="btn small ghost" disabled={ct.lposLoading}
            onClick={() => call('lpos', () => api.listLposProjects())}>Refresh</button>
          {ct.lposError && <span className="tag danger">{ct.lposError}</span>}
        </CtRow>
        {lposPick && (
          <CtRow label="Slate offset">
            <input className="settings-input ct-num" inputMode="decimal" aria-label="Slate offset in seconds" disabled={locked}
              placeholder={offset ? String(offset.auto) : 'Auto'} value={offsetDraft}
              onChange={(e) => setOffsetDraft(e.target.value.replace(/[^\d.\-]/g, ''))} />
            <span className="dim">s</span>
            {offset && <span className="dim ct-num-text">{offset.manual ? `using ${offset.used} s` : `auto ${offset.auto} s`}{vids.notes != null ? ` · ${vids.notes} J-codes` : ''}</span>}
          </CtRow>
        )}
        {lposPick && (
          <CtRow label="First code">
            <input className="settings-input ct-num" aria-label="First J-code on this multicam" disabled={locked}
              placeholder="All" value={firstCode} onChange={(e) => setFirstCodeDraft(e.target.value)} />
          </CtRow>
        )}
        {list.length > 0 && (
          <CtRow label="Videos">
            <div className="ct-videos">
              {list.map((v) => (
                <CtVideoRow key={v.id} v={v} soloDefault={soloDefault} locked={locked} busy={busy}
                  estimate={batchDraft && batch.items ? batch.items[v.id] : null}
                  onPatch={(patch) => call('plan', () => api.updateVideo(v.id, patch))}
                  onRetry={() => call('plan', () => api.planVideos({ ids: [v.id], roles, direction: directionDraft, delivery: soloDefault }))} />
              ))}
              <div className="dim ct-num-text">{ticked.length} of {list.length} ticked · {ticked.reduce((t, v) => t + v.minutes, 0).toFixed(1)} min</div>
            </div>
          </CtRow>
        )}
        {batch && (
          <CtRow label="Batch">
            {batchDraft && (
              <span>{Object.keys(batch.items || {}).length} videos · ≈ {ctMoney(batch.estimate)} <span className="dim">(live ≈ {ctMoney(batch.liveEstimate)})</span></span>
            )}
            {batchDraft && (batch.skipped || []).map((x) => <span key={x} className="tag warning">{x}</span>)}
            {!batchDraft && (
              <span>
                {batch.status === 'ended' ? (batch.collected ? 'Collected' : 'Ended') : batch.status === 'canceling' ? 'Canceling' : 'Running'}
                {batch.counts ? ` · ${batch.counts.succeeded + batch.counts.errored + batch.counts.canceled + batch.counts.expired}/${Object.keys(batch.items || {}).length} done` : ''}
                {batch.submittedAt ? ` · sent ${ctWhen(batch.submittedAt)}` : ''}
                {batch.spent != null ? ` · ${ctMoney(batch.spent)}` : ''}
              </span>
            )}
            {batch.collectError && <span className="tag danger">{batch.collectError}</span>}
          </CtRow>
        )}
      </>
    );
  }

  function renderStepBody(key) {
    const st = steps[key];
    if (key === 'prep') {
      if (!day) return null;
      return (
        <div className="ct-grid">
          {day.multicam !== ct.mc && <CtRow label="Multicam"><span className="dim">{day.multicam}</span></CtRow>}
          {day.lengthMin != null && (
            <CtRow label="Length"><span>{day.lengthMin.toFixed(1)} min</span><span className="dim">{day.fps?.toFixed(3)} fps · {day.frames} fr</span></CtRow>
          )}
          <CtRow label="Angles">
            {day.angles.map((a) => <span key={a} className={`tag${day.micAngles.includes(a) ? ' info' : ''}`}>{a}</span>)}
          </CtRow>
          <CtRow label="Audio">
            {(day.cameraAudioAngles.length > 0 || day.wavMics > 0) && (
              <select className="settings-input ct-audio" value={audioChoice} disabled={busy || !connected}
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
                  <span className="tag info">{m.angle}</span>
                  {m.camera && day.audioSource !== 'camera' && <span className="tag">Camera audio</span>}
                  {!m.found && <span className="tag danger">File missing</span>}
                </div>
              ))}
            </div>
          </CtRow>
        </div>
      );
    }
    if (key === 'transcribe') {
      if (st.status === 'running') return null;
      return (
        <div className="ct-grid">
          <CtRow label="Minutes">
            <input className="settings-input ct-num" inputMode="numeric" placeholder="All" value={minutes}
              onChange={(e) => setMinutes(e.target.value.replace(/[^\d.]/g, ''))} />
          </CtRow>
        </div>
      );
    }
    if (key === 'plan') {
      const summary = st.data;
      const editing = ct.planKind && st.status !== 'running';
      if (!editing && !summary) return null;
      return (
        <div className="ct-grid">
          {editing && (
            <CtRow label="Plan by">
              <select className="settings-input ct-select" value={mode} disabled={busy || batchLive || batchDraft}
                onChange={(e) => setPlanMode(e.target.value)}>
                <option value="section">One section</option>
                <option value="videos">Videos</option>
              </select>
            </CtRow>
          )}
          {editing && mode === 'videos' && renderVideos()}
          {editing && mode === 'section' && (
              <CtRow label="Section">
                <label className="ct-check">
                  <input type="checkbox" checked={planForm.useMarks} disabled={!connected}
                    onChange={(e) => {
                      setPlanForm({ ...planForm, useMarks: e.target.checked });
                      if (e.target.checked) call('plan', () => api.readMarks());
                    }} />
                  <span>Resolve In/Out</span>
                </label>
                <input className="settings-input ct-tc" disabled={planForm.useMarks} aria-label="From"
                  placeholder={day?.startTc || 'From'} value={planForm.useMarks ? (ct.marks?.fromTc || '') : planForm.start}
                  onChange={(e) => setPlanForm({ ...planForm, start: e.target.value })} />
                <span className="dim">→</span>
                <input className="settings-input ct-tc" disabled={planForm.useMarks} aria-label="To"
                  placeholder={day?.endTc || 'To'} value={planForm.useMarks ? (ct.marks?.toTc || '') : planForm.end}
                  onChange={(e) => setPlanForm({ ...planForm, end: e.target.value })} />
                {planForm.useMarks && ct.marks && <span className="dim ct-num-text">{ct.marks.minutes.toFixed(1)} min</span>}
              </CtRow>
          )}
          {editing && (
            <>
              <CtRow label={mode === 'videos' ? 'Solo videos' : 'Delivery'}>
                <select className="settings-input ct-select" value={mode === 'videos' ? soloDefault : delivery}
                  onChange={(e) => setPlanForm({ ...planForm, delivery: e.target.value })}>
                  {(solo || mode === 'videos') && <option value="scripted">Scripted</option>}
                  {(solo || mode === 'videos') && <option value="free">Free talk</option>}
                  {!solo && mode !== 'videos' && <option value="convo">Conversation</option>}
                  <option value="stage">Stage</option>
                </select>
              </CtRow>
              {sortedAngles.length > 0 && (
                <CtRow label="Angles">
                  {sortedAngles.map((a) => (
                    <label key={a} className="ct-pair">
                      <span>{a}</span>
                      {micAngles.includes(a) ? <span className="dim">Close-up · mic</span> : (
                        <select className="settings-input ct-select" value={roles[a] || 'other'}
                          onChange={(e) => setRolesDraft({ ...rolesDraft, [a]: e.target.value })}>
                          <option value="wide">Wide</option>
                          <option value="closeup">Close-up</option>
                          <option value="slider">Slider</option>
                          <option value="side">Side</option>
                          <option value="other">Other</option>
                          <option value="skip">Don't use</option>
                        </select>
                      )}
                    </label>
                  ))}
                </CtRow>
              )}
              <CtRow label="Direction">
                <textarea className="settings-input ct-direction" rows={3} value={directionDraft} aria-label="Direction for Claude"
                  onChange={(e) => setDirectionDraft(e.target.value)} />
              </CtRow>
            </>
          )}
          {summary && summary.pieces !== undefined && mode === 'section' && (
            <CtRow label="Result">
              <span>{summary.pieces} pieces · {summary.removals} removals{summary.keptMin != null ? ` · ${summary.keptMin.toFixed(1)} min kept` : ''}</span>
              {Object.entries(summary.angles).map(([a, n]) => <span key={a} className="tag">{a} × {n}</span>)}
              {ct.mc && summary.multicam && summary.multicam !== ct.mc && <span className="tag warning">Plan is for {summary.multicam}</span>}
            </CtRow>
          )}
        </div>
      );
    }
    if (key === 'check') {
      const d = st.data;
      if (st.status === 'running' && !d) return null;
      const roughBase = ct.label && !(vids && vids.active) ? `${ct.label} rough cut` : '';
      return (
        <div className="ct-grid">
          {st.status !== 'running' && (
            <CtRow label="Timeline">
              <select className="settings-input ct-grow-input" value={checkTimeline} onFocus={loadTimelines} onChange={(e) => setCheckTimeline(e.target.value)}>
                <option value="">{roughBase ? `All ${roughBase}s` : 'All rough cuts'}</option>
                {timelines.filter((t) => !roughBase || t !== roughBase).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </CtRow>
          )}
          {d && (
            <CtRow label="Result">
              <span className={d.red ? 'tag warning' : 'tag'}>{d.red} red</span>
              <span className="tag">{d.yellow} yellow</span>
              {d.repeats ? <span className="tag">{d.repeats} repeat</span> : null}
              {Object.entries(d.kinds || {}).map(([k, n]) => <span key={k} className="tag">{k} × {n}</span>)}
            </CtRow>
          )}
        </div>
      );
    }
    if (key === 'compare') {
      const d = st.data;
      if (st.status === 'running' && !d) return null;
      const roughBase = ct.label && !(vids && vids.active) ? `${ct.label} rough cut` : '';
      return (
        <div className="ct-grid">
          {st.status !== 'running' && (
            <CtRow label="Timeline">
              <select className="settings-input ct-grow-input" value={compareTimeline} onFocus={loadTimelines} onChange={(e) => setCompareTimeline(e.target.value)}>
                <option value="">{roughBase ? `All ${roughBase}s` : 'All rough cuts'}</option>
                {timelines.filter((t) => !roughBase || t !== roughBase).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </CtRow>
          )}
          {d && (
            <CtRow label="Result">
              <span className="tag">{d.changed} of {d.timelines} changed</span>
              <span className="tag">Words +{d.restored} −{d.cut}</span>
            </CtRow>
          )}
        </div>
      );
    }
    if (key === 'build') {
      if (st.status === 'running') return null;
      return (
        <div className="ct-grid">
          {vids && vids.active && <CtRow label="Videos"><span>{ct.videosReady} planned</span></CtRow>}
          <CtRow label="Sequence bin">
            <select className="settings-input ct-select" value={seqBin || ''}
              onChange={(e) => call('build', () => api.updateSettings({ seqBin: e.target.value }))}>
              <option value="">Leave in place</option>
              {binChoices.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </CtRow>
        </div>
      );
    }
    return null;
  }

  function renderActions(key) {
    const st = steps[key];
    if (st.status === 'running' && key !== 'transcribe') return null;   // only Transcribe can be canceled
    if (key === 'prep') {
      return (
        <button type="button" className={btnClass(key)} disabled={busy || !connected || !ct.mc || !ct.label}
          onClick={() => call(key, () => api.runPrep({ audioAngle: audioChoice }))}>{st.status === 'pending' ? 'Run' : 'Run again'}</button>
      );
    }
    if (key === 'transcribe') {
      if (st.status === 'running') {
        return <button type="button" className="btn small danger" onClick={() => call(key, () => api.cancel())}>Cancel</button>;
      }
      return (
        <button type="button" className={btnClass(key)} disabled={busy || !day}
          onClick={() => call(key, () => api.runTranscribe({ minutes }))}>{st.status === 'pending' ? 'Run' : 'Run again'}</button>
      );
    }
    if (key === 'plan' && mode === 'videos') {
      const hasVideos = vids && vids.videos && vids.videos.length > 0;
      const ready = steps.transcribe.status === 'done';
      const form = { roles, direction: directionDraft, delivery: soloDefault };
      if (batchDraft) {
        return (
          <>
            <button type="button" className="btn small ghost" disabled={busy} onClick={() => call(key, () => api.discardBatch())}>Discard</button>
            <button type="button" className="btn small" disabled={busy} onClick={() => call(key, () => api.submitBatch())}>Submit batch</button>
          </>
        );
      }
      if (batchLive) {
        return (
          <>
            <button type="button" className="btn small ghost" onClick={() => call(key, () => api.refreshBatch())}>Refresh</button>
            <button type="button" className="btn small danger" disabled={batch.status === 'canceling'}
              onClick={() => call(key, () => api.cancelBatch())}>Cancel batch</button>
          </>
        );
      }
      return (
        <>
          {batch && batch.status === 'ended' && !batch.collected && (
            <button type="button" className="btn small" disabled={busy} onClick={() => call(key, () => api.collectBatch())}>Collect</button>
          )}
          <button type="button" className={`btn small${hasVideos ? ' ghost' : ''}`} disabled={busy || !ready}
            onClick={() => call(key, () => api.findVideos({ offsetSec: offsetDraft, firstCode }))}>{hasVideos ? 'Find again' : 'Find videos'}</button>
          {hasVideos && (
            <button type="button" className="btn small ghost" disabled={busy || !ready}
              onClick={() => call(key, () => api.prepareBatch(form))}>Batch</button>
          )}
          {hasVideos && (
            <button type="button" className={btnClass(key)} disabled={busy || !ready}
              onClick={() => call(key, () => api.planVideos(form))}>Plan now</button>
          )}
        </>
      );
    }
    if (key === 'plan') {
      return (
        <>
          {ct.planExists && (
            <button type="button" className="btn small ghost" disabled={busy}
              onClick={() => call(key, () => api.useExistingPlan())}>Use existing</button>
          )}
          {ct.planKind && (
            <button type="button" className={btnClass(key)} disabled={busy || steps.transcribe.status !== 'done'}
              onClick={() => call(key, () => api.runPlan({ ...planForm, delivery, roles, direction: directionDraft }))}>{ct.planExists ? 'Redraft' : 'Draft'}</button>
          )}
        </>
      );
    }
    if (key === 'check') {
      return (
        <button type="button" className="btn small ghost" disabled={busy || !connected || steps.transcribe.status !== 'done'}
          onClick={() => call(key, () => api.runCheck({ timeline: checkTimeline }))}>{st.status === 'pending' ? 'Check' : 'Check again'}</button>
      );
    }
    if (key === 'compare') {
      return (
        <button type="button" className="btn small ghost" disabled={busy || !connected || steps.transcribe.status !== 'done'}
          onClick={() => call(key, () => api.runCompare({ timeline: compareTimeline }))}>{st.status === 'pending' ? 'Compare' : 'Compare again'}</button>
      );
    }
    if (key === 'build') {
      return (
        <button type="button" className={btnClass(key)} disabled={busy || !connected || !(vids && vids.active ? ct.videosReady : ct.planExists)}
          onClick={() => call(key, () => api.runBuild({}))}>{st.status === 'pending' ? 'Build' : 'Build again'}</button>
      );
    }
    return null;
  }

  return (
    <div className="page-stack ct-page">
      <div className="ct-head">
        <h2 className="section-title">Cut-through</h2>
        <span className="tag accent">Beta</span>
        {ct.project && <span className="dim ct-project">{ct.project}</span>}
      </div>

      <section className="panel ct-panel">
        <div className="ct-form-row">
          <label className="ct-inline ct-grow">
            <span className="settings-label">Multicam</span>
            <select className="settings-input" value={ct.mc || ''} disabled={busy}
              onChange={(e) => pickMulticam(e.target.value)}>
              <option value="">{!connected ? 'Resolve not connected' : ct.multicamsLoading ? 'Loading…' : mcOptions.length ? 'Choose…' : 'No multicams'}</option>
              {!mcKnown && <option value={ct.mc}>{ct.mc}</option>}
              {mcOptions.map((m, i) => (
                <option key={`${m.name}-${i}`} value={m.name}>{m.bin ? `${m.name} — ${m.bin}` : m.name}</option>
              ))}
            </select>
          </label>
          <label className="ct-inline">
            <span className="settings-label">Label</span>
            <input className="settings-input ct-label" value={labelDraft} disabled={busy}
              onChange={(e) => setLabelDraft(e.target.value)} onBlur={commitLabel}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          </label>
          <button type="button" className="btn ghost ct-refresh" disabled={!connected || busy || ct.multicamsLoading}
            onClick={() => call('multicams', () => api.listMulticams())}>Refresh</button>
        </div>
        {ct.project && (
          <div className="ct-grid">
            <CtRow label="Run folder">
              {runFolder ? <span>{runFolder}</span> : <span className="tag warning">Not set</span>}
              <button type="button" className={`btn small${runFolder ? ' ghost' : ''}`} disabled={stepRunning} onClick={chooseRunFolder}>{runFolder ? 'Change' : 'Choose'}</button>
            </CtRow>
          </div>
        )}
        {errors.folder && <div className="notice error">{errors.folder}</div>}
        {ct.multicamsError && <div className="notice error">{ct.multicamsError}</div>}
        {dupe && <div className="notice warning">More than one multicam is named {ct.mc}</div>}
        {errors.select && <div className="notice error">{errors.select}</div>}
        {errors.multicams && <div className="notice error">{errors.multicams}</div>}
      </section>

      {CT_STEPS.map((step, i) => {
        const st = steps[step.key];
        const lines = reportLines(st);
        const hasLines = lines && lines.length > 0;
        const autoReport = st.status === 'running' || st.status === 'failed';
        const showReport = hasLines && (autoReport || openReports[step.key]);
        const bodyEl = renderStepBody(step.key);
        const errs = [st.error, errors[step.key]].filter(Boolean);
        const hasBody = (st.status === 'running' && st.progress) || bodyEl || errs.length > 0 || showReport;
        return (
          <section key={step.key} className={`panel ct-step is-${st.status}`}>
            <div className="ct-step-head">
              <span className={`ct-step-badge is-${st.status}`}>{i + 1}</span>
              <div className="ct-step-titles">
                <h3 className="ct-step-title">{step.title}</h3>
                <span className="ct-step-status">{ctStatusText(st, now)}</span>
              </div>
              <div className="ct-step-actions">
                {hasLines && !autoReport && (
                  <button type="button" className={`btn small ghost${openReports[step.key] ? ' is-active' : ''}`} aria-pressed={!!openReports[step.key]}
                    onClick={() => setOpenReports({ ...openReports, [step.key]: !openReports[step.key] })}>Report</button>
                )}
                {renderActions(step.key)}
              </div>
            </div>
            {hasBody && (
              <div className="ct-step-body">
                {st.status === 'running' && st.progress && <CtLive p={st.progress} now={now} />}
                {bodyEl}
                {errs.map((e, k) => <div key={k} className="notice error">{e}</div>)}
                {showReport && (
                  <div className="ct-report-wrap">
                    <CtReport lines={lines} live={st.status === 'running'} />
                    {st.reportFile && st.status !== 'running' && (
                      <button type="button" className="btn small ghost ct-report-open"
                        onClick={() => call(step.key, () => api.openFile(st.reportFile).then((r) => (r && r.ok === false ? r : { ok: true })))}>Open file</button>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}

      <section className="panel ct-step ct-settings">
        <div className="ct-step-head">
          <h3 className="ct-step-title">Settings</h3>
          <div className="ct-step-actions">
            <button type="button" className={`btn small ghost${settingsOpen ? ' is-active' : ''}`} aria-pressed={settingsOpen}
              onClick={() => setSettingsOpen(!settingsOpen)}>{settingsOpen ? 'Hide' : 'Show'}</button>
          </div>
        </div>
        {settingsOpen && (
          <div className="ct-grid">
            <CtRow label="Claude model">
              <select className="settings-input ct-select" value={ct.settings.claudeModel}
                onChange={(e) => call('settings', () => api.updateSettings({ claudeModel: e.target.value }))}>
                <option value="claude-opus-5-5">Opus 5.5</option>
                <option value="claude-sonnet-5-5">Sonnet 5.5</option>
              </select>
            </CtRow>
            <CtRow label="Energy hints">
              <input type="checkbox" checked={ct.settings.energyHints !== false}
                onChange={(e) => call('settings', () => api.updateSettings({ energyHints: e.target.checked }))} />
            </CtRow>
            <CtRow label="Slider motion">
              <input type="checkbox" checked={ct.settings.sliderMotion !== false}
                onChange={(e) => call('settings', () => api.updateSettings({ sliderMotion: e.target.checked }))} />
            </CtRow>
            <CtRow label="Claude API key">
              <input className="settings-input ct-grow-input" type="password" autoComplete="off" value={keyDraft}
                placeholder={ct.settings.claudeKey || 'Not set'}
                onChange={(e) => setKeyDraft(e.target.value)}
                onBlur={() => {
                  if (!keyDraft.trim()) return;
                  call('settings', () => api.updateSettings({ anthropicKey: keyDraft.trim() })).then(() => setKeyDraft(''));
                }} />
            </CtRow>
            <CtRow label="Cut-through folder">
              <input className="settings-input ct-grow-input" value={settingsDraft.pipelineDir}
                onChange={(e) => setSettingsDraft({ ...settingsDraft, pipelineDir: e.target.value })}
                onBlur={() => call('settings', () => api.updateSettings({ pipelineDir: settingsDraft.pipelineDir }))} />
            </CtRow>
            <CtRow label="Whisper Python">
              <input className="settings-input ct-grow-input" value={settingsDraft.wxPython}
                onChange={(e) => setSettingsDraft({ ...settingsDraft, wxPython: e.target.value })}
                onBlur={() => call('settings', () => api.updateSettings({ wxPython: settingsDraft.wxPython }))} />
            </CtRow>
          </div>
        )}
        {errors.settings && <div className="notice error">{errors.settings}</div>}
      </section>
    </div>
  );
}
