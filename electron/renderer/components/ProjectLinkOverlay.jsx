/**
 * ProjectLinkOverlay — which LPOS projects the open Resolve project feeds.
 *
 * Opened by clicking the Resolve project name in the status bar. One Resolve
 * project can feed several LPOS projects (Elevate Pools → two). The link is
 * kept in LPOS (core.ep_project_links via /api/ep/project-links), so every
 * machine and the /editing dashboard see the same one: the dashboard card
 * links to these projects and counts uploads across them, and the export
 * picker starts on the first one.
 *
 * Before anything is linked, the project cut-through's slate uses is ticked.
 *
 * Props: open, onClose, resolveProject, lposReady, onLog, onSaved(projects)
 */
function ProjectLinkOverlay({ open, onClose, resolveProject, lposReady, onLog, onSaved }) {
  const [projects, setProjects] = React.useState([]);
  const [selected, setSelected] = React.useState([]);   // project ids, in pick order
  const [query, setQuery]       = React.useState('');
  const [loading, setLoading]   = React.useState(false);
  const [error, setError]       = React.useState(null);
  const [saving, setSaving]     = React.useState(false);

  const load = React.useCallback(async () => {
    if (!window.lposAPI?.listProjects || !resolveProject) return;
    setLoading(true);
    setError(null);
    try {
      const [list, links] = await Promise.all([
        window.lposAPI.listProjects(),
        window.lposAPI.getProjectLinks(resolveProject),
      ]);
      if (!list?.ok) throw new Error(list?.error || 'Could not load projects');
      if (!links?.ok) throw new Error(links?.error || 'Could not load links');
      setProjects(list.data?.projects || []);
      const linked = (links.data?.projects || []).map((p) => p.projectId);
      const suggested = links.data?.suggested;
      setSelected(linked.length ? linked : suggested ? [suggested] : []);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [resolveProject]);

  React.useEffect(() => {
    if (!open) return;
    setQuery('');
    setSaving(false);
    load();
  }, [open, load]);

  const grouped = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map();
    for (const p of projects) {
      if (p.archived && !selected.includes(p.projectId)) continue;
      const name = (p.name || '').toLowerCase();
      const client = (p.clientName || '').toLowerCase();
      if (q && !name.includes(q) && !client.includes(q)) continue;
      const key = p.clientName || 'Unassigned';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [projects, query, selected]);

  const toggle = (id) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const nameOf = (id) => projects.find((p) => p.projectId === id)?.name || id;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await window.lposAPI.setProjectLinks(resolveProject, selected);
      if (!res?.ok) throw new Error(res?.error || 'Could not save');
      const linked = res.data?.projects || [];
      onLog?.(linked.length
        ? `[project] "${resolveProject}" linked to ${linked.map((p) => p.name).join(', ')}`
        : `[project] "${resolveProject}" unlinked from LPOS`);
      onSaved?.(linked);
      onClose();
    } catch (err) {
      setError(err?.message || String(err));
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="tool-overlay" role="dialog" aria-label="LPOS projects">
      <header className="tool-header">
        <h2 className="tool-title">{resolveProject}</h2>
        <button className="tool-close" onClick={onClose} disabled={saving} aria-label="Close" title="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </header>

      <div className="tool-body tool-body--form">
        {!lposReady && <p className="notice error">LPOS not connected.</p>}
        {error && (
          <div className="notice error" title={error}>
            <span>{error}</span>
            <button type="button" className="btn ghost small notice-action" onClick={load}>Try again</button>
          </div>
        )}
        <div className="atem-dest-section">
          <p className="atem-field-label">LPOS projects</p>
          {selected.length > 0 && (
            <p className="hint">{selected.map(nameOf).join(' · ')}</p>
          )}
          {loading && <p className="hint"><span className="spinner" /> Loading…</p>}
          {!loading && projects.length > 0 && (
            <div className="export-project-search">
              <input
                type="search"
                className="export-project-search-input"
                placeholder="Search projects or clients…"
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
                }}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          )}
          {!loading && grouped.length > 0 && (
            <div className="export-project-list">
              {grouped.map(([client, list]) => (
                <div key={client} className="export-project-group">
                  <p className="export-client-name">{client}</p>
                  {list.map((p) => (
                    <label key={p.projectId} className={`export-project-row${selected.includes(p.projectId) ? ' selected' : ''}`}>
                      <input
                        type="checkbox"
                        className="export-project-radio"
                        checked={selected.includes(p.projectId)}
                        onChange={() => toggle(p.projectId)}
                      />
                      <span className="export-project-row-name">{p.name}</span>
                      {p.phase && <span className="export-project-row-meta">{p.phase}</span>}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
          {!loading && !error && projects.length > 0 && grouped.length === 0 && (
            <p className="hint">No projects match “{query.trim()}”.</p>
          )}
        </div>
      </div>

      <footer className="tool-footer tool-footer--form">
        <button className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={saving || loading || !lposReady}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </footer>
    </div>
  );
}
