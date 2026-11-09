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
// Stands in for an image field until a real slide is chosen. Preview and test renders only.
const GP_PLACEHOLDER_SLIDE = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
<rect width="1920" height="1080" fill="#f7f3ea"/>
<rect x="140" y="130" width="980" height="74" rx="6" fill="#2b2822"/>
<rect x="140" y="236" width="190" height="14" fill="#dbaf5f"/>
<g fill="#b8afa0"><rect x="140" y="320" width="760" height="30" rx="4"/><rect x="140" y="400" width="680" height="30" rx="4"/><rect x="140" y="480" width="720" height="30" rx="4"/><rect x="140" y="560" width="540" height="30" rx="4"/></g>
<rect x="1040" y="310" width="740" height="580" rx="10" fill="#e6dfd1"/>
<g fill="#5b9bd5"><rect x="1130" y="680" width="110" height="130"/><rect x="1290" y="580" width="110" height="230"/><rect x="1450" y="470" width="110" height="340"/><rect x="1610" y="410" width="90" height="400"/></g>
<text x="140" y="960" font-family="Arial, sans-serif" font-size="34" fill="#8a8078" letter-spacing="4">PLACEHOLDER SLIDE</text>
</svg>`)}`;

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
function gpWithPlaceholders(template, values) {
  const out = { ...values };
  for (const f of (template && template.fields) || []) {
    if (f.type === 'image' && !out[f.key]) out[f.key] = GP_PLACEHOLDER_SLIDE;
  }
  return out;
}

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

function GpElapsed({ since }) {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  return <span className="gp-dim">{Math.max(0, Math.floor((now - since) / 1000))}s</span>;
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

function GpNewSet({ template, brandId, accent, kind, call, onClose }) {
  const [name, setName] = React.useState('');
  const [text, setText] = React.useState('');
  const [slides, setSlides] = React.useState(null);
  const [durationSec, setDurationSec] = React.useState(15);
  const [fps, setFps] = React.useState(GP_FPS[0].value);
  const isSlide = kind === 'slide';
  const rows = React.useMemo(
    () => (isSlide ? gpSlideRows(template, (slides && slides.images) || []) : gpParseRows(template, text)),
    [isSlide, template, slides, text]
  );
  const columns = template.fields.filter((f) => f.type !== 'image').map((f) => f.label).join(' → ');
  return (
    <div className="gp-modal-wrap">
      <div className="gp-modal" role="dialog" aria-modal="true" aria-label="New review set">
        <div className="gp-modal-head">
          <h3 className="ct-step-title">New set from {template.name}</h3>
          <button type="button" className="btn small ghost" onClick={onClose}>Close</button>
        </div>
        <div className="gp-modal-body gp-col">
          <label className="gp-field">
            <span className="gp-label">Name</span>
            <input className="settings-input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
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
              <span className="gp-label">One overlay per line{template.fields.length > 1 ? ` (tab between ${columns}; " | " between list items)` : ''}</span>
              <textarea className="settings-input gp-area gp-batch" rows={9} value={text} onChange={(e) => setText(e.target.value)} />
            </label>
          )}
          {rows.length > 0 && (
            <div className="gp-table">
              {rows.map((r, i) => <div className="gp-table-row" key={i}><span className="gp-dim">{i + 1}</span><span>{r.name}</span></div>)}
            </div>
          )}
        </div>
        <div className="gp-modal-foot">
          <div className="gp-row">
            <label className="gp-inline"><span className="gp-label">Seconds</span>
              <input className="settings-input gp-num" type="number" min="1" max="600" value={durationSec} onChange={(e) => setDurationSec(e.target.value)} />
            </label>
            <label className="gp-inline"><span className="gp-label">FPS</span>
              <select className="settings-input" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                {GP_FPS.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
              </select>
            </label>
            <span className="gp-grow" />
            <button type="button" className="btn small" disabled={!name.trim() || !rows.length} onClick={async () => {
              const res = await call('createSet', { name, templateId: template.id, brandId, accent, rows, fps, durationSec });
              if (res) onClose();
            }}>Create {rows.length || ''}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function GpTile({ row, index, active, onClick }) {
  const image = row.fieldDefs.find((f) => f.type === 'image');
  const src = image && row.values[image.key];
  return (
    <button type="button" className={`gp-tile${active ? ' is-active' : ''}`} onClick={onClick} aria-pressed={active}>
      {src ? <img src={src} alt="" /> : <span className="gp-tile-text">{row.name}</span>}
      <span className="gp-tile-foot">
        <span>{index + 1}</span>
        {row.foundationChanged && <span className="gp-tag is-warn">Check</span>}
        {row.hasOverride && <span className="gp-tag">Edited</span>}
        {row.renderState === 'current' && <span className="gp-tag is-done">Rendered</span>}
        {row.renderState === 'stale' && <span className="gp-tag is-warn">Re-render</span>}
      </span>
    </button>
  );
}

function GpReview({ g, call, template, brandId, accent, kind, connected, onBack }) {
  const set = g.activeSet;
  const [showNew, setShowNew] = React.useState(false);
  const [filter, setFilter] = React.useState('review');
  const [rowId, setRowId] = React.useState(null);
  const [draft, setDraft] = React.useState('');
  const [scope, setScope] = React.useState('slide');
  const [previewError, setPreviewError] = React.useState(null);
  const [values, setValues] = React.useState({});
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [imported, setImported] = React.useState(null);
  const [importError, setImportError] = React.useState(null);
  const chatEnd = React.useRef(null);
  const commit = React.useRef(null);

  React.useEffect(() => {
    if (!set && g.sets.length) call('openSet', { setId: g.sets[0].id });
  }, [Boolean(set), g.sets.length]);

  const rows = set ? set.rows : [];
  const needs = rows.filter((r) => r.status !== 'approved');
  const approved = rows.filter((r) => r.status === 'approved');
  const shown = filter === 'approved' ? approved : needs;
  const row = rows.find((r) => r.id === rowId) || shown[0] || rows[0] || null;
  const currentId = row ? row.id : null;
  const valuesKey = row ? JSON.stringify(row.values) : '';

  React.useEffect(() => {
    clearTimeout(commit.current);
    setValues(row ? row.values : {});
    setPreviewError(null);
  }, [currentId, valuesKey]);

  const fieldDefs = row ? row.fieldDefs : [];
  const shape = { fields: fieldDefs };
  const message = React.useMemo(() => {
    if (!set || !row || set.missingTemplate) return null;
    return {
      code: row.code || set.foundationCode,
      fields: gpWithPlaceholders(shape, gpValuesFor(shape, values)),
      brand: set.brand,
      fps: set.fps,
      durationInFrames: Math.max(1, Math.round(set.durationSec * set.fps))
    };
  }, [set && set.foundationCode, set && set.brand, set && set.fps, set && set.durationSec, row && row.code, currentId, values]);

  const chat = scope === 'all' ? ((set && set.foundationChat) || []) : ((row && row.chat) || []);
  React.useEffect(() => {
    if (chatEnd.current) chatEnd.current.scrollIntoView({ block: 'nearest' });
  }, [chat.length, g.editStatus && g.editStatus.stage]);

  const job = g.job && g.job.kind === 'render' && set && g.job.setId === set.id ? g.job : null;
  const running = Boolean(g.job && g.job.status === 'running');
  const toRender = approved.filter((r) => r.renderState !== 'current').length;
  const target = scope === 'all' ? (set && set.templateId) : currentId;
  const working = g.editStatus && g.editStatus.target === target;

  const update = (patch) => call('updateSet', { setId: set.id, ...patch });
  const changeValue = (key, v) => {
    const next = { ...values, [key]: v };
    setValues(next);
    clearTimeout(commit.current);
    commit.current = setTimeout(() => call('updateRow', { setId: set.id, rowId: row.id, values: next }), 500);
  };
  const send = async (harder) => {
    const request = draft.trim();
    if (!request || !row) return;
    setDraft('');
    const sample = gpWithPlaceholders(shape, gpValuesFor(shape, values));
    if (scope === 'all') {
      await call('editTemplate', { templateId: set.templateId, brandId: set.brandId, accent: set.accent, values: sample, request, harder, fps: set.fps, durationSec: set.durationSec });
    } else {
      await call('editSlide', { setId: set.id, rowId: row.id, request, harder });
    }
  };
  const go = (step) => {
    const list = shown.length ? shown : rows;
    const at = list.findIndex((r) => r.id === currentId);
    const next = list[Math.min(list.length - 1, Math.max(0, at + step))];
    if (next) setRowId(next.id);
  };
  const approveAndNext = async () => {
    const at = needs.findIndex((r) => r.id === currentId);
    const next = needs[at + 1] || needs[at - 1] || null;
    await call('setRowStatus', { setId: set.id, rowId: row.id, approved: true });
    if (next) setRowId(next.id); else { setFilter('approved'); setRowId(row.id); }
  };
  const importFiles = async () => {
    setImported(null);
    setImportError(null);
    try {
      const files = set.toImport;
      const res = await window.leaderpassAPI.call('import_graphics', { bin_path: set.binPath, files });
      setImported(res?.data || {});
      if (!(res?.data?.failed)) await call('markImported', { setId: set.id, files });
    } catch (err) {
      setImportError(String(err?.error?.message || err?.error || err?.message || 'Import failed'));
    }
  };

  const newSetModal = showNew && template && (
    <GpNewSet template={template} brandId={brandId} accent={accent} kind={kind} call={call} onClose={() => setShowNew(false)} />
  );
  const header = (
    <div className="gp-top">
      <button type="button" className="btn small ghost" onClick={onBack}>Design</button>
      <select className="settings-input gp-grow" aria-label="Review set" value={set ? set.id : ''} onChange={(e) => { setRowId(null); setConfirmDelete(false); call('openSet', { setId: e.target.value }); }}>
        {g.sets.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.approved}/{s.total})</option>)}
      </select>
      <button type="button" className="btn small ghost" disabled={!template} onClick={() => setShowNew(true)}>New set</button>
      {set && (confirmDelete
        ? <button type="button" className="btn small ghost" onClick={() => { setConfirmDelete(false); setRowId(null); call('deleteSet', { setId: set.id }); }}>Confirm delete</button>
        : <button type="button" className="btn small ghost" onClick={() => setConfirmDelete(true)}>Delete</button>)}
    </div>
  );

  if (!set) {
    return (
      <div className="page-stack gp-page">
        {header}
        <div className="notice">No review sets yet.</div>
        {newSetModal}
      </div>
    );
  }
  if (set.missingTemplate) {
    return <div className="page-stack gp-page">{header}<div className="notice error">This set's foundation template was deleted.</div></div>;
  }

  return (
    <div className="page-stack gp-page">
      {header}
      <div className="gp-main">
        <div className="gp-stage">
          <div className="gp-stage-frame">
            <GpPreview message={message} onError={setPreviewError} />
            {g.editStatus && <div className="gp-badge"><span className="gp-spinner" />Updating</div>}
          </div>
          {previewError && <div className="notice error">{previewError}</div>}
          {row && (
            <div className="gp-row">
              <button type="button" className="btn small ghost" onClick={() => go(-1)}>Previous</button>
              <button type="button" className="btn small ghost" onClick={() => go(1)}>Next</button>
              <span className="gp-dim gp-grow gp-ellipsis">{row.name}</span>
              {row.status === 'approved'
                ? <button type="button" className="btn small ghost" onClick={() => call('setRowStatus', { setId: set.id, rowId: row.id, approved: false })}>Send back to review</button>
                : <button type="button" className="btn small" onClick={approveAndNext}>Approve and next</button>}
            </div>
          )}
        </div>

        <section className="panel gp-side">
          <span className="gp-dim">Foundation: {set.templateName}</span>
          {row && row.foundationChanged && (
            <div className="notice warning">
              The foundation changed since this was edited.
              <div className="gp-row">
                <button type="button" className="btn small ghost" onClick={() => call('keepRow', { setId: set.id, rowId: row.id })}>Keep this version</button>
                <button type="button" className="btn small ghost" onClick={() => call('resetRow', { setId: set.id, rowId: row.id })}>Use foundation</button>
              </div>
            </div>
          )}
          {row && fieldDefs.map((f) => (
            <GpField key={f.key} field={f} value={values[f.key]} call={call} onChange={(v) => changeValue(f.key, v)} />
          ))}
          <label className="gp-field">
            <span className="gp-label">Brand</span>
            <select className="settings-input" value={set.brandId} onChange={(e) => update({ brandId: e.target.value, accent: null })}>
              {g.brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <div className="gp-swatches">
            {(set.brand.colors || []).map((c) => (
              <button type="button" key={c} className={set.accent === c ? 'is-on' : ''} style={{ background: c }} aria-label={`Accent ${c}`} aria-pressed={set.accent === c} onClick={() => update({ accent: c })} />
            ))}
          </div>
          {row && (
            <div className="gp-row">
              {row.canUndo && <button type="button" className="btn small ghost" onClick={() => call('undoRow', { setId: set.id, rowId: row.id })}>Undo</button>}
              {row.hasOverride && <button type="button" className="btn small ghost" onClick={() => call('resetRow', { setId: set.id, rowId: row.id })}>Reset to foundation</button>}
            </div>
          )}
        </section>
      </div>

      <section className="panel gp-strip-panel">
        <div className="gp-toggle" role="group" aria-label="Filter">
          <button type="button" className={filter === 'review' ? 'is-on' : ''} aria-pressed={filter === 'review'} onClick={() => { setFilter('review'); setRowId(null); }}>Needs review ({needs.length})</button>
          <button type="button" className={filter === 'approved' ? 'is-on' : ''} aria-pressed={filter === 'approved'} onClick={() => { setFilter('approved'); setRowId(null); }}>Approved ({approved.length})</button>
        </div>
        <div className="gp-strip">
          {shown.map((r) => <GpTile key={r.id} row={r} index={rows.indexOf(r)} active={r.id === currentId} onClick={() => setRowId(r.id)} />)}
          {!shown.length && <span className="gp-dim">None</span>}
        </div>
      </section>

      <section className="panel gp-chat">
        <div className="gp-messages">
          {chat.slice(-GP_MAX_PREVIEW_CHAT).map((m, i) => (
            <div key={i} className={`gp-msg ${m.who === 'me' ? 'is-me' : ''} ${m.error ? 'is-error' : ''}`}>
              {m.text}{m.usd ? <span className="gp-cost">{gpMoney(m.usd)}</span> : null}
            </div>
          ))}
          {working && (
            <React.Fragment>
              <div className="gp-msg is-me">{g.editStatus.request}</div>
              <div className="gp-msg gp-status" role="status">
                <span className="gp-spinner" /><span>{g.editStatus.stage}</span><GpElapsed since={g.editStatus.startedAt} />
              </div>
            </React.Fragment>
          )}
          <div ref={chatEnd} />
        </div>
        <div className="gp-row">
          <div className="gp-toggle gp-toggle-small" role="group" aria-label="Apply change to">
            <button type="button" className={scope === 'slide' ? 'is-on' : ''} aria-pressed={scope === 'slide'} onClick={() => setScope('slide')}>This one</button>
            <button type="button" className={scope === 'all' ? 'is-on' : ''} aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All</button>
          </div>
          <input className="settings-input gp-grow" aria-label="Describe a change" placeholder="Describe a change" value={draft} disabled={g.busyEdit}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(false); }} />
          <button type="button" className="btn small ghost" disabled={g.busyEdit || !draft.trim()} onClick={() => send(true)}>Try harder</button>
          <button type="button" className="btn small" disabled={g.busyEdit || !draft.trim()} onClick={() => send(false)}>{g.busyEdit ? 'Working' : 'Send'}</button>
        </div>
      </section>

      <section className="panel gp-render">
        {g.job && running && (
          <div className="gp-col">
            <div className="run-progress-track"><div className="run-progress-fill" style={{ width: `${Math.round(((g.job.done + (g.job.current || 0) / 100) / Math.max(1, g.job.total)) * 100)}%` }} /></div>
            <span className="gp-dim">{g.job.done} of {g.job.total}</span>
          </div>
        )}
        {job && !running && (
          <span className="gp-dim">{job.outputs.length} rendered{job.skipped ? ` · ${job.skipped} unchanged` : ''}{job.failures.length ? ` · ${job.failures.length} failed` : ''}{job.status === 'canceled' ? ' · canceled' : ''}</span>
        )}
        {job && job.failures.slice(0, 3).map((f, i) => <div className="notice error" key={i}>{f.name}: {f.error}</div>)}
        <div className="gp-row">
          <label className="gp-inline"><span className="gp-label">Seconds</span>
            <input key={set.id} className="settings-input gp-num" type="number" min="1" max="600" defaultValue={set.durationSec} onBlur={(e) => update({ durationSec: e.target.value })} />
          </label>
          <button type="button" className="btn small ghost" onClick={async () => {
            const res = await call('pickFolder');
            if (res) update({ outDir: res });
          }}>{set.outDir ? 'Change folder' : 'Output folder'}</button>
          <span className="gp-dim gp-grow gp-ellipsis">{set.outDir}</span>
          {needs.length > 0 && <span className="gp-dim">{needs.length} not approved</span>}
          {running
            ? <button type="button" className="btn small ghost" onClick={() => call('cancel')}>Cancel</button>
            : <button type="button" className="btn small" disabled={!toRender || !set.outDir} onClick={() => call('renderSet', { setId: set.id })}>{toRender ? `Render approved (${toRender})` : 'Up to date'}</button>}
        </div>
        {set.toImport.length > 0 && !running && (
          <div className="gp-row">
            <input key={`${set.id}-bin`} className="settings-input gp-grow" aria-label="Resolve bin" defaultValue={set.binPath} onBlur={(e) => update({ binPath: e.target.value })} />
            <button type="button" className="btn small" disabled={!connected} onClick={importFiles}>Import {set.toImport.length} to Resolve</button>
          </div>
        )}
        {imported && <span className="gp-dim">{imported.imported ?? 0} imported{imported.failed ? ` · ${imported.failed} failed` : ''}</span>}
        {importError && <div className="notice error">{importError}</div>}
      </section>
      {newSetModal}
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
  const [view, setView] = React.useState('design');
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
  const templateId = template ? template.id : null;

  // Hold the shown template by id: the list is alphabetical, so a rename can reorder it.
  React.useEffect(() => {
    if (templateId && selected[kind] !== templateId) setSelected((s) => ({ ...s, [kind]: templateId }));
  }, [kind, templateId, selected]);

  const lastCode = React.useRef({ id: null, code: null });
  const [justUpdated, setJustUpdated] = React.useState(false);
  React.useEffect(() => {
    if (!template) return undefined;
    const prev = lastCode.current;
    lastCode.current = { id: template.id, code: template.code };
    if (prev.id !== template.id || prev.code === template.code) return undefined;
    setJustUpdated(true);
    const t = setTimeout(() => setJustUpdated(false), 2500);
    return () => clearTimeout(t);
  }, [template && template.id, template && template.code]);

  React.useEffect(() => {
    setValues((prev) => gpValuesFor(template, prev));
  }, [fieldKey]);

  const message = React.useMemo(() => {
    if (!template || !brand) return null;
    return {
      code: template.code,
      fields: gpWithPlaceholders(template, gpValuesFor(template, values)),
      brand: { ...brand.runtime, accent: accentNow },
      fps: GP_FPS[0].value,
      durationInFrames: Math.round(15 * GP_FPS[0].value)
    };
  }, [template && template.code, fieldKey, values, brand, accentNow]);

  const chat = (template && template.chat) || [];
  React.useEffect(() => {
    if (chatEnd.current) chatEnd.current.scrollIntoView({ block: 'nearest' });
  }, [chat.length, g && g.editStatus && g.editStatus.stage]);

  if (!g) return <div className="page-stack gp-page"><div className="notice">{error || 'Loading'}</div></div>;
  if (!g.engineReady) return <div className="page-stack gp-page"><div className="notice error">The Graphics engine is missing. Run npm install on this machine.</div></div>;

  if (view === 'review') {
    return <GpReview g={g} call={call} template={template} brandId={brand && brand.id} accent={accentNow} kind={kind} connected={connected} onBack={() => setView('design')} />;
  }

  const send = async (harder) => {
    const request = draft.trim();
    if (!request || !template) return;
    setDraft('');
    await call('editTemplate', { templateId: template.id, brandId: brand.id, accent: accentNow, values: gpWithPlaceholders(template, gpValuesFor(template, values)), request, harder });
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
        <button type="button" className="btn small" disabled={!template} onClick={() => setView('review')}>Review sets</button>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="gp-main">
        <div className="gp-stage">
          <div className="gp-stage-frame">
            <GpPreview message={message} onError={setPreviewError} />
            {g.editStatus && g.editStatus.target === templateId && <div className="gp-badge"><span className="gp-spinner" />Updating</div>}
            {!g.editStatus && justUpdated && <div className="gp-badge is-done">Updated</div>}
          </div>
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
          {g.editStatus && g.editStatus.target === templateId && (
            <React.Fragment>
              <div className="gp-msg is-me">{g.editStatus.request}</div>
              <div className="gp-msg gp-status" role="status">
                <span className="gp-spinner" /><span>{g.editStatus.stage}</span><GpElapsed since={g.editStatus.startedAt} />
              </div>
            </React.Fragment>
          )}
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

    </div>
  );
}
