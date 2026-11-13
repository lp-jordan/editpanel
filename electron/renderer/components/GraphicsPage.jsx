/**
 * GraphicsPage — callouts and slides as Remotion overlays.
 *
 * Front end for electron/workers/graphics.js. Design works on one loaded slide or callout at a time;
 * Library holds every item as Editing, In review or Queue, per Resolve project. Previews run in a
 * sandboxed iframe (no access to the app); the queue renders to transparent ProRes in the main process.
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

function gpWithPlaceholders(template, values) {
  const out = { ...values };
  for (const f of (template && template.fields) || []) {
    if (f.type === 'image' && !out[f.key]) out[f.key] = GP_PLACEHOLDER_SLIDE;
  }
  return out;
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

const GP_W = 1920;
const GP_H = 1080;
const GP_MIN_BOX = 60;
const GP_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Moves and resizes a box from where it was when the drag started. Canvas pixels, kept on the canvas. */
function gpDragBox(b, mode, dx, dy) {
  let left = b.x;
  let top = b.y;
  let right = b.x + b.w;
  let bottom = b.y + b.h;
  if (mode === 'move') {
    const x = Math.min(Math.max(0, left + dx), GP_W - b.w);
    const y = Math.min(Math.max(0, top + dy), GP_H - b.h);
    return { x: Math.round(x), y: Math.round(y), w: b.w, h: b.h };
  }
  if (mode.includes('w')) left = Math.min(Math.max(0, left + dx), right - GP_MIN_BOX);
  if (mode.includes('e')) right = Math.max(Math.min(GP_W, right + dx), left + GP_MIN_BOX);
  if (mode.includes('n')) top = Math.min(Math.max(0, top + dy), bottom - GP_MIN_BOX);
  if (mode.includes('s')) bottom = Math.max(Math.min(GP_H, bottom + dy), top + GP_MIN_BOX);
  return { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
}

const GP_SNAP_PX = 8;            // screen pixels
const GP_SAFE = 96;
const GP_WIRE_REQUEST = 'Position every element inside its box from fields.layout (absolute left, top, width and height from the box) and fit its text to the box. Keep the look otherwise.';

/** Pulls a box's moving edges (or, when moving, its edges and centre) onto the nearest line within reach. */
function gpSnapBox(b, mode, others, reach) {
  const xs = [0, GP_SAFE, GP_W / 2, GP_W - GP_SAFE, GP_W];
  const ys = [0, GP_SAFE, GP_H / 2, GP_H - GP_SAFE, GP_H];
  for (const o of others) { xs.push(o.x, o.x + o.w / 2, o.x + o.w); ys.push(o.y, o.y + o.h / 2, o.y + o.h); }
  const nearest = (values, targets) => {
    let best = null;
    for (const v of values) for (const t of targets) {
      const d = t - v.at;
      if (Math.abs(d) <= reach && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line: t, edge: v.edge };
    }
    return best;
  };
  const out = { ...b };
  const guides = [];
  const xEdges = mode === 'move' ? [{ at: b.x, edge: 'l' }, { at: b.x + b.w / 2, edge: 'c' }, { at: b.x + b.w, edge: 'r' }]
    : [...(mode.includes('w') ? [{ at: b.x, edge: 'l' }] : []), ...(mode.includes('e') ? [{ at: b.x + b.w, edge: 'r' }] : [])];
  const yEdges = mode === 'move' ? [{ at: b.y, edge: 't' }, { at: b.y + b.h / 2, edge: 'c' }, { at: b.y + b.h, edge: 'b' }]
    : [...(mode.includes('n') ? [{ at: b.y, edge: 't' }] : []), ...(mode.includes('s') ? [{ at: b.y + b.h, edge: 'b' }] : [])];
  const sx = nearest(xEdges, xs);
  if (sx) {
    if (mode === 'move') out.x += sx.d;
    else if (sx.edge === 'l' && b.w - sx.d >= GP_MIN_BOX) { out.x += sx.d; out.w -= sx.d; }
    else if (sx.edge === 'r' && b.w + sx.d >= GP_MIN_BOX) out.w += sx.d;
    guides.push({ axis: 'x', at: sx.line });
  }
  const sy = nearest(yEdges, ys);
  if (sy) {
    if (mode === 'move') out.y += sy.d;
    else if (sy.edge === 't' && b.h - sy.d >= GP_MIN_BOX) { out.y += sy.d; out.h -= sy.d; }
    else if (sy.edge === 'b' && b.h + sy.d >= GP_MIN_BOX) out.h += sy.d;
    guides.push({ axis: 'y', at: sy.line });
  }
  return { box: { x: Math.round(out.x), y: Math.round(out.y), w: Math.round(out.w), h: Math.round(out.h) }, guides };
}

/** Draggable, resizable outlines over the preview, one per element that has a layout box.
 *  Click to select; arrows nudge (Shift ×10); Alt while dragging skips snapping; Esc deselects. */
function GpBoxes({ boxes, labels, snap, onChange }) {
  const ref = React.useRef(null);
  const [scale, setScale] = React.useState(0);
  const [dragging, setDragging] = React.useState(null);
  const [selected, setSelected] = React.useState(null);
  const [guides, setGuides] = React.useState([]);
  const latest = React.useRef({ boxes, onChange });
  latest.current = { boxes, onChange };
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / GP_W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  React.useEffect(() => {
    if (!selected) return undefined;
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return;
      if (e.key === 'Escape') { setSelected(null); return; }
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      const b = latest.current.boxes[selected];
      if (!d || !b) return;
      e.preventDefault();
      latest.current.onChange(selected, gpDragBox(b, 'move', d[0], d[1]));
    };
    const onDown = (e) => { if (!(e.target.closest && e.target.closest('.gp-box'))) setSelected(null); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pointerdown', onDown); };
  }, [selected]);
  const start = (e, key, mode) => {
    if (e.button !== 0 || !scale) return;
    e.preventDefault();
    e.stopPropagation();
    const from = boxes[key];
    const others = Object.entries(boxes).filter(([k]) => k !== key && labels[k]).map(([, b]) => b);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setSelected(key);
    setDragging(key);
    const move = (ev) => {
      const raw = gpDragBox(from, mode, (ev.clientX - x0) / scale, (ev.clientY - y0) / scale);
      const res = snap && !ev.altKey ? gpSnapBox(raw, mode, others, GP_SNAP_PX / scale) : { box: raw, guides: [] };
      setGuides(res.guides);
      onChange(key, res.box);
    };
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      setDragging(null);
      setGuides([]);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };
  return (
    <div className="gp-boxes" ref={ref}>
      {scale > 0 && Object.entries(boxes).filter(([key]) => labels[key]).map(([key, b]) => (
        <div key={key} className={`gp-box${dragging === key ? ' is-dragging' : ''}${selected === key ? ' is-selected' : ''}`}
          style={{ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale }}
          onPointerDown={(e) => start(e, key, 'move')}>
          <span className="gp-box-label">{labels[key]}</span>
          {GP_HANDLES.map((h) => <span key={h} className={`gp-box-handle is-${h}`} onPointerDown={(e) => start(e, key, h)} />)}
        </div>
      ))}
      {scale > 0 && guides.map((g, i) => (
        <div key={i} className={`gp-guide is-${g.axis}`} style={g.axis === 'x' ? { left: g.at * scale } : { top: g.at * scale }} />
      ))}
    </div>
  );
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

function GpFontSelect({ label, value, families, onChange }) {
  const options = value && !families.includes(value) ? [value, ...families] : families;
  return (
    <label className="gp-field">
      <span className="gp-label">{label}</span>
      <select className="settings-input" value={value || ''} onChange={(e) => onChange(e.target.value)}>
        {options.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>
    </label>
  );
}

function GpBrandEditor({ brand, call }) {
  const [systemFonts, setSystemFonts] = React.useState([]);
  React.useEffect(() => { call('systemFonts').then((list) => { if (list) setSystemFonts(list); }); }, []);
  const families = [...new Set([...(brand.fonts || []).map((f) => f.family), ...systemFonts])].sort((a, b) => a.localeCompare(b));
  const setFont = (role, family) => call('setBrandFont', { brandId: brand.id, role, family });
  return (
    <div className="gp-brand-edit">
      <GpFontSelect label="Heading font" value={brand.runtime.headingFont} families={families} onChange={(f) => setFont('heading', f)} />
      <GpFontSelect label="Body font" value={brand.runtime.bodyFont} families={families} onChange={(f) => setFont('body', f)} />
      <div className="gp-chips">
        {(brand.logos || []).map((l) => <span className="gp-chip" key={l.file}>{l.name}</span>)}
      </div>
      <div className="gp-row">
        <button type="button" className="btn small ghost" onClick={() => call('addBrandFiles', { brandId: brand.id, type: 'font' })}>Add fonts</button>
        <button type="button" className="btn small ghost" onClick={() => call('addBrandFiles', { brandId: brand.id, type: 'logo' })}>Add logos</button>
      </div>
    </div>
  );
}

function GpModal({ label, children }) {
  return (
    <div className="gp-modal-wrap">
      <div className="gp-modal gp-modal-small" role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>
  );
}

function GpBrandModal({ g, call, onClose }) {
  const ws = g.workspace;
  const brand = g.brands.find((b) => b.id === ws.ui.brandId) || g.brands[0];
  const [newColor, setNewColor] = React.useState('#ffffff');
  const saveColors = (colors) => call('updateBrand', { brandId: brand.id, colors });
  return (
    <GpModal label="Brand">
      <div className="gp-modal-head"><h3 className="ct-step-title">Brand</h3></div>
      <div className="gp-modal-body gp-col">
        {brand && (
          <div className="gp-swatches">
            {brand.colors.map((c) => (
              <button type="button" key={c} title={c} className={ws.brand.accent === c ? 'is-on' : ''} style={{ background: c }} aria-label={`Accent ${c}`} aria-pressed={ws.brand.accent === c}
                onClick={() => call('setUi', { accent: c })}
                onContextMenu={(e) => { e.preventDefault(); if (brand.colors.length > 1) saveColors(brand.colors.filter((x) => x !== c)); }} />
            ))}
            <input type="color" className="gp-color-pick" aria-label="New color" value={newColor} onChange={(e) => setNewColor(e.target.value)} />
            <button type="button" className="btn small ghost" aria-label="Add color" disabled={brand.colors.some((c) => c.toLowerCase() === newColor.toLowerCase())}
              onClick={() => saveColors([...brand.colors, newColor])}>+</button>
          </div>
        )}
        {brand && <GpBrandEditor brand={brand} call={call} />}
      </div>
      <div className="gp-modal-foot"><div className="gp-row gp-end"><button type="button" className="btn small" onClick={onClose}>Done</button></div></div>
    </GpModal>
  );
}

function GpNameModal({ title, initial, onSave, onClose }) {
  const [value, setValue] = React.useState(initial);
  return (
    <GpModal label={title}>
      <div className="gp-modal-head"><h3 className="ct-step-title">{title}</h3></div>
      <div className="gp-modal-body">
        <input className="settings-input gp-wide" aria-label="Template name" autoFocus value={value} onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) onSave(value); }} />
      </div>
      <div className="gp-modal-foot">
        <div className="gp-row gp-end">
          <button type="button" className="btn small ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn small" disabled={!value.trim()} onClick={() => onSave(value)}>Save</button>
        </div>
      </div>
    </GpModal>
  );
}

function GpChat({ chat, status, draft, setDraft, busy, onSend, canUndo, onUndo }) {
  const end = React.useRef(null);
  React.useEffect(() => {
    if (end.current) end.current.scrollIntoView({ block: 'nearest' });
  }, [chat.length, status && status.stage]);
  return (
    <section className="panel gp-chat">
      <div className="gp-messages">
        {chat.slice(-GP_MAX_PREVIEW_CHAT).map((m, i) => (
          <div key={i} className={`gp-msg ${m.who === 'me' ? 'is-me' : ''} ${m.error ? 'is-error' : ''}`}>
            {m.text}{m.usd ? <span className="gp-cost">{gpMoney(m.usd)}</span> : null}
          </div>
        ))}
        {status && (
          <React.Fragment>
            <div className="gp-msg is-me">{status.request}</div>
            <div className="gp-msg gp-status" role="status">
              <span className="gp-spinner" /><span>{status.stage}</span><GpElapsed since={status.startedAt} />
            </div>
          </React.Fragment>
        )}
        <div ref={end} />
      </div>
      <div className="gp-row">
        <input className="settings-input gp-grow" aria-label="Describe a change" placeholder="Describe a change" value={draft} disabled={busy}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onSend(false); }} />
        {canUndo && <button type="button" className="btn small ghost" disabled={busy} onClick={onUndo}>Undo</button>}
        <button type="button" className="btn small ghost" disabled={busy || !draft.trim()} onClick={() => onSend(true)}>Try harder</button>
        <button type="button" className="btn small" disabled={busy || !draft.trim()} onClick={() => onSend(false)}>{busy ? 'Working' : 'Send'}</button>
      </div>
    </section>
  );
}

function GpDesign({ g, call, previewShell }) {
  const ws = g.workspace;
  const kind = ws.ui.kind;
  const [draft, setDraft] = React.useState('');
  const [showBrand, setShowBrand] = React.useState(false);
  const [nameModal, setNameModal] = React.useState(null);
  const [values, setValues] = React.useState({});
  const commit = React.useRef(null);

  const templates = g.templates.filter((t) => t.kind === kind);
  const item = ws.items.find((it) => it.id === ws.ui.activeByKind[kind] && it.kind === kind) || null;
  const templateId = item ? item.templateId : ws.ui.templateByKind[kind];
  const template = templates.find((t) => t.id === templateId) || templates[0] || null;
  const fieldDefs = item ? item.fieldDefs : (template ? template.fields : []);
  const shape = { fields: fieldDefs };
  const valuesKey = item ? JSON.stringify(item.values) : (template ? template.id : '');
  const currentId = item ? item.id : (template ? template.id : null);

  React.useEffect(() => {
    clearTimeout(commit.current);
    setValues(item ? item.values : gpValuesFor(template, null));
  }, [currentId, valuesKey]);

  const code = item ? item.code : (template ? template.code : '');
  const message = React.useMemo(() => {
    if (!code) return null;
    return {
      code,
      fields: gpWithPlaceholders(shape, gpValuesFor(shape, values)),
      brand: ws.brand,
      fps: ws.fps,
      durationInFrames: Math.max(1, Math.round(ws.durationSec * ws.fps))
    };
  }, [code, values, ws.brand, ws.fps, ws.durationSec, fieldDefs.map((f) => f.key).join(',')]);

  const status = g.editStatus && g.editStatus.target === currentId ? g.editStatus : null;
  const chat = item ? item.chat : (template ? template.chat || [] : []);
  const needsAdd = item && (item.stage === 'editing' || item.changed);
  const addLabel = !item ? 'Add to review' : (item.stage !== 'editing' && item.changed ? 'Update in review' : (needsAdd ? 'Add to review' : 'In review'));
  const isCustom = template && !template.id.startsWith('starter-');

  const changeValue = (key, v) => {
    const next = { ...values, [key]: v };
    setValues(next);
    if (!item) return;
    clearTimeout(commit.current);
    commit.current = setTimeout(() => call('updateItem', { itemId: item.id, values: next }), 400);
  };
  const send = async (harder) => {
    const request = draft.trim();
    if (!request || !currentId) return;
    setDraft('');
    if (item) await call('editItem', { itemId: item.id, request, harder });
    else {
      await call('editTemplate', {
        templateId: template.id, brandId: ws.brand && (ws.ui.brandId || g.brands[0].id), accent: ws.brand.accent,
        values: gpWithPlaceholders(shape, gpValuesFor(shape, values)), request, harder, fps: ws.fps, durationSec: ws.durationSec
      });
    }
  };
  const shownFields = fieldDefs.filter((f) => f.type !== 'layout' && !(kind === 'slide' && f.type === 'image'));
  const layoutField = item ? fieldDefs.find((f) => f.type === 'layout') : null;
  const showBoxes = ws.ui.showBoxes !== false;
  const snap = ws.ui.snap !== false;
  const wired = Boolean(item && /\blayout\b/.test(item.code || ''));
  const boxLabels = Object.fromEntries(shownFields.map((f) => [f.key, f.label]));

  return (
    <React.Fragment>
      <div className="gp-top">
        <select className="settings-input gp-grow" aria-label="Template" value={template ? template.id : ''}
          onChange={(e) => call('useTemplate', { itemId: item && item.id, kind, templateId: e.target.value })}>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <button type="button" className="btn small ghost gp-square" aria-label="Save as template" title="Save as template" onClick={() => setNameModal({ mode: 'new', initial: '' })}>+</button>
        {isCustom && <button type="button" className="btn small ghost" onClick={() => setNameModal({ mode: 'rename', initial: template.name })}>Rename</button>}
        {layoutField && (
          <div className="gp-toggle gp-toggle-small" role="group" aria-label="Boxes">
            <button type="button" className={showBoxes ? 'is-on' : ''} aria-pressed={showBoxes} onClick={() => call('setUi', { showBoxes: !showBoxes })}>Boxes</button>
            <button type="button" className={snap ? 'is-on' : ''} aria-pressed={snap} onClick={() => call('setUi', { snap: !snap })}>Snap</button>
          </div>
        )}
        {previewShell.toggle}
      </div>

      <div className="gp-main">
        <div className="gp-stage">
          <div className="gp-stage-frame">
            <GpPreview message={message} onError={previewShell.onError} />
            {layoutField && showBoxes && (
              <GpBoxes boxes={values[layoutField.key] || {}} labels={boxLabels} snap={snap}
                onChange={(key, box) => changeValue(layoutField.key, { ...(values[layoutField.key] || {}), [key]: box })} />
            )}
            {status && <div className="gp-badge"><span className="gp-spinner" />Updating</div>}
          </div>
          {previewShell.error}
        </div>

        <section className="panel gp-side">
          <div className="gp-side-head">
            <label className="gp-field gp-grow">
              <span className="gp-label">Type</span>
              <select className="settings-input" value={kind} onChange={(e) => {
                const next = e.target.value;
                if (next === 'callout' && !ws.items.some((it) => it.kind === 'callout' && it.stage === 'editing')) call('newCallout');
                else call('setUi', { kind: next });
              }}>
                <option value="slide">Slide</option>
                <option value="callout">Callout</option>
              </select>
            </label>
            {item && (
              <button type="button" className="btn small ghost gp-square gp-reset" aria-label="Reset to template" title="Reset to template"
                onClick={() => call('resetItem', { itemId: item.id })}>
                <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v2.8h2.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            )}
          </div>
          {kind === 'slide' && (
            <div className="gp-field">
              <span className="gp-label">Slide image</span>
              <button type="button" className="btn small ghost gp-ellipsis" onClick={() => call('loadSlides')}>{item ? item.name : 'Load slide'}</button>
            </div>
          )}
          {kind === 'slide' && item && item.mode === 'rebuilt' && (
            <button type="button" className="btn small ghost" onClick={() => call('revertToImage', { itemId: item.id })}>Back to original image</button>
          )}
          {kind === 'callout' && <button type="button" className="btn small ghost" onClick={() => call('newCallout')}>New callout</button>}
          {kind === 'callout' && item && layoutField && !wired && (
            <div className="gp-row">
              <span className="gp-dim gp-grow">This design ignores its boxes</span>
              <button type="button" className="btn small ghost" disabled={g.busyEdit} onClick={() => call('editItem', { itemId: item.id, request: GP_WIRE_REQUEST })}>Use boxes</button>
            </div>
          )}
          {shownFields.map((f) => (kind === 'callout' && item ? (
            <div className="gp-element" key={f.key}>
              <GpField field={f} value={values[f.key]} call={call} onChange={(v) => changeValue(f.key, v)} />
              <button type="button" className="gp-element-remove" aria-label={`Remove ${f.label}`} title="Remove" onClick={() => call('removeField', { itemId: item.id, key: f.key })}>×</button>
            </div>
          ) : <GpField key={f.key} field={f} value={values[f.key]} call={call} onChange={(v) => changeValue(f.key, v)} />))}
          {kind === 'callout' && item && (
            <div className="gp-row">
              <span className="gp-label">Add</span>
              {[['text', 'Text'], ['list', 'List'], ['image', 'Image']].map(([type, label]) => (
                <button type="button" key={type} className="btn small ghost" onClick={() => call('addField', { itemId: item.id, type })}>{label}</button>
              ))}
            </div>
          )}
          {ws.brand && ws.brand.missingFonts && ws.brand.missingFonts.length > 0 && (
            <div className="notice error">Open Creative Cloud and activate {ws.brand.missingFonts.join(', ')}</div>
          )}
          <button type="button" className="btn small ghost" onClick={() => setShowBrand(true)}>Brand</button>
          <button type="button" className="btn small gp-add" disabled={!needsAdd} onClick={() => call('addToReview', { itemId: item.id })}>{addLabel}</button>
        </section>
      </div>

      <GpChat chat={chat} status={status} draft={draft} setDraft={setDraft} busy={g.busyEdit} onSend={send}
        canUndo={item ? item.canUndo : Boolean(template && template.canUndo)}
        onUndo={() => (item ? call('undoItem', { itemId: item.id }) : call('undo', { templateId: template.id }))} />

      {showBrand && <GpBrandModal g={g} call={call} onClose={() => setShowBrand(false)} />}
      {nameModal && (
        <GpNameModal title={nameModal.mode === 'rename' ? 'Rename template' : 'Save as template'} initial={nameModal.initial} onClose={() => setNameModal(null)}
          onSave={async (name) => {
            const res = nameModal.mode === 'rename'
              ? await call('renameTemplate', { templateId: template.id, name })
              : await call('saveAsTemplate', { itemId: item && item.id, kind, templateId: template.id, name });
            if (res) setNameModal(null);
          }} />
      )}
    </React.Fragment>
  );
}

function GpLibrary({ g, call, connected, previewShell }) {
  const ws = g.workspace;
  const filter = ws.ui.filter || 'editing';
  const [picked, setPicked] = React.useState(null);
  const [confirmRemove, setConfirmRemove] = React.useState(null);
  const [imported, setImported] = React.useState(null);
  const [importError, setImportError] = React.useState(null);
  const lists = {
    editing: ws.items.filter((it) => it.stage === 'editing'),
    review: ws.items.filter((it) => it.stage === 'review'),
    queue: ws.items.filter((it) => it.stage === 'queue')
  };
  const shown = lists[filter] || [];
  const current = shown.find((it) => it.id === picked) || shown[0] || null;
  const view = current && (current.stage === 'editing' || !current.snapshot
    ? { code: current.code, fieldDefs: current.fieldDefs, values: current.values }
    : current.snapshot);
  const message = React.useMemo(() => {
    if (!view) return null;
    const shape = { fields: view.fieldDefs };
    return {
      code: view.code,
      fields: gpWithPlaceholders(shape, gpValuesFor(shape, view.values)),
      brand: ws.brand,
      fps: ws.fps,
      durationInFrames: Math.max(1, Math.round(ws.durationSec * ws.fps))
    };
  }, [current && current.id, view && view.code, view && JSON.stringify(view.values), ws.brand, ws.fps, ws.durationSec]);

  const running = Boolean(g.job && g.job.status === 'running');
  const job = g.job && g.job.kind === 'render' ? g.job : null;
  const toRender = lists.queue.filter((it) => it.renderState !== 'current').length;
  const setFilter = (f) => { setPicked(null); call('setUi', { filter: f }); };
  const hasEdits = (it) => (it.chat && it.chat.length) || it.canUndo;
  const remove = (it) => {
    if (hasEdits(it) && confirmRemove !== it.id) { setConfirmRemove(it.id); return; }
    setConfirmRemove(null);
    call('removeItem', { itemId: it.id });
  };
  const importFiles = async () => {
    setImported(null);
    setImportError(null);
    try {
      const files = ws.toImport;
      const res = await window.leaderpassAPI.call('import_graphics', { bin_path: ws.binPath, files });
      setImported(res?.data || {});
      if (!(res?.data?.failed)) await call('markImported', { files });
    } catch (err) {
      setImportError(String(err?.error?.message || err?.error || err?.message || 'Import failed'));
    }
  };
  const tabs = [['editing', 'Editing'], ['review', 'In review'], ['queue', 'Queue']];

  return (
    <React.Fragment>
      <div className="gp-top"><span className="gp-grow" />{previewShell.toggle}</div>
      <div className="gp-main">
        <div className="gp-stage">
          {current ? (
            <React.Fragment>
              <div className="gp-stage-frame"><GpPreview message={message} onError={previewShell.onError} /></div>
              {previewShell.error}
              <div className="gp-row">
                <span className="gp-grow gp-ellipsis">{current.name}</span>
                {current.changed && current.stage !== 'editing' && <span className="gp-tag is-warn">Newer version in Design</span>}
                <button type="button" className="btn small ghost" onClick={() => (current.stage === 'editing' ? call('openItem', { itemId: current.id }) : call('setStage', { itemId: current.id, stage: 'editing' }))}>
                  {current.stage === 'editing' ? 'Open in Design' : 'Keep editing'}
                </button>
              </div>
            </React.Fragment>
          ) : <div className="notice">Nothing here yet</div>}
        </div>

        <section className="panel gp-side">
          <div className="gp-tabs" role="group" aria-label="Filter">
            {tabs.map(([k, label]) => (
              <button type="button" key={k} className={filter === k ? 'is-on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                <span className="gp-tab-count">{lists[k].length}</span><span>{label}</span>
              </button>
            ))}
          </div>
          <div className="gp-rows">
            {shown.map((it) => (
              <div className={`gp-item${current && it.id === current.id ? ' is-active' : ''}`} key={it.id}>
                <button type="button" className="gp-item-main" onClick={() => setPicked(it.id)}>
                  <span className="gp-ellipsis">{it.name}</span>
                  <span className="gp-item-tags">
                    {it.renderState === 'stale' && <span className="gp-tag is-warn">Re-render</span>}
                    {it.renderState === 'current' && <span className="gp-tag is-done">Rendered</span>}
                    <span className="gp-dim">{it.kind === 'callout' ? 'Callout' : (it.mode === 'rebuilt' ? 'Rebuilt' : 'Image')}</span>
                  </span>
                </button>
                {it.stage === 'editing'
                  ? <button type="button" className={`gp-item-icon${confirmRemove === it.id ? ' is-confirm' : ''}`} aria-label={confirmRemove === it.id ? 'Confirm remove' : 'Remove'} title={confirmRemove === it.id ? 'Click again to remove' : 'Remove'} onClick={() => remove(it)}>
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" /></svg>
                    </button>
                  : <button type="button" className={`gp-item-icon${it.stage === 'queue' ? ' is-on' : ''}`} aria-pressed={it.stage === 'queue'} aria-label={it.stage === 'queue' ? 'Remove from render queue' : 'Add to render queue'} title={it.stage === 'queue' ? 'Remove from render queue' : 'Add to render queue'}
                      onClick={() => call('setStage', { itemId: it.id, stage: it.stage === 'queue' ? 'review' : 'queue' })}>
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="2" /><path d="M8.2 7.4v5.2l4.4-2.6z" fill="currentColor" /></svg>
                    </button>}
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel gp-render">
        {running && (
          <div className="gp-col">
            <div className="run-progress-track"><div className="run-progress-fill" style={{ width: `${Math.round(((g.job.done + (g.job.current || 0) / 100) / Math.max(1, g.job.total)) * 100)}%` }} /></div>
            <span className="gp-dim">{g.job.done} of {g.job.total}</span>
          </div>
        )}
        {job && !running && <span className="gp-dim">{job.outputs.length} rendered{job.skipped ? ` · ${job.skipped} unchanged` : ''}{job.failures.length ? ` · ${job.failures.length} failed` : ''}{job.status === 'canceled' ? ' · canceled' : ''}</span>}
        {job && job.failures.slice(0, 3).map((f, i) => <div className="notice error" key={i}>{f.name}: {f.error}</div>)}
        <div className="gp-row">
          <label className="gp-inline"><span className="gp-label">Seconds</span>
            <input key={ws.project || 'none'} className="settings-input gp-num" type="number" min="1" max="600" defaultValue={ws.durationSec} onBlur={(e) => call('updateWorkspace', { durationSec: e.target.value })} />
          </label>
          <label className="gp-inline"><span className="gp-label">FPS</span>
            <select className="settings-input" value={ws.fps} onChange={(e) => call('updateWorkspace', { fps: Number(e.target.value) })}>
              {GP_FPS.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
            </select>
          </label>
          <button type="button" className="btn small ghost" onClick={async () => {
            const res = await call('pickFolder');
            if (res) call('updateWorkspace', { outDir: res });
          }}>{ws.outDir ? 'Change folder' : 'Output folder'}</button>
          <span className="gp-dim gp-grow gp-ellipsis">{ws.outDir}</span>
          {running
            ? <button type="button" className="btn small ghost" onClick={() => call('cancel')}>Cancel</button>
            : <button type="button" className="btn small" disabled={!toRender || !ws.outDir} onClick={() => call('renderQueue')}>{toRender || !lists.queue.length ? `Render queue (${toRender})` : 'Up to date'}</button>}
        </div>
        {ws.toImport.length > 0 && !running && (
          <div className="gp-row">
            <input key={`${ws.project || 'none'}-bin`} className="settings-input gp-grow" aria-label="Resolve bin" defaultValue={ws.binPath} onBlur={(e) => call('updateWorkspace', { binPath: e.target.value })} />
            <button type="button" className="btn small" disabled={!connected} onClick={importFiles}>Import {ws.toImport.length} to Resolve</button>
          </div>
        )}
        {imported && <span className="gp-dim">{imported.imported ?? 0} imported{imported.failed ? ` · ${imported.failed} failed` : ''}</span>}
        {importError && <div className="notice error">{importError}</div>}
      </section>
    </React.Fragment>
  );
}

function GraphicsPage({ connected }) {
  const api = window.graphicsAPI;
  const [g, setG] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [previewError, setPreviewError] = React.useState(null);
  const [showSettings, setShowSettings] = React.useState(false);
  const [keyDraft, setKeyDraft] = React.useState('');

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

  if (!g || !g.workspace) return <div className="page-stack gp-page"><div className="notice">{error || 'Loading'}</div></div>;
  if (!g.engineReady) return <div className="page-stack gp-page"><div className="notice error">The Graphics engine is missing. Run npm install on this machine.</div></div>;

  const ws = g.workspace;
  const page = ws.ui.page;
  const shell = {
    onError: setPreviewError,
    error: previewError ? <div className="notice error">{previewError}</div> : null,
    toggle: (
      <div className="gp-toggle" role="group" aria-label="Page">
        <button type="button" className={page === 'design' ? 'is-on' : ''} aria-pressed={page === 'design'} onClick={() => call('setUi', { page: 'design' })}>Design</button>
        <button type="button" className={page === 'library' ? 'is-on' : ''} aria-pressed={page === 'library'} onClick={() => call('setUi', { page: 'library' })}>Library ({ws.items.length})</button>
      </div>
    )
  };

  return (
    <div className="page-stack gp-page">
      {error && <div className="notice error">{error}</div>}
      {page === 'library'
        ? <GpLibrary g={g} call={call} connected={connected} previewShell={shell} />
        : <GpDesign g={g} call={call} previewShell={shell} />}
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
