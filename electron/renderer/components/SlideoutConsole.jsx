function SlideoutConsole({ log, open, onToggle }) {
  return (
    <div className={`slideout-console ${open ? 'open' : ''}`}>
      <button className="toggle-button" onClick={() => onToggle(!open)}>
        {open ? 'Hide Console' : 'Show Console'}
      </button>
      <div className="console-content">
        <pre>{log.join('\n')}</pre>
      </div>
    </div>
  );
}

