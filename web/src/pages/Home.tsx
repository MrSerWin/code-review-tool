import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Card, StatusPill, VerdictBadge, fmtTime } from '../components/ui';
import { Link, navigate } from '../router';
import type { ResolvedTarget, Review, TicketInfo } from '../types';

const TICKET_RE = /^[a-z]{2,6}-\d+$/i;
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
      const { reviews } = await api.createReviews(
        chosen ? { input: value, targets: chosen } : { input: value },
      );
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
    if (TICKET_RE.test(input.trim()) && !ticket) await resolve();
    else await run(ticket ? targets.filter((t) => picked.includes(keyOf(t))) : undefined);
  };

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
          placeholder="ABC-123, PR URL, or repo#branch"
          value={input}
          spellCheck={false}
          onChange={(e) => {
            setInput(e.target.value);
            if (ticket) reset();
          }}
        />
        <button className="btn primary" type="submit" disabled={busy || !input.trim()}>
          {busy ? 'Working…' : ticket ? 'Run review' : 'Review'}
        </button>
      </form>

      {error && <p className="error-line">{error}</p>}

      {ticket && (
        <Card
          title={
            <>
              <a href={ticket.url} target="_blank" rel="noreferrer" className="mono">
                {ticket.key}
              </a>{' '}
              <span className="muted">{ticket.title}</span>
            </>
          }
          actions={
            <button className="btn ghost" type="button" onClick={reset}>
              Clear
            </button>
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
