const { useState } = React;

function SlideoutConsole({ log }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`slideout-console ${open ? 'open' : ''}`}>
      <button className="toggle-button" onClick={() => setOpen(!open)}>
        {open ? 'Hide Console' : 'Show Console'}
      </button>
      <div className="console-content">
        <pre>{log.join('\n')}</pre>
      </div>
    </div>
  );
}

