function App() {
  const [project, setProject] = React.useState('');
  const [timeline, setTimeline] = React.useState('');
  const [log, setLog] = React.useState([]);
  const [connected, setConnected] = React.useState(false);
  const [consoleOpen, setConsoleOpen] = React.useState(false);

  const appendLog = msg => {
    setLog(prev => {
      const next = [...prev, msg];
      return next.slice(-20);
    });
  };

  React.useEffect(() => {
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

  const handleNewProjectBins = () => {
    appendLog('New Project Bins clicked');
    window.leaderpassAPI
      .call('create_project_bins')
      .then(() => appendLog('Project bin creation command sent'))
      .catch(err => appendLog(`Project bin creation error: ${err?.error || err}`));
  };

  return (
    <div className="app-container" style={{ paddingBottom: consoleOpen ? '240px' : '40px' }}>
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
            <button className="task-button" onClick={handleNewProjectBins}>
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
      <SlideoutConsole log={log} open={consoleOpen} onToggle={setConsoleOpen} />
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
