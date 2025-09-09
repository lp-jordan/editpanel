const { useEffect, useState } = React;

function App() {
  const [project, setProject] = useState('');
  const [timeline, setTimeline] = useState('');
  const [log, setLog] = useState([]);
  const [connected, setConnected] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const appendLog = msg => {
    setLog(prev => {
      const next = [...prev, msg];
      return next.slice(-20);
    });
  };

  useEffect(() => {
    const unsubscribeStatus = window.electronAPI.onHelperStatus(status => {
      const msg = `Status: ${status.code}${status.error ? ' - ' + status.error : ''}`;
      appendLog(msg);
      if (status.code === 'CONNECTED' && status.ok) {
        setConnected(true);
        if (status.data) {
          if (status.data.project) {
            setProject(status.data.project);
          }
          if (status.data.timeline) {
            setTimeline(status.data.timeline);
          }
        }
      } else {
        setConnected(false);
        setProject('');
        setTimeline('');
      }
    });

    const unsubscribeMessage = window.electronAPI.onHelperMessage(payload => {
      const entry = typeof payload === 'string' ? payload : JSON.stringify(payload);
      appendLog(entry);
    });

    return () => {
      unsubscribeStatus();
      unsubscribeMessage();
    };
  }, []);

  const logAction = action => {
    appendLog(`${action} clicked`);
  };

  const handleConnect = () => {
    window.leaderpassAPI
      .call('connect')
      .then(() => appendLog('Connect success'))
      .catch(err => appendLog(`Connect error: ${err?.error || err}`));
  };

  return (
    <div className="app-container">
      <header>{project || 'No Project'}</header>
      {connected ? (
        <>
          <div className="function-grid">
            <button className="task-button" onClick={() => logAction('Export')}>
              <span className="icon">📤</span>
              <span>Export</span>
            </button>
            <button className="task-button" onClick={() => logAction('Spellcheck')}>
              <span className="icon">📝</span>
              <span>Spellcheck</span>
            </button>
            <button className="task-button" onClick={() => logAction('New Project Bins')}>
              <span className="icon">🗂️</span>
              <span>New Project Bins</span>
            </button>
          </div>
          <div className="dashboard">
            <h2>Dashboard</h2>
            <div>Active Timeline: {timeline || 'None'}</div>
          </div>
        </>
      ) : (
        <div className="connect-container">
          <button className="connect-button" onClick={handleConnect}>
            Connect
          </button>
        </div>
      )}
      <SlideoutConsole log={log} />
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
