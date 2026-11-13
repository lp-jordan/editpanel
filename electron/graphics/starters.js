'use strict';
/** The built-in templates. Copied to the library once, by id, so user edits are kept; a higher `version` replaces the copy. */
const clamp = "{extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)}";

// A blank callout: each element the editor adds in the sidebar sits in its own box (fields.layout),
// moved and resized in the preview. Text is fitted to its box.
const blank = `const Template = ({fields, brand}) => {
  const {useCurrentFrame, useVideoConfig, interpolate, Easing, AbsoluteFill, Img} = Remotion;
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const on = interpolate(frame, [0, 0.5 * fps], [0, 1], ${clamp});
  const family = brand.headingFont || 'sans-serif';
  const layout = fields.layout || {};
  const isImage = (v) => typeof v === 'string' && /^(https?:|data:)/.test(v);
  const fitBox = (text, w, h, weight, lineHeight) => {
    let best = {fontSize: 0, lines: [text]};
    for (let n = 1; n <= 6; n += 1) {
      const fit = Layout.fitTextOnNLines({text, maxLines: n, maxBoxWidth: w, fontFamily: family, fontWeight: weight, maxFontSize: Math.min(220, h / (n * lineHeight))});
      if (fit.lines.length * fit.fontSize * lineHeight <= h + 1 && fit.fontSize > best.fontSize) best = fit;
    }
    return best;
  };
  const parts = Object.entries(fields).filter(([key, v]) => key !== 'layout' && (Array.isArray(v) ? v.some(Boolean) : Boolean(v)));
  return (
    <AbsoluteFill>
      {parts.map(([key, v], i) => {
        const b = layout[key] || {x: 110, y: 110 + i * 260, w: 860, h: 220};
        const box = {position: 'absolute', left: b.x, top: b.y, width: b.w, height: b.h, color: 'white', fontFamily: family, opacity: on, transform: 'translateY(' + (1 - on) * 24 + 'px)'};
        if (Array.isArray(v)) {
          const items = v.filter(Boolean).slice(0, 8);
          const row = b.h / items.length;
          return (
            <div key={key} style={{...box, display: 'flex', flexDirection: 'column'}}>
              {items.map((item, j) => {
                const fit = fitBox(item, b.w, row * 0.8, 500, 1.2);
                return <div key={j} style={{height: row, display: 'flex', flexDirection: 'column', justifyContent: 'center', fontWeight: 500, fontSize: fit.fontSize, lineHeight: 1.2}}>{fit.lines.map((l, k) => <div key={k}>{l}</div>)}</div>;
              })}
            </div>
          );
        }
        if (isImage(v)) return <Img key={key} src={v} style={{...box, objectFit: 'contain'}} />;
        const fit = fitBox(String(v), b.w, b.h, 700, 1.12);
        return <div key={key} style={{...box, fontWeight: 700, fontSize: fit.fontSize, lineHeight: 1.12}}>{fit.lines.map((l, k) => <div key={k}>{l}</div>)}</div>;
      })}
    </AbsoluteFill>
  );
};`;

const mainIdea = `const Template = ({fields, brand}) => {
  const {useCurrentFrame, useVideoConfig, interpolate, Easing, AbsoluteFill} = Remotion;
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const line = interpolate(frame, [0, 0.35 * fps], [0, 1], ${clamp});
  const rise = interpolate(frame, [0.2 * fps, 0.75 * fps], [0, 1], ${clamp});
  const family = brand.headingFont || 'sans-serif';
  const b = (fields.layout || {}).text || {x: 110, y: 593, w: 860, h: 357};
  const fit = Layout.fitTextOnNLines({text: fields.text || ' ', maxLines: 3, maxBoxWidth: b.w, fontFamily: family, fontWeight: 700, maxFontSize: Math.min(160, (b.h - 34) / 3.36)});
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: b.x, top: b.y, width: b.w, height: b.h, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end'}}>
        <div style={{width: 150 * line, height: 10, marginBottom: 24, background: brand.accent}} />
        <div style={{opacity: rise, transform: 'translateY(' + (1 - rise) * 36 + 'px)', fontFamily: family, fontWeight: 700, fontSize: fit.fontSize, lineHeight: 1.12, color: 'white'}}>
          {fit.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </div>
    </AbsoluteFill>
  );
};`;

const list = `const Template = ({fields, brand}) => {
  const {useCurrentFrame, useVideoConfig, interpolate, Easing, AbsoluteFill} = Remotion;
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const family = brand.headingFont || 'sans-serif';
  const layout = fields.layout || {};
  const hb = layout.heading || {x: 110, y: 230, w: 760, h: 170};
  const ib = layout.items || {x: 110, y: 420, w: 760, h: 430};
  const items = (fields.items || []).filter(Boolean).slice(0, 6);
  const head = interpolate(frame, [0, 0.5 * fps], [0, 1], ${clamp});
  const heading = Layout.fitTextOnNLines({text: fields.heading || ' ', maxLines: 2, maxBoxWidth: hb.w, fontFamily: family, fontWeight: 700, maxFontSize: Math.min(120, hb.h / 2.24)});
  const row = ib.h / Math.max(1, items.length);
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: hb.x, top: hb.y, width: hb.w, height: hb.h, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', opacity: head, fontFamily: family, fontWeight: 700, fontSize: heading.fontSize, lineHeight: 1.12, color: brand.accent}}>
        {heading.lines.map((l, i) => <div key={i}>{l}</div>)}
      </div>
      <div style={{position: 'absolute', left: ib.x, top: ib.y, width: ib.w, height: ib.h, color: 'white', fontFamily: family}}>
        {items.map((item, i) => {
          const start = 0.3 * fps + i * 8;
          const on = interpolate(frame, [start, start + 0.45 * fps], [0, 1], ${clamp});
          const fit = Layout.fitTextOnNLines({text: item, maxLines: 2, maxBoxWidth: ib.w, fontFamily: family, fontWeight: 500, maxFontSize: Math.min(46, (row - 20) / 2.4)});
          return (
            <div key={i} style={{height: row, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center', opacity: on, transform: 'translateX(' + (1 - on) * -24 + 'px)', borderTop: '2px solid rgba(255,255,255,0.35)', fontWeight: 500, fontSize: fit.fontSize, lineHeight: 1.2}}>
              {fit.lines.map((l, j) => <div key={j}>{l}</div>)}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};`;

const fullSlide = `const Template = ({fields}) => {
  const {useCurrentFrame, useVideoConfig, interpolate, Easing, AbsoluteFill, Img} = Remotion;
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const on = interpolate(frame, [0, 0.4 * fps], [0, 1], ${clamp});
  return (
    <AbsoluteFill style={{opacity: on}}>
      {fields.image
        ? <Img src={fields.image} style={{width: '100%', height: '100%', objectFit: 'contain'}} />
        : <AbsoluteFill style={{background: '#f4eee2'}} />}
    </AbsoluteFill>
  );
};`;

const besideSpeaker = `const Template = ({fields}) => {
  const {useCurrentFrame, useVideoConfig, interpolate, Easing, AbsoluteFill, Img} = Remotion;
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const on = interpolate(frame, [0, 0.55 * fps], [0, 1], ${clamp});
  const box = {position: 'absolute', right: 96, top: 170, width: 1136, height: 639, opacity: on, transform: 'translateY(' + (1 - on) * 40 + 'px)', borderRadius: 10, overflow: 'hidden', boxShadow: '0 18px 50px rgba(0,0,0,0.45)'};
  return (
    <AbsoluteFill>
      <div style={box}>
        {fields.image
          ? <Img src={fields.image} style={{width: '100%', height: '100%', objectFit: 'cover'}} />
          : <div style={{width: '100%', height: '100%', background: '#f4eee2'}} />}
      </div>
    </AbsoluteFill>
  );
};`;

const textField = {key: 'text', label: 'Text', type: 'textarea', default: 'Clarity beats intensity'};
const imageField = {key: 'image', label: 'Slide image', type: 'image', default: ''};

module.exports = [
  {id: 'starter-blank', name: 'Blank', kind: 'callout', version: 2, code: blank, fields: [
    {key: 'text', label: 'Text', type: 'textarea', default: ''},
    {key: 'layout', label: 'Layout', type: 'layout', default: {text: {x: 110, y: 380, w: 860, h: 320}}}
  ]},
  {id: 'starter-main-idea', name: 'Main idea', kind: 'callout', version: 2, code: mainIdea, fields: [
    textField,
    {key: 'layout', label: 'Layout', type: 'layout', default: {text: {x: 110, y: 593, w: 860, h: 357}}}
  ]},
  {id: 'starter-list', name: 'List', kind: 'callout', version: 2, code: list, fields: [
    {key: 'heading', label: 'Heading', type: 'text', default: 'Three habits that stick'},
    {key: 'items', label: 'Items', type: 'list', default: ['Name the priority', 'Protect the time', 'Review every Friday']},
    {key: 'layout', label: 'Layout', type: 'layout', default: {heading: {x: 110, y: 230, w: 760, h: 170}, items: {x: 110, y: 420, w: 760, h: 430}}}
  ]},
  {id: 'starter-full-slide', name: 'Full screen', kind: 'slide', code: fullSlide, fields: [imageField]},
  {id: 'starter-beside-speaker', name: 'Beside speaker', kind: 'slide', code: besideSpeaker, fields: [imageField]}
];
