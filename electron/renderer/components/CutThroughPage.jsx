/**
 * CutThroughPage — Cut-through (beta): a day multicam → AI rough cuts.
 *
 * Front end for electron/workers/cut_through.js, which runs the spikes/
 * pipeline (prep → transcribe → plan → build). All run state lives in the
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
  { key: 'build', title: 'Build' }
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

function CtReport({ lines, live }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines && lines.length, live]);
  if (!lines || lines.length === 0) return null;
  return <pre ref={ref} className={`ct-report${live ? ' live' : ''}`}>{lines.join('\n')}</pre>;
}

function CutThroughPage({ connected }) {
  const api = window.cutThroughAPI;
  const [ct, setCt] = React.useState(null);
  const [now, setNow] = React.useState(Date.now());
  const [labelDraft, setLabelDraft] = React.useState('');
  const [minutes, setMinutes] = React.useState('');
  const [planForm, setPlanForm] = React.useState({ start: '', end: '', extra: '', cuts: '' });
  const [bins, setBins] = React.useState([]);
  const [openReports, setOpenReports] = React.useState({});
  const [errors, setErrors] = React.useState({});
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsDraft, setSettingsDraft] = React.useState({ spikesDir: '', wxPython: '' });

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
        setSettingsDraft({ spikesDir: res.data.settings.spikesDir, wxPython: res.data.settings.wxPython });
      }
    });
    return api.onUpdate((data) => setCt(data));
  }, []);

  // Multicams + bins whenever Resolve (re)connects.
  React.useEffect(() => {
    if (!api || !connected) return;
    api.listMulticams().then((res) => apply(res, 'multicams'));
    window.leaderpassAPI.call('list_media_bins')
      .then((res) => setBins(Array.isArray(res?.data?.bins) ? res.data.bins : []))
      .catch(() => setBins([]));
  }, [connected]);

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
  const busy = Boolean(ct.busy);
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
    const label = name ? name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') : '';
    setLabelDraft(label);
    call('select', () => api.select({ mc: name || null, label }));
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
  const punchChoices = (day?.angles || []).filter((a) => a !== 'Camera 1');
  const punch = planForm.punch || (punchChoices.includes('Camera 2') ? 'Camera 2' : punchChoices[0] || '');
  const extraChoices = (day?.angles || []).filter((a) => a !== 'Camera 1' &&
    (solo ? a !== punch : !(day?.micAngles || []).includes(a)));
  const seqBin = ct.settings.seqBin;
  const binChoices = bins.includes(seqBin) || !seqBin ? bins : [seqBin, ...bins];

  function reportLines(st) {
    return st.status === 'running' ? st.log : (st.report && st.report.length ? st.report : st.log);
  }

  const audioChoice = day && day.audioSource === 'camera' ? (day.mics[0] || {}).angle || '' : '';

  function renderStepBody(key) {
    const st = steps[key];
    if (key === 'prep') {
      if (!day) return null;
      return (
        <div className="ct-facts">
          <div className="ct-fact-row">
            <span className="dim">{day.multicam}</span>
            {day.lengthMin != null && <span className="dim">{day.lengthMin.toFixed(1)} min · {day.fps?.toFixed(3)} fps · {day.frames} fr</span>}
          </div>
          <div className="ct-fact-row">
            <span className="section-label">Angles</span>
            {day.angles.map((a) => <span key={a} className={`tag${day.micAngles.includes(a) ? ' info' : ''}`}>{a}</span>)}
          </div>
          <div className="ct-fact-col">
            <div className="ct-fact-row">
              <span className="section-label">Audio</span>
              {(day.cameraAudioAngles.length > 0 || day.wavMics > 0) && (
                <select className="settings-input ct-audio" value={audioChoice} disabled={busy || !connected}
                  onChange={(e) => call('prep', () => api.runPrep({ audioAngle: e.target.value }))}>
                  {day.wavMics > 0 && <option value="">Mic WAVs</option>}
                  {day.cameraAudioAngles.map((a) => <option key={a} value={a}>{a} camera audio</option>)}
                </select>
              )}
            </div>
            {day.mics.map((m, i) => (
              <div key={i} className="ct-mic">
                <span className="ct-mic-name">{m.name}</span>
                <span className="tag info">{m.angle}</span>
                {m.camera && <span className="tag">Camera audio</span>}
                <span className="dim">{m.fromMin.toFixed(1)}–{m.toMin.toFixed(1)} min</span>
                {!m.found && <span className="tag danger">File missing</span>}
              </div>
            ))}
          </div>
        </div>
      );
    }
    if (key === 'transcribe') {
      const p = st.progress;
      return (
        <div className="ct-facts">
          {st.status !== 'running' && (
            <label className="ct-inline">
              <span className="settings-label">Minutes</span>
              <input className="settings-input ct-num" inputMode="numeric" placeholder="All" value={minutes}
                onChange={(e) => setMinutes(e.target.value.replace(/[^\d.]/g, ''))} />
            </label>
          )}
          {st.status === 'running' && p && (
            <div className="ct-progress">
              <div className="ct-progress-text">
                <span>{p.phase
                  ? `${p.phase}${p.phaseAt ? ` · ${ctDuration(now - p.phaseAt)}` : ''}`
                  : `${p.angle} · mic ${p.mic}/${p.mics} · ${p.doneMin.toFixed(1)}/${p.totalMin.toFixed(1)} min`}</span>
                <span className="dim">{p.bar != null ? p.bar : p.overall}%</span>
              </div>
              <div className="run-progress-track"><div className="run-progress-fill" style={{ width: `${(p.bar != null ? p.bar : p.overall) || 0}%` }} /></div>
            </div>
          )}
        </div>
      );
    }
    if (key === 'plan') {
      const summary = st.data;
      return (
        <div className="ct-facts">
          {ct.planKind && st.status !== 'running' && (
            <div className="ct-form-row">
              <label className="ct-inline">
                <span className="settings-label">Start</span>
                <input className="settings-input ct-num" inputMode="numeric" placeholder="0" value={planForm.start}
                  onChange={(e) => setPlanForm({ ...planForm, start: e.target.value.replace(/\D/g, '') })} />
              </label>
              <label className="ct-inline">
                <span className="settings-label">End</span>
                <input className="settings-input ct-num" inputMode="numeric" placeholder={String(day?.frames || '')} value={planForm.end}
                  onChange={(e) => setPlanForm({ ...planForm, end: e.target.value.replace(/\D/g, '') })} />
              </label>
              {solo && punchChoices.length > 0 && (
                <label className="ct-inline">
                  <span className="settings-label">Punch-in</span>
                  <select className="settings-input" value={punch} onChange={(e) => setPlanForm({ ...planForm, punch: e.target.value, extra: planForm.extra === e.target.value ? '' : planForm.extra })}>
                    {punchChoices.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </label>
              )}
              {extraChoices.length > 0 && (
                <label className="ct-inline">
                  <span className="settings-label">Extra angle</span>
                  <select className="settings-input" value={planForm.extra} onChange={(e) => setPlanForm({ ...planForm, extra: e.target.value })}>
                    <option value="">None</option>
                    {extraChoices.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </label>
              )}
              <label className="ct-inline ct-grow">
                <span className="settings-label">Cuts</span>
                <input className="settings-input" placeholder="from-to, …" value={planForm.cuts}
                  onChange={(e) => setPlanForm({ ...planForm, cuts: e.target.value })} />
              </label>
            </div>
          )}
          {summary && (
            <div className="ct-fact-row">
              <span className="dim">{summary.pieces} pieces · {summary.removals} removals{summary.keptMin != null ? ` · ${summary.keptMin.toFixed(1)} min kept` : ''}</span>
              {Object.entries(summary.angles).map(([a, n]) => <span key={a} className="tag">{a} × {n}</span>)}
            </div>
          )}
          {summary && ct.mc && summary.multicam && summary.multicam !== ct.mc && (
            <div className="notice warning">Plan is for {summary.multicam}</div>
          )}
        </div>
      );
    }
    if (key === 'build') {
      return (
        <div className="ct-facts">
          {st.status !== 'running' && (
            <label className="ct-inline">
              <span className="settings-label">Sequence bin</span>
              <select className="settings-input" value={seqBin || ''}
                onChange={(e) => call('build', () => api.updateSettings({ seqBin: e.target.value }))}>
                <option value="">Leave in place</option>
                {binChoices.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
          )}
        </div>
      );
    }
    return null;
  }

  function renderActions(key) {
    const st = steps[key];
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
    if (key === 'plan') {
      return (
        <>
          {ct.planExists && (
            <button type="button" className="btn small ghost" disabled={busy}
              onClick={() => call(key, () => api.useExistingPlan())}>Use existing</button>
          )}
          {ct.planKind && (
            <button type="button" className={btnClass(key)} disabled={busy || steps.transcribe.status !== 'done'}
              onClick={() => call(key, () => api.runPlan({ ...planForm, punch: solo ? punch : '' }))}>{ct.planExists ? 'Redraft' : 'Draft'}</button>
          )}
        </>
      );
    }
    if (key === 'build') {
      return (
        <button type="button" className={btnClass(key)} disabled={busy || !connected || !ct.planExists}
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
          <button type="button" className="btn small ghost" disabled={!connected || busy || ct.multicamsLoading}
            onClick={() => call('multicams', () => api.listMulticams())}>Refresh</button>
        </div>
        {ct.multicamsError && <div className="notice error">{ct.multicamsError}</div>}
        {dupe && <div className="notice warning">More than one multicam is named {ct.mc}</div>}
        {errors.select && <div className="notice error">{errors.select}</div>}
        {errors.multicams && <div className="notice error">{errors.multicams}</div>}
      </section>

      {CT_STEPS.map((step, i) => {
        const st = steps[step.key];
        const lines = reportLines(st);
        const showReport = st.status === 'running' || st.status === 'failed' || openReports[step.key];
        return (
          <section key={step.key} className={`panel ct-step is-${st.status}`}>
            <div className="ct-step-head">
              <span className={`status-dot ${CT_DOT[st.status] || 'is-pending'}`} />
              <span className="ct-step-num">{i + 1}</span>
              <h3 className="ct-step-title">{step.title}</h3>
              <span className="ct-step-status dim">{ctStatusText(st, now)}</span>
              <div className="ct-step-actions">
                {lines && lines.length > 0 && st.status !== 'running' && st.status !== 'failed' && (
                  <button type="button" className="btn small ghost"
                    onClick={() => setOpenReports({ ...openReports, [step.key]: !openReports[step.key] })}>
                    {openReports[step.key] ? 'Hide report' : 'Report'}
                  </button>
                )}
                {st.reportFile && st.status !== 'running' && (
                  <button type="button" className="btn small ghost"
                    onClick={() => call(step.key, () => api.openFile(st.reportFile).then((r) => (r && r.ok === false ? r : { ok: true })))}>Open report</button>
                )}
                {renderActions(step.key)}
              </div>
            </div>
            {renderStepBody(step.key)}
            {st.error && <div className="notice error">{st.error}</div>}
            {errors[step.key] && <div className="notice error">{errors[step.key]}</div>}
            {showReport && <CtReport lines={lines} live={st.status === 'running'} />}
          </section>
        );
      })}

      <section className="panel ct-panel">
        <button type="button" className="btn small ghost ct-settings-toggle" onClick={() => setSettingsOpen(!settingsOpen)}>
          {settingsOpen ? 'Hide settings' : 'Settings'}
        </button>
        {settingsOpen && (
          <div className="ct-facts">
            <label className="ct-inline ct-grow">
              <span className="settings-label">Spikes folder</span>
              <input className="settings-input" value={settingsDraft.spikesDir}
                onChange={(e) => setSettingsDraft({ ...settingsDraft, spikesDir: e.target.value })}
                onBlur={() => call('settings', () => api.updateSettings({ spikesDir: settingsDraft.spikesDir }))} />
            </label>
            <label className="ct-inline ct-grow">
              <span className="settings-label">Whisper Python</span>
              <input className="settings-input" value={settingsDraft.wxPython}
                onChange={(e) => setSettingsDraft({ ...settingsDraft, wxPython: e.target.value })}
                onBlur={() => call('settings', () => api.updateSettings({ wxPython: settingsDraft.wxPython }))} />
            </label>
            <span className="hint">Output: {ct.settings.desktopDir}</span>
            {errors.settings && <div className="notice error">{errors.settings}</div>}
          </div>
        )}
      </section>
    </div>
  );
}
