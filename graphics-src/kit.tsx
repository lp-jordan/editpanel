/** The live preview: runs inside a sandboxed iframe with no access to the app. */
import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Player} from '@remotion/player';
import {Stage} from './runtime';

const say = (message: any) => window.parent.postMessage(message, '*');

class Boundary extends React.Component<any, {error: string | null}> {
	state = {error: null};
	static getDerivedStateFromError(err: any) { return {error: String((err && err.message) || err)}; }
	componentDidCatch(err: any) { say({type: 'error', message: String((err && err.message) || err)}); }
	render() {
		if (this.state.error) return <div style={{color: '#d88989', font: '28px sans-serif', padding: 60}}>{this.state.error}</div>;
		return this.props.children;
	}
}

const Preview: React.FC<any> = (props) => (
	<Boundary key={props.code}><Stage {...props} /></Boundary>
);

const App: React.FC = () => {
	const [msg, setMsg] = useState<any>(null);
	useEffect(() => {
		const onMessage = (e: MessageEvent) => { if (e.data && e.data.type === 'render') setMsg(e.data); };
		window.addEventListener('message', onMessage);
		say({type: 'ready'});
		return () => window.removeEventListener('message', onMessage);
	}, []);
	if (!msg) return null;
	return (
		<Player
			component={Preview as any}
			inputProps={{code: msg.code, fields: msg.fields, brand: msg.brand}}
			durationInFrames={msg.durationInFrames}
			fps={msg.fps}
			compositionWidth={1920}
			compositionHeight={1080}
			initialFrame={Math.min(msg.durationInFrames - 1, Math.round(msg.fps * 3))}
			controls
			acknowledgeRemotionLicense
			loop
			style={{width: '100%', height: '100%'}}
		/>
	);
};

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
