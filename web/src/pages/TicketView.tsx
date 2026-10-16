import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { BranchLink, Card, PrLink, StatusPill, VerdictBadge, fmtTime } from '../components/ui';
import { Link, navigate } from '../router';
import { openTicketLabel, openTicketTitle } from '../tickets';
import type { Review } from '../types';

const ACTIVE = new Set(['queued', 'fetching', 'reviewing']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `# ABC-123: Add export` -> `Add export`, as the history shows it. */
function cleanTitle(title: string, key: string): string {
  const text = title.trim().replace(/^#+\s*/, '');
  const leadingKey = new RegExp(`^\\[?${escapeRegExp(key)}\\]?(?![A-Za-z0-9])\\s*[:\\-–—]?\\s*`, 'i');
  return text.replace(leadingKey, '').trim();
}

export default function TicketView({ ticketKey }: { ticketKey: string }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // By group, not ticket_key: runs with pasted requirements whose branch name
      // carries the key belong here too, and so does a plain repo#branch group.
      const { reviews: rows } = await api.listReviews({ group: ticketKey, limit: 200 });
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
  // Rows are newest first: the newest non-empty title and link win.
  const rawTitle = reviews.find((r) => r.ticket_title?.trim())?.ticket_title ?? '';
  const title = rawTitle ? cleanTitle(rawTitle, ticketKey) : '';
  const url = reviews.find((r) => r.ticket_url?.trim())?.ticket_url ?? null;

  return (
    <div className="stack">
      <header className="page-head">
        <h1 className="mono">{ticketKey}</h1>
        <p className="muted">{title}</p>
        {url && (
          <a
            className="link-btn"
            href={url}
            target="_blank"
            rel="noreferrer"
            title={openTicketTitle(url, ticketKey)}
          >
            {openTicketLabel(url)}
            <span className="link-arrow" aria-hidden="true">↗</span>
          </a>
        )}
      </header>

      {groups.size === 0 && <p className="muted">No runs for this ticket.</p>}

      {[...groups.entries()].map(([key, rows]) => (
        <Card key={key} title={<BranchTitle rows={rows} />}>
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
                    <td className="mono" onClick={(e) => e.stopPropagation()}>
                      <Link to={`/review/${r.id}`}>#{r.run_index}</Link>
                    </td>
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

/** `repo · branch ↗ · PR #12 ↗`: one branch of the ticket, with its GitHub pages. Rows are newest first. */
function BranchTitle({ rows }: { rows: Review[] }) {
  const newest = rows[0]!;
  const withPr = rows.find((r) => r.links?.pr);
  const local = newest.source === 'local';
  return (
    <span className="branch-title">
      <span className="branch-repo">{newest.repo}</span>
      <BranchLink branch={newest.branch} href={newest.links?.branch} local={local} />
      {local && <span className="tag local">local</span>}
      {withPr?.links?.pr && <PrLink href={withPr.links.pr} number={withPr.pr_number} />}
    </span>
  );
}
