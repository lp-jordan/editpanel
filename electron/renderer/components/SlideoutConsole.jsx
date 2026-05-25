function SlideoutConsole({ log, open }) {
  return (
    <div className={`slideout-console ${open ? 'open' : ''}`}>
      <div className="console-content">
        <pre>{log.join('\n')}</pre>
      </div>
    </div>
  );
}

