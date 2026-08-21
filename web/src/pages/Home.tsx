import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Card, StatusPill, VerdictBadge, fmtTime } from '../components/ui';
import { Link, navigate } from '../router';
import type { ResolvedTarget, Review, TicketInfo } from '../types';

const TICKET_RE = /^(?:[a-z]+:)?[a-z][a-z0-9_]*-\d+$/i;
/** A GitHub issue reference, the one ticket shape that is always available. */
const ISSUE_RE = /^(?:github:)?[\w.-]+\/[\w.-]+#\d+$/i;
const ACTIVE = new Set(['queued', 'fetching', 'reviewing']);
const keyOf = (t: ResolvedTarget): string => `${t.repo}#${t.branch}`;

export default function Home() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<TicketInfo | null>(null);
  const [targets, setTargets] = useState<ResolvedTarget[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [history, setHistory] = useState<Review[]>([]);
  const [trackers, setTrackers] = useState<string[] | null>(null);
  const [requirements, setRequirements] = useState('');
  const [manualOpen, setManualOpen] = useState(false);

  // GitHub Issues need no extra credentials, so they are always available; a
  // key like ABC-123 only means something when another tracker is configured.
  const hasKeyTracker = trackers === null || trackers.some((t) => t !== 'github');
  const manualText = requirements.trim();

  // With requirements pasted by hand no ticket is looked up, so the input only
  // has to name a branch.
  const isTicketInput = !manualText && (hasKeyTracker
    ? TICKET_RE.test(input.trim())
    : ISSUE_RE.test(input.trim()));

  const placeholder = hasKeyTracker
    ? 'ABC-123, PR URL, or repo#branch'
    : 'my-org/my-service#12, PR URL, or repo#branch';

  const loadHistory = useCallback(async () => {
    try {
      const { reviews } = await api.listReviews({ limit: 60 });
      setHistory(reviews);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    api
      .health()
      .then((h) => setTrackers(h.trackers ?? []))
      .catch(() => setTrackers(null));
  }, []);

  useEffect(() => {
    if (!history.some((r) => ACTIVE.has(r.status))) return;
    const timer = window.setInterval(() => void loadHistory(), 4000);
    return () => window.clearInterval(timer);
  }, [history, loadHistory]);

  const resolve = async (): Promise<void> => {
    const value = input.trim();
    if (!value) return;
    setError(null);
    setBusy(true);
    try {
      const res = await api.ticket(value);
      setTicket(res.ticket);
      setTargets(res.targets);
      setPicked(res.targets.map(keyOf));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const run = async (chosen?: ResolvedTarget[]): Promise<void> => {
    const value = input.trim();
    if (!value) return;
    setError(null);
    setBusy(true);
    try {
      const { reviews } = await api.createReviews({
        input: value,
        ...(chosen ? { targets: chosen } : {}),
        ...(manualText ? { requirementsText: manualText } : {}),
      });
      if (reviews.length === 1) navigate(`/review/${reviews[0]!.id}`);
      else if (reviews[0]?.ticket_key) navigate(`/ticket/${reviews[0].ticket_key}`);
      else await loadHistory();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    // A ticket always resolves to its branches first; the review is started from the
    // card, so the top button never silently launches anything.
    if (isTicketInput) await resolve();
    else await run();
  };

  const startPicked = (): Promise<void> => run(targets.filter((t) => picked.includes(keyOf(t))));

  const toggle = (k: string): void =>
    setPicked((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  const reset = (): void => {
    setTicket(null);
    setTargets([]);
    setPicked([]);
  };

  return (
    <div className="stack">
      <form className="launcher" onSubmit={(e) => void submit(e)}>
        <input
          className="launcher-input"
          placeholder={placeholder}
          value={input}
          spellCheck={false}
          onChange={(e) => {
            setInput(e.target.value);
            if (ticket) reset();
          }}
        />
        <button className="btn" type="submit" disabled={busy || !input.trim()}>
          {busy ? 'Working…' : isTicketInput ? 'Find branches' : 'Review'}
        </button>
      </form>

      <div className="manual">
        <button
          className="manual-toggle"
          type="button"
          aria-expanded={manualOpen}
          onClick={() => setManualOpen((open) => !open)}
        >
          {manualOpen ? '▾' : '▸'} Paste requirements instead
          {!manualOpen && manualText ? <span className="tag tracker">in use</span> : null}
        </button>
        {manualOpen && (
          <>
            <textarea
              className="manual-input"
              rows={6}
              spellCheck={false}
              placeholder={'What should this branch do?\nThe first line becomes the title.'}
              value={requirements}
              onChange={(e) => {
                setRequirements(e.target.value);
                if (ticket) reset();
              }}
            />
            <p className="muted manual-hint">
              Used instead of a ticket. The input above only has to name a branch: a pull request
              URL, a tree URL, or repo#branch.
            </p>
          </>
        )}
      </div>

      {error && <p className="error-line">{error}</p>}

      {ticket && (
        <Card
          title={
            <>
              {ticket.url ? (
                <a href={ticket.url} target="_blank" rel="noreferrer" className="mono">
                  {ticket.key}
                </a>
              ) : (
                <span className="mono">{ticket.key || 'Requirements'}</span>
              )}{' '}
              <span className="tag tracker">{ticket.provider}</span>{' '}
              <span className="muted">{ticket.title}</span>
            </>
          }
          actions={
            <>
              <button
                className="btn primary"
                type="button"
                onClick={() => void startPicked()}
                disabled={busy || picked.length === 0}
                title={picked.length === 0 ? 'Select at least one branch' : undefined}
              >
                {busy ? 'Starting…' : `Start review${picked.length > 1 ? ` (${picked.length})` : ''}`}
              </button>
              <button className="btn ghost" type="button" onClick={reset}>
                Clear
              </button>
            </>
          }
        >
          {targets.length === 0 ? (
            <p className="muted">No branches found for this ticket.</p>
          ) : (
            <ul className="target-list">
              {targets.map((t) => {
                const k = keyOf(t);
                return (
                  <li key={k}>
                    <label className="target">
                      <input type="checkbox" checked={picked.includes(k)} onChange={() => toggle(k)} />
                      <span className="repo">{t.repo}</span>
                      <span className="mono branch">{t.branch}</span>
                      <span className="muted mono">→ {t.baseBranch}</span>
                      {t.prNumber !== null && <span className="tag pr">PR #{t.prNumber}</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      <Card title="History">
        {history.length === 0 ? (
          <p className="muted">No reviews yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Repo</th>
                  <th>Branch</th>
                  <th>Run</th>
                  <th>Verdict</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id} className="row-link" onClick={() => navigate(`/review/${r.id}`)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      {r.ticket_key ? (
                        <Link to={`/ticket/${r.ticket_key}`} className="mono">
                          {r.ticket_key}
                        </Link>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{r.repo}</td>
                    <td className="mono truncate">{r.branch}</td>
                    <td className="mono">#{r.run_index}</td>
                    <td>
                      <VerdictBadge verdict={r.verdict} />
                    </td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                    <td className="muted nowrap">{fmtTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
