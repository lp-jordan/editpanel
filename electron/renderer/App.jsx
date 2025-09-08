const { useEffect, useState } = React;

function App() {
  const [connected, setConnected] = useState(false);
  const [info, setInfo] = useState(null);
  const [log, setLog] = useState([]);

  // Load context information on mount
  useEffect(() => {
    let active = true;
    window.leaderpassAPI
      .call('context')
      .then(ctx => {
        if (active) {
          setInfo(ctx);
          setConnected(true);
        }
      })
      .catch(() => setConnected(false));

    // Subscribe to helper messages
    const unsubscribe = window.electronAPI.onHelperMessage(message => {
      setLog(prev => {
        const next = [...prev, message];
        return next.slice(-20);
      });
    });

    return () => {
      active = false;
      unsubscribe && unsubscribe();
    };
  }, []);

  const callAction = action => {
    window.leaderpassAPI.call(action);
  };

  return (
    <div>
      <div>
        <strong>Connection:</strong> {connected ? 'Connected' : 'Disconnected'}
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
