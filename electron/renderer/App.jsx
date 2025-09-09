const { useEffect, useState } = React;

function App() {
  const [project, setProject] = useState('');
  const [log, setLog] = useState([]);

  const appendLog = msg => {
    setLog(prev => {
      const next = [...prev, msg];
      return next.slice(-20);
    });
  };

  useEffect(() => {
    let active = true;

    window.leaderpassAPI
      .call('context')
      .then(res => {
        if (!active) return;
        const ctx = res.data || res;
        setProject(ctx.project || '');
        appendLog(`Context: ${JSON.stringify(ctx)}`);
      })
      .catch(err => {
        appendLog(`Context error: ${err?.error || err}`);
      });

    const unsubscribeStatus = window.electronAPI.onHelperStatus(status => {
      const msg = `Status: ${status.code}${status.error ? ' - ' + status.error : ''}`;
      appendLog(msg);
      if (status.data && status.data.project) {
        setProject(status.data.project);
      }
    });

    const unsubscribeMessage = window.electronAPI.onHelperMessage(payload => {
      const entry = typeof payload === 'string' ? payload : JSON.stringify(payload);
      appendLog(entry);
    });

    return () => {
      active = false;
      unsubscribeStatus();
      unsubscribeMessage();
    };
  }, []);

  const logAction = action => {
    appendLog(`${action} clicked`);
  };

  return (
    <div className="app-container">
      <header>{project || 'No Project'}</header>
      <div className="button-grid">
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
      <div className="log">
        <pre>{log.join('\n')}</pre>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
