import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Card, StatusPill, VerdictBadge, fmtTime } from '../components/ui';
import { navigate } from '../router';
import type { Review } from '../types';

const ACTIVE = new Set(['queued', 'fetching', 'reviewing']);

export default function TicketView({ ticketKey }: { ticketKey: string }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { reviews: rows } = await api.listReviews({ ticket: ticketKey, limit: 200 });
      setReviews(rows);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [ticketKey]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!reviews.some((r) => ACTIVE.has(r.status))) return;
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [reviews, load]);

  if (error) return <p className="error-line">{error}</p>;

  const groups = new Map<string, Review[]>();
  for (const r of reviews) {
    const key = `${r.repo}#${r.branch}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const title = reviews[0]?.ticket_title ?? '';
  const url = reviews[0]?.ticket_url ?? null;

  return (
    <div className="stack">
      <header className="page-head">
        <h1 className="mono">{ticketKey}</h1>
        <p className="muted">{title}</p>
        {url && (
          <a className="btn ghost" href={url} target="_blank" rel="noreferrer">
            Open ticket
          </a>
        )}
      </header>

      {groups.size === 0 && <p className="muted">No runs for this ticket.</p>}

      {[...groups.entries()].map(([key, rows]) => (
        <Card key={key} title={<span className="mono">{key}</span>}>
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Verdict</th>
                  <th>Status</th>
                  <th>Reqs</th>
                  <th>Blockers</th>
                  <th>Diff</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="row-link" onClick={() => navigate(`/review/${r.id}`)}>
                    <td className="mono">#{r.run_index}</td>
                    <td>
                      <VerdictBadge verdict={r.verdict} />
                    </td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                    <td className="mono">
                      {r.requirements_met ?? 0}/{r.requirements_total ?? 0}
                    </td>
                    <td className="mono">{r.blocking_count ?? 0}</td>
                    <td className="mono nowrap">
                      {r.files_changed ?? 0}f <span className="add">+{r.additions ?? 0}</span>{' '}
                      <span className="del">-{r.deletions ?? 0}</span>
                    </td>
                    <td className="muted nowrap">{fmtTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
    </div>
  );
}
