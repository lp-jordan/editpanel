/**
 * Shared by the render host and the live preview, so both draw a template the same way.
 * A template is source text written at run time; see electron/graphics/guide.js for its contract.
 */
import React, {useEffect, useMemo, useState} from 'react';
import * as Babel from '@babel/standalone';
import * as Remotion from 'remotion';
import {fillTextBox, fitText, fitTextOnNLines, measureText} from '@remotion/layout-utils';
import {linearTiming, springTiming, TransitionSeries} from '@remotion/transitions';
import {fade} from '@remotion/transitions/fade';
import {wipe} from '@remotion/transitions/wipe';

const Layout = {fillTextBox, fitText, fitTextOnNLines, measureText};
const Transitions = {TransitionSeries, linearTiming, springTiming, fade, wipe};

export function compileTemplate(code: string): React.ComponentType<any> {
	const source = String(code || '')
		.replace(/^\s*import\s.*$/gm, '')
		.replace(/^\s*export\s+default\s+/gm, '')
		.replace(/^\s*export\s+/gm, '');
	const js = Babel.transform(source, {presets: [['react', {runtime: 'classic'}], 'typescript'], filename: 'template.tsx'}).code;
	const make = new Function('React', 'Remotion', 'Layout', 'Transitions', `${js}\nreturn Template;`);
	const Template = make(React, Remotion, Layout, Transitions);
	if (typeof Template !== 'function') throw new Error('The template must define Template');
	return Template;
}

export type StageProps = {code: string; fields: Record<string, unknown>; brand: any};

export const Stage: React.FC<StageProps> = ({code, fields, brand}) => {
	const Template = useMemo(() => compileTemplate(code), [code]);
	const fontKey = JSON.stringify((brand && brand.fontFaces) || []);
	const [handle] = useState(() => Remotion.delayRender('brand fonts'));
	const [ready, setReady] = useState(false);
	useEffect(() => {
		let live = true;
		const faces: any[] = JSON.parse(fontKey);
		Promise.all(faces.map(async (f) => {
			const face = new FontFace(f.family, `url("${f.url}")`, {weight: String(f.weight || 400)});
			(document.fonts as any).add(await face.load());
		})).then(() => {
			if (!live) return;
			setReady(true);
			Remotion.continueRender(handle);
		}).catch((err) => Remotion.cancelRender(err));
		return () => { live = false; };
	}, [fontKey, handle]);
	if (!ready) return null;
	return (
		<Remotion.AbsoluteFill style={{backgroundColor: 'transparent'}}>
			<Template fields={fields || {}} brand={brand || {}} />
		</Remotion.AbsoluteFill>
	);
};
