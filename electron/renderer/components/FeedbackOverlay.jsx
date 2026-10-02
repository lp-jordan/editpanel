/**
 * FeedbackOverlay — editor-facing feature-request / to-do panel.
 *
 * Opens from the "Feedback" button in the status bar. Editors file feature
 * requests here; they sync to the shared LPOS Wish List (source='editpanel'),
 * which the LPOS owner reviews in the dashboard. Because the list lives LPOS-
 * side, every EditPanel instance shows the same requests + Open/Done status —
 * the panel re-polls every 15s while open so status changes made in the
 * dashboard appear here without a restart.
 *
 * Editors submit and watch status; they don't manage state (that happens in the
 * LPOS dashboard). A centered modal, mirroring the LPOS shell Wish List.
 *
 * Props:
 *   open    — bool, whether the overlay is mounted/visible
 *   onClose — () => void
 */

const FEEDBACK_POLL_MS = 15000;

function formatFeedbackDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function FeedbackOverlay({ open, onClose }) {
  const [wishes, setWishes] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [notReady, setNotReady] = React.useState(false);

  const load = React.useCallback(async (opts = {}) => {
    if (!window.lposAPI || !window.lposAPI.listWishes) return;
    if (opts.spinner !== false) setLoading(true);
    try {
      const res = await window.lposAPI.listWishes();
      if (!res || !res.ok) {
        // "LPOS not configured" → editor hasn't signed in from Settings.
        if (res && /not configured|not signed in/i.test(res.error || '')) {
          setNotReady(true);
        } else {
          if (res && res.error) console.warn('[feedback] list failed:', res.error);
          setError('Couldn’t load feedback.');
        }
        return;
      }
      setNotReady(false);
      setError(null);
      setWishes((res.data && res.data.wishes) || []);
    } catch (err) {
      console.warn('[feedback] list error:', err);
      setError('Couldn’t load feedback.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load on open + poll while open so dashboard status changes flow through.
  React.useEffect(() => {
    if (!open) return undefined;
    load();
    const timer = setInterval(() => load({ spinner: false }), FEEDBACK_POLL_MS);
    return () => clearInterval(timer);
  }, [open, load]);

  // Esc closes.
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await window.lposAPI.createWish({ title: t, description: description.trim() || undefined });
      if (!res || !res.ok) {
        // Plain message on screen; the raw reason goes to the devtools console.
        if (res && res.error) console.warn('[feedback] submit failed:', res.error);
        setError('Couldn’t send. Try again.');
        return;
      }
      setTitle('');
      setDescription('');
      await load({ spinner: false });
    } catch (err) {
      console.warn('[feedback] submit error:', err);
      setError('Couldn’t send. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const list = wishes || [];
  const openItems = list.filter((w) => !w.completed);
  const doneItems = list.filter((w) => w.completed);

  return (
    <div
      className="feedback-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Feedback"
    >
      <div className="feedback-panel" onClick={(e) => e.stopPropagation()}>
        <div className="feedback-header">
          <div className="feedback-header-title">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span>Feedback</span>
          </div>
          <button type="button" className="feedback-close" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form className="feedback-form" onSubmit={handleSubmit}>
          <input
            className="feedback-input"
            type="text"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            disabled={notReady}
            required
          />
          <textarea
            className="feedback-textarea"
            placeholder="Details (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={2000}
            disabled={notReady}
          />
          <button type="submit" className="btn feedback-submit" disabled={submitting || notReady || !title.trim()}>
            {submitting ? 'Sending…' : 'Send'}
          </button>
        </form>

        {notReady && (
          <p className="feedback-notice">
            Sign in to LPOS in Settings to send and see feedback.
          </p>
        )}
        {error && <p className="feedback-error">{error}</p>}

        <div className="feedback-list">
          {loading && wishes === null && <p className="feedback-empty">Loading…</p>}

          {!loading && wishes !== null && openItems.length === 0 && doneItems.length === 0 && (
            <p className="feedback-empty">No feedback yet.</p>
          )}

          {openItems.length > 0 && (
            <section>
              <p className="feedback-section-label">Open</p>
              {openItems.map((w) => <FeedbackRow key={w.wishId} wish={w} />)}
            </section>
          )}

          {doneItems.length > 0 && (
            <section>
              <p className="feedback-section-label">Done</p>
              {doneItems.map((w) => <FeedbackRow key={w.wishId} wish={w} />)}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function FeedbackRow({ wish }) {
  const from = wish.source === 'editpanel' && wish.sourceInstance
    ? `${wish.submittedByName} · ${wish.sourceInstance}`
    : wish.submittedByName;
  return (
    <div className={`feedback-row${wish.completed ? ' feedback-row--done' : ''}`}>
      <div className="feedback-row-body">
        <p className="feedback-row-title">{wish.title}</p>
        {wish.description && <p className="feedback-row-desc">{wish.description}</p>}
        <p className="feedback-row-meta">
          {from} · {formatFeedbackDate(wish.createdAt)}
        </p>
      </div>
    </div>
  );
}
