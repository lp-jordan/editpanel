const { useEffect, useState } = React;

function App() {
  const [status, setStatus] = useState('waiting for Resolve');
  const [info, setInfo] = useState(null);
  const [log, setLog] = useState([]);

  useEffect(() => {
    let active = true;
    window.leaderpassAPI
      .call('context')
      .then(ctx => {
        if (active) {
          setInfo(ctx);
        }
      })
      .catch(() => {});

    // Subscribe to helper messages
    const unsubscribe = window.electronAPI.onHelperMessage(payload => {
      setConnected(payload.error !== 'No Resolve running');
      setLog(prev => {
        const entry = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const next = [...prev, entry];
        return next.slice(-20);
      });
    });

    return () => {
      unsubscribeStatus && unsubscribeStatus();
      unsubscribeLog && unsubscribeLog();
    };
  }, []);

  const callAction = action => {
    window.leaderpassAPI.call(action).catch(() => {});
  };

  return (
    <div>
      <div>
        <strong>Connection:</strong> {status}
      </div>
      <div>
        <strong>Info:</strong>
        <pre>{info ? JSON.stringify(info, null, 2) : '...'}</pre>
      </div>
      <div>
        <button onClick={() => callAction('add_marker')}>Add Marker</button>
        <button onClick={() => callAction('start_render')}>Start Render</button>
        <button onClick={() => callAction('stop_render')}>Stop Render</button>
      </div>
      <div>
        <h3>Log</h3>
        <pre>{log.join('\n')}</pre>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
