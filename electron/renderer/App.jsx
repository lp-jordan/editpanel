const { useEffect, useState } = React;

function App() {
  const [status, setStatus] = useState('waiting for Resolve');
  const [info, setInfo] = useState(null);
  const [log, setLog] = useState([]);

  useEffect(() => {
    const unsubscribeStatus = window.electronAPI.onHelperStatus(message => {
      if (message.ok && message.data) {
        setStatus('connected');
        setInfo(message.data);
      } else if (!message.ok && message.error === 'No Resolve running') {
        setStatus('waiting for Resolve');
        setInfo(null);
      }
    });

    const unsubscribeLog = window.electronAPI.onHelperMessage(message => {
      setLog(prev => {
        const next = [...prev, message];
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
