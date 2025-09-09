function App() {
  const [project, setProject] = React.useState('');
  const [timeline, setTimeline] = React.useState('');
  const [log, setLog] = React.useState([]);
  const [connected, setConnected] = React.useState(false);
  const [consoleOpen, setConsoleOpen] = React.useState(false);
  const [currentCategory, setCurrentCategory] = React.useState(null);

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

  const handleLPBaseExport = () => {
    logAction('LP Base Export');
    // Placeholder for LP Base Export script
  };

  const categories = ['SETUP', 'EDIT', 'AUDIO', 'DELIVER'];

  const actions = {
    SETUP: [
      { label: 'New Project Bins', icon: '🗂️', onClick: handleNewProjectBins }
    ],
    EDIT: [
      { label: 'Spellcheck', icon: '📝', onClick: () => logAction('Spellcheck') }
    ],
    AUDIO: [],
    DELIVER: [
      { label: 'LP Base Export', icon: '📤', onClick: handleLPBaseExport }
    ]
  };

  return (
    <div className="app-container" style={{ paddingBottom: consoleOpen ? '240px' : '40px' }}>
      <header>{project || 'No Project'}</header>
      {connected ? (
        <>
          {currentCategory === null ? (
            <div className="function-grid folder-grid">
              {categories.map(cat => (
                <button
                  key={cat}
                  className="folder-button"
                  onClick={() => setCurrentCategory(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
          ) : (
            <div className="category-view">
              <button className="back-button" onClick={() => setCurrentCategory(null)}>
                Back
              </button>
              <div className="function-grid">
                {actions[currentCategory].map(action => (
                  <button
                    key={action.label}
                    className="task-button"
                    onClick={action.onClick}
                  >
                    <span className="icon">{action.icon}</span>
                    <span>{action.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
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
