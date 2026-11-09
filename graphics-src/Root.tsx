/** The one prebuilt composition: it receives each template's source as props and draws it. */
import React from 'react';
import {Composition} from 'remotion';
import {Stage} from './runtime';

export const Root: React.FC = () => (
	<Composition
		id="Host"
		component={Stage as any}
		width={1920}
		height={1080}
		fps={24}
		durationInFrames={360}
		defaultProps={{code: '', fields: {}, brand: {}, fps: 24, durationInFrames: 360} as any}
		calculateMetadata={({props}: any) => ({fps: props.fps, durationInFrames: props.durationInFrames, props})}
	/>
);
