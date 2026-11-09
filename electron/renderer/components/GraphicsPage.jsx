/**
 * GraphicsPage — callouts and slides as Remotion overlays.
 *
 * Front end for electron/workers/graphics.js. Templates are edited by chat and previewed in a
 * sandboxed iframe (no access to the app); batches render to transparent ProRes in the main process.
 * Copy stays minimal: labels, empty states, errors.
 *
 * Props:
 *   connected — Resolve connection (boolean)
 */
const GP_FPS = [
  { label: '23.976', value: 24000 / 1001 },
  { label: '24', value: 24 },
  { label: '25', value: 25 },
  { label: '29.97', value: 30000 / 1001 },
  { label: '30', value: 30 }
];
const GP_MAX_PREVIEW_CHAT = 40;

function gpEmptyValue(field) {
  if (field.default !== undefined) return field.default;
  return field.type === 'list' ? [] : '';
}

function gpValuesFor(template, previous) {
  const out = {};
  for (const f of (template && template.fields) || []) {
    out[f.key] = previous && previous[f.key] !== undefined ? previous[f.key] : gpEmptyValue(f);
  }
  return out;
}

/** Tab-separated rows, one column per field. A list cell uses " | " between items. */
function gpParseRows(template, text) {
  if (!template) return [];
  const fields = template.fields.filter((f) => f.type !== 'image');
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const cells = fields.length > 1 ? line.split('\t') : [line];
    const values = gpValuesFor(template, null);
    fields.forEach((f, i) => {
      const cell = (cells[i] || '').trim();
      if (f.type === 'list') values[f.key] = cell.split('|').map((x) => x.trim()).filter(Boolean);
      else values[f.key] = cell;
    });
    return { name: cells[0].trim().slice(0, 60), fields: values };
  });
}

function gpSlideRows(template, images) {
  if (!template) return [];
  const imageField = template.fields.find((f) => f.type === 'image');
  if (!imageField) return [];
  return images.map((img) => ({ name: img.name, fields: { ...gpValuesFor(template, null), [imageField.key]: img.url } }));
}

function gpMoney(usd) {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${(usd || 0).toFixed(2)}`;
}

function GpPreview({ message, onError }) {
  const ref = React.useRef(null);
  const [doc, setDoc] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    window.graphicsAPI.call('previewDoc').then((r) => {
      if (r.ok) setDoc(r.data); else setLoadError(r.error);
    });
  }, []);

  React.useEffect(() => {
    const onMessage = (e) => {
      if (!ref.current || e.source !== ref.current.contentWindow || !e.data) return;
      if (e.data.type === 'ready') setReady(true);
      if (e.data.type === 'error') onError(e.data.message);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onError]);

  React.useEffect(() => {
    if (!ready || !ref.current || !message) return undefined;
    onError(null);
    const t = setTimeout(() => ref.current.contentWindow.postMessage({ type: 'render', ...message }, '*'), 120);
    return () => clearTimeout(t);
  }, [ready, message, onError]);

  if (loadError) return <div className="notice error">{loadError}</div>;
  if (!doc) return <div className="gp-frame" />;
  return <iframe ref={ref} className="gp-frame" title="Preview" sandbox="allow-scripts" srcDoc={doc} />;
}

function GpField({ field, value, onChange, call }) {
  if (field.type === 'image') {
    return (
      <div className="gp-field">
        <span className="gp-label">{field.label}</span>
        <button type="button" className="btn small ghost" onClick={async () => {
          const res = await call('pickImage');
          if (res) onChange(res.url);
        }}>{value ? 'Change image' : 'Choose image'}</button>
      </div>
    );
  }
  if (field.type === 'list') {
    return (
      <label className="gp-field">
        <span className="gp-label">{field.label}</span>
        <textarea className="settings-input gp-area" rows={4} value={(value || []).join('\n')}
          onChange={(e) => onChange(e.target.value.split('\n'))} />
      </label>
    );
  }
  if (field.type === 'textarea') {
    return (
      <label className="gp-field">
        <span className="gp-label">{field.label}</span>
        <textarea className="settings-input gp-area" rows={3} value={value || ''} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }
  return (
    <label className="gp-field">
      <span className="gp-label">{field.label}</span>
      <input className="settings-input" value={value || ''} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function GpBrandEditor({ brand, call, onCreated }) {
  const [colors, setColors] = React.useState((brand.colors || []).join(', '));
  const [newName, setNewName] = React.useState('');
  React.useEffect(() => { setColors((brand.colors || []).join(', ')); }, [brand.id, (brand.colors || []).join(',')]);
  return (
    <div className="gp-brand-edit">
      <label className="gp-field">
        <span className="gp-label">Colors</span>
        <input className="settings-input" value={colors} onChange={(e) => setColors(e.target.value)}
          onBlur={() => call('updateBrand', { brandId: brand.id, colors: colors.split(',').map((c) => c.trim()) })} />
      </label>
      <div className="gp-chips">
        {(brand.fonts || []).map((f) => <span className="gp-chip" key={f.file}>{f.family} {f.weight}</span>)}
        {(brand.logos || []).map((l) => <span className="gp-chip" key={l.file}>{l.name}</span>)}
      </div>
      <div className="gp-row">
        <button type="button" className="btn small ghost" onClick={() => call('addBrandFiles', { brandId: brand.id, type: 'font' })}>Add fonts</button>
        <button type="button" className="btn small ghost" onClick={() => call('addBrandFiles', { brandId: brand.id, type: 'logo' })}>Add logos</button>
      </div>
      <div className="gp-row">
        <input className="settings-input gp-grow" placeholder="New brand" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button type="button" className="btn small ghost" disabled={!newName.trim()} onClick={async () => {
          const res = await call('createBrand', { name: newName });
          if (res) { setNewName(''); onCreated(res.createdId); }
        }}>Add</button>
      </div>
    </div>
  );
}

function GpBatchModal({ g, template, brandId, accent, kind, connected, call, onClose }) {
  const [text, setText] = React.useState('');
  const [slides, setSlides] = React.useState(null);
  const [durationSec, setDurationSec] = React.useState(15);
  const [fps, setFps] = React.useState(GP_FPS[0].value);
  const [outDir, setOutDir] = React.useState('');
  const [binPath, setBinPath] = React.useState('GRAPHICS');
  const [view, setView] = React.useState('rows');
  const [imported, setImported] = React.useState(null);
  const [importError, setImportError] = React.useState(null);
  const isSlide = kind === 'slide';
  const rows = React.useMemo(
    () => (isSlide ? gpSlideRows(template, (slides && slides.images) || []) : gpParseRows(template, text)),
    [isSlide, template, slides, text]
  );
  const job = g.job;
  const running = Boolean(job && job.status === 'running');
  const common = { templateId: template.id, brandId, accent, rows, fps, durationSec };
  const inputColumns = template.fields.filter((f) => f.type !== 'image').map((f) => f.label).join(' → ');
  const importFiles = async () => {
    setImportError(null);
    setImported(null);
    try {
      const res = await window.leaderpassAPI.call('import_graphics', { bin_path: binPath, files: job.outputs });
      setImported(res?.data || {});
    } catch (err) {
      setImportError(String(err?.error?.message || err?.error || err?.message || 'Import failed'));
    }
  };
  return (
    <div className="gp-modal-wrap">
      <div className="gp-modal" role="dialog" aria-modal="true" aria-label="Batch render">
        <div className="gp-modal-head">
          <h3 className="ct-step-title">Batch: {template.name}</h3>
          <button type="button" className="btn small ghost" onClick={onClose}>Close</button>
        </div>

        <div className="gp-modal-body">
          {view === 'rows' && (
            <div className="gp-col">
              {isSlide ? (
                <div className="gp-row">
                  <button type="button" className="btn small ghost" onClick={async () => {
                    const res = await call('pickSlides');
                    if (res) setSlides(res);
                  }}>Choose slide folder</button>
                  <span className="gp-dim">{slides ? slides.folder : ''}</span>
                </div>
              ) : (
                <label className="gp-field">
                  <span className="gp-label">One overlay per line{template.fields.length > 1 ? ` (tab between ${inputColumns}; " | " between list items)` : ''}</span>
                  <textarea className="settings-input gp-area gp-batch" rows={9} value={text} onChange={(e) => setText(e.target.value)} />
                </label>
              )}
              {rows.length > 0 && (
                <div className="gp-table">
                  {rows.map((r, i) => <div className="gp-table-row" key={i}><span className="gp-dim">{i + 1}</span><span>{r.name}</span></div>)}
                </div>
              )}
            </div>
          )}
          {view === 'proof' && (
            <div className="gp-proofs">
              {((job && job.kind === 'proof' && job.items) || []).map((p, i) => (
                <div className="gp-proof" key={i}>
                  {p.url ? <img src={p.url} alt={p.name} /> : <div className="notice error">{p.error}</div>}
                  <span className="gp-dim">{p.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="gp-modal-foot">
          {job && running && (
            <div className="gp-col gp-grow">
              <div className="run-progress-track"><div className="run-progress-fill" style={{ width: `${Math.round(((job.done + (job.current || 0) / 100) / Math.max(1, job.total)) * 100)}%` }} /></div>
              <span className="gp-dim">{job.done} of {job.total}</span>
            </div>
          )}
          {job && job.kind === 'render' && !running && (
            <div className="gp-col gp-grow">
              <span className="gp-dim">{job.outputs.length} rendered{job.failures.length ? ` · ${job.failures.length} failed` : ''}{job.status === 'canceled' ? ' · canceled' : ''}</span>
              {job.failures.slice(0, 3).map((f, i) => <div className="notice error" key={i}>{f.name}: {f.error}</div>)}
              {job.outputs.length > 0 && (
                <div className="gp-row">
                  <input className="settings-input gp-grow" aria-label="Resolve bin" value={binPath} onChange={(e) => setBinPath(e.target.value)} />
                  <button type="button" className="btn small" disabled={!connected} onClick={importFiles}>Import to Resolve</button>
                </div>
              )}
              {imported && <span className="gp-dim">{imported.imported ?? 0} imported{imported.failed ? ` · ${imported.failed} failed` : ''}</span>}
              {importError && <div className="notice error">{importError}</div>}
            </div>
          )}
          <div className="gp-row gp-settings-row">
            <label className="gp-inline"><span className="gp-label">Seconds</span>
              <input className="settings-input gp-num" type="number" min="1" max="600" value={durationSec} onChange={(e) => setDurationSec(e.target.value)} />
            </label>
            <label className="gp-inline"><span className="gp-label">FPS</span>
              <select className="settings-input" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                {GP_FPS.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
              </select>
            </label>
            <button type="button" className="btn small ghost" onClick={async () => {
              const res = await call('pickFolder');
              if (res) setOutDir(res);
            }}>{outDir ? 'Change folder' : 'Output folder'}</button>
            <span className="gp-dim gp-grow gp-ellipsis">{outDir}</span>
            {running
              ? <button type="button" className="btn small ghost" onClick={() => call('cancel')}>Cancel</button>
              : (
                <React.Fragment>
                  <button type="button" className="btn small ghost" disabled={!rows.length && view === 'rows'} onClick={() => {
                    if (view === 'proof') { setView('rows'); return; }
                    setView('proof');
                    call('proof', common);
                  }}>{view === 'proof' ? 'Back' : 'Proof'}</button>
                  <button type="button" className="btn small" disabled={!rows.length || !outDir} onClick={() => {
                    setImported(null);
                    setView('rows');
                    call('render', { ...common, outDir });
                  }}>Render {rows.length || ''}</button>
                </React.Fragment>
              )}
          </div>
        </div>
      </div>
    </div>
  );
}

function GraphicsPage({ connected }) {
  const api = window.graphicsAPI;
  const [g, setG] = React.useState(null);
  const [kind, setKind] = React.useState('callout');
  const [selected, setSelected] = React.useState({});
  const [brandId, setBrandId] = React.useState(null);
  const [accent, setAccent] = React.useState(null);
  const [values, setValues] = React.useState({});
  const [draft, setDraft] = React.useState('');
  const [error, setError] = React.useState(null);
  const [previewError, setPreviewError] = React.useState(null);
  const [showBrand, setShowBrand] = React.useState(false);
  const [showBatch, setShowBatch] = React.useState(false);
  const [showSettings, setShowSettings] = React.useState(false);
  const [keyDraft, setKeyDraft] = React.useState('');
  const chatEnd = React.useRef(null);

  const call = React.useCallback(async (method, args) => {
    setError(null);
    const res = await api.call(method, args);
    if (!res.ok) { setError(res.error); return null; }
    return res.data;
  }, [api]);

  React.useEffect(() => {
    call('state').then((d) => { if (d) setG(d); });
    return api.onUpdate(setG);
  }, [api, call]);

  const templates = React.useMemo(() => ((g && g.templates) || []).filter((t) => t.kind === kind), [g, kind]);
  const template = templates.find((t) => t.id === selected[kind]) || templates[0] || null;
  const brand = ((g && g.brands) || []).find((b) => b.id === brandId) || (g && g.brands[0]) || null;
  const accentNow = brand && (brand.colors || []).includes(accent) ? accent : (brand && brand.colors[0]) || null;
  const fieldKey = template ? `${template.id}:${template.fields.map((f) => f.key).join(',')}` : '';

  React.useEffect(() => {
    setValues((prev) => gpValuesFor(template, prev));
  }, [fieldKey]);

  const message = React.useMemo(() => {
    if (!template || !brand) return null;
    return {
      code: template.code,
      fields: gpValuesFor(template, values),
      brand: { ...brand.runtime, accent: accentNow },
      fps: GP_FPS[0].value,
      durationInFrames: Math.round(15 * GP_FPS[0].value)
    };
  }, [template && template.code, fieldKey, values, brand, accentNow]);

  const chat = (template && template.chat) || [];
  React.useEffect(() => {
    if (chatEnd.current) chatEnd.current.scrollIntoView({ block: 'nearest' });
  }, [chat.length]);

  if (!g) return <div className="page-stack gp-page"><div className="notice">{error || 'Loading'}</div></div>;
  if (!g.engineReady) return <div className="page-stack gp-page"><div className="notice error">The Graphics engine is missing. Run npm install on this machine.</div></div>;

  const send = async (harder) => {
    const request = draft.trim();
    if (!request || !template) return;
    setDraft('');
    await call('editTemplate', { templateId: template.id, brandId: brand.id, accent: accentNow, values: gpValuesFor(template, values), request, harder });
  };
  const newTemplate = async () => {
    const res = await call('createTemplate', { kind, fromId: template && template.id });
    if (res) setSelected((s) => ({ ...s, [kind]: res.createdId }));
  };

  return (
    <div className="page-stack gp-page">
      <div className="gp-top">
        <div className="gp-toggle" role="group" aria-label="Graphic type">
          {[['callout', 'Callouts'], ['slide', 'Slides']].map(([k, label]) => (
            <button type="button" key={k} className={kind === k ? 'is-on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>
          ))}
        </div>
        <select className="settings-input gp-grow" aria-label="Template" value={template ? template.id : ''}
          onChange={(e) => setSelected((s) => ({ ...s, [kind]: e.target.value }))}>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button type="button" className="btn small ghost" onClick={newTemplate} aria-label="New template" title="Copy to a new template">+</button>
        <button type="button" className="btn small" disabled={!template} onClick={() => setShowBatch(true)}>Batch render</button>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="gp-main">
        <div className="gp-stage">
          <GpPreview message={message} onError={setPreviewError} />
          {previewError && <div className="notice error">{previewError}</div>}
        </div>

        <section className="panel gp-side">
          {template && (
            <label className="gp-field">
              <span className="gp-label">Name</span>
              <input key={template.id + template.name} className="settings-input" defaultValue={template.name}
                onBlur={(e) => { if (e.target.value.trim() && e.target.value !== template.name) call('renameTemplate', { templateId: template.id, name: e.target.value }); }} />
            </label>
          )}
          {template && template.fields.map((f) => (
            <GpField key={f.key} field={f} value={values[f.key]} call={call}
              onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))} />
          ))}
          <label className="gp-field">
            <span className="gp-label">Brand</span>
            <select className="settings-input" value={brand ? brand.id : ''} onChange={(e) => { setBrandId(e.target.value); setAccent(null); }}>
              {g.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          {brand && (
            <div className="gp-swatches">
              {brand.colors.map((c) => (
                <button type="button" key={c} className={accentNow === c ? 'is-on' : ''} style={{ background: c }} aria-label={`Accent ${c}`} aria-pressed={accentNow === c} onClick={() => setAccent(c)} />
              ))}
              <button type="button" className="btn small ghost gp-push" aria-expanded={showBrand} onClick={() => setShowBrand(!showBrand)}>{showBrand ? 'Done' : 'Edit'}</button>
            </div>
          )}
          {brand && showBrand && <GpBrandEditor brand={brand} call={call} onCreated={setBrandId} />}
        </section>
      </div>

      <section className="panel gp-chat">
        <div className="gp-messages">
          {chat.slice(-GP_MAX_PREVIEW_CHAT).map((m, i) => (
            <div key={i} className={`gp-msg ${m.who === 'me' ? 'is-me' : ''} ${m.error ? 'is-error' : ''}`}>
              {m.text}{m.usd ? <span className="gp-cost">{gpMoney(m.usd)}</span> : null}
            </div>
          ))}
          <div ref={chatEnd} />
        </div>
        <div className="gp-row">
          <input className="settings-input gp-grow" aria-label="Describe a change" placeholder="Describe a change" value={draft} disabled={g.busyEdit}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(false); }} />
          {template && template.canUndo && <button type="button" className="btn small ghost" disabled={g.busyEdit} onClick={() => call('undo', { templateId: template.id })}>Undo</button>}
          <button type="button" className="btn small ghost" disabled={g.busyEdit || !draft.trim()} onClick={() => send(true)}>Try harder</button>
          <button type="button" className="btn small" disabled={g.busyEdit || !draft.trim()} onClick={() => send(false)}>{g.busyEdit ? 'Working' : 'Send'}</button>
        </div>
        {template && template.costUsd > 0 && <span className="gp-dim">This template: {gpMoney(template.costUsd)}</span>}
      </section>

      <section className="panel gp-settings">
        <button type="button" className="btn small ghost" aria-expanded={showSettings} onClick={() => setShowSettings(!showSettings)}>{showSettings ? 'Hide settings' : 'Settings'}</button>
        {showSettings && (
          <div className="gp-col">
            <label className="gp-field">
              <span className="gp-label">Claude API key</span>
              <input className="settings-input" type="password" autoComplete="off" value={keyDraft} placeholder={g.settings.claudeKey || 'Not set'}
                onChange={(e) => setKeyDraft(e.target.value)}
                onBlur={() => { if (keyDraft.trim()) call('updateSettings', { anthropicKey: keyDraft }).then(() => setKeyDraft('')); }} />
            </label>
            <div className="gp-field">
              <span className="gp-label">Library</span>
              <div className="gp-row">
                <span className="gp-dim gp-grow gp-ellipsis">{g.settings.libraryDir}</span>
                <button type="button" className="btn small ghost" onClick={async () => {
                  const res = await call('pickFolder');
                  if (res) call('updateSettings', { libraryDir: res });
                }}>Change</button>
              </div>
            </div>
          </div>
        )}
      </section>

      {showBatch && template && (
        <GpBatchModal g={g} template={template} brandId={brand.id} accent={accentNow} kind={kind} connected={connected} call={call} onClose={() => setShowBatch(false)} />
      )}
    </div>
  );
}
