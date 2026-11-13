'use strict';
/** The built-in templates. Copied to the library once, by id, so user edits are kept. */
const clamp = "{extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic)}";

// A blank callout: draws whatever elements the editor added in the sidebar, stacked, until Claude lays them out.
const blank = `const Template = ({fields, brand}) => {
  const {useCurrentFrame, useVideoConfig, interpolate, Easing, AbsoluteFill, Img} = Remotion;
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const on = interpolate(frame, [0, 0.5 * fps], [0, 1], ${clamp});
  const family = brand.headingFont || 'sans-serif';
  const isImage = (v) => typeof v === 'string' && /^(https?:|data:)/.test(v);
  const parts = Object.entries(fields || {}).filter(([, v]) => (Array.isArray(v) ? v.some(Boolean) : Boolean(v)));
  return (
    <AbsoluteFill style={{justifyContent: 'center'}}>
      <div style={{marginLeft: 110, width: 860, color: 'white', fontFamily: family, opacity: on, transform: 'translateY(' + (1 - on) * 24 + 'px)'}}>
        {parts.map(([key, v]) => {
          if (Array.isArray(v)) {
            return (
              <div key={key} style={{marginBottom: 24}}>
                {v.filter(Boolean).slice(0, 8).map((item, i) => {
                  const fit = Layout.fitTextOnNLines({text: item, maxLines: 2, maxBoxWidth: 860, fontFamily: family, fontWeight: 500, maxFontSize: 46});
                  return <div key={i} style={{fontWeight: 500, fontSize: fit.fontSize, lineHeight: 1.2, padding: '8px 0'}}>{fit.lines.map((l, j) => <div key={j}>{l}</div>)}</div>;
                })}
              </div>
            );
          }
          if (isImage(v)) return <Img key={key} src={v} style={{display: 'block', maxWidth: 860, maxHeight: 480, objectFit: 'contain', marginBottom: 24}} />;
          const fit = Layout.fitTextOnNLines({text: String(v), maxLines: 3, maxBoxWidth: 860, fontFamily: family, fontWeight: 700, maxFontSize: 80});
          return <div key={key} style={{fontWeight: 700, fontSize: fit.fontSize, lineHeight: 1.12, marginBottom: 24}}>{fit.lines.map((l, i) => <div key={i}>{l}</div>)}</div>;
        })}
      </div>
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
  const text = fields.text || ' ';
  const fit = Layout.fitTextOnNLines({text, maxLines: 3, maxBoxWidth: 860, fontFamily: family, fontWeight: 700, maxFontSize: 96});
  return (
    <AbsoluteFill>
      <div style={{position: 'absolute', left: 110, bottom: 130, width: 860}}>
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
  const items = (fields.items || []).filter(Boolean).slice(0, 6);
  const head = interpolate(frame, [0, 0.5 * fps], [0, 1], ${clamp});
  const heading = Layout.fitTextOnNLines({text: fields.heading || ' ', maxLines: 2, maxBoxWidth: 760, fontFamily: family, fontWeight: 700, maxFontSize: 68});
  return (
    <AbsoluteFill style={{justifyContent: 'center'}}>
      <div style={{marginLeft: 110, width: 760, color: 'white', fontFamily: family}}>
        <div style={{opacity: head, fontWeight: 700, fontSize: heading.fontSize, lineHeight: 1.12, color: brand.accent, marginBottom: 26}}>
          {heading.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
        {items.map((item, i) => {
          const start = 0.3 * fps + i * 8;
          const on = interpolate(frame, [start, start + 0.45 * fps], [0, 1], ${clamp});
          const fit = Layout.fitTextOnNLines({text: item, maxLines: 2, maxBoxWidth: 760, fontFamily: family, fontWeight: 500, maxFontSize: 46});
          return (
            <div key={i} style={{opacity: on, transform: 'translateX(' + (1 - on) * -24 + 'px)', borderTop: '2px solid rgba(255,255,255,0.35)', padding: '16px 0', fontWeight: 500, fontSize: fit.fontSize, lineHeight: 1.2}}>
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
  {id: 'starter-blank', name: 'Blank', kind: 'callout', code: blank, fields: [{key: 'text', label: 'Text', type: 'textarea', default: ''}]},
  {id: 'starter-main-idea', name: 'Main idea', kind: 'callout', code: mainIdea, fields: [textField]},
  {id: 'starter-list', name: 'List', kind: 'callout', code: list, fields: [
    {key: 'heading', label: 'Heading', type: 'text', default: 'Three habits that stick'},
    {key: 'items', label: 'Items', type: 'list', default: ['Name the priority', 'Protect the time', 'Review every Friday']}
  ]},
  {id: 'starter-full-slide', name: 'Full screen', kind: 'slide', code: fullSlide, fields: [imageField]},
  {id: 'starter-beside-speaker', name: 'Beside speaker', kind: 'slide', code: besideSpeaker, fields: [imageField]}
];
