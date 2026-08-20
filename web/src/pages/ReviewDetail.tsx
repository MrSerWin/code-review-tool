import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  Card,
  RequirementStatusTag,
  SeverityTag,
  StatusPill,
  fmtDuration,
  fmtTime,
} from '../components/ui';
import { Link, navigate } from '../router';
import type { Finding, LogLine, ReviewDetailPayload, Severity, SseEvent } from '../types';

const ACTIVE = new Set(['queued', 'fetching', 'reviewing']);
const SEVERITY_ORDER: Severity[] = ['blocker', 'major', 'minor', 'nit'];

const BANNER: Record<string, string> = {
  approve: 'APPROVED — safe to merge',
  changes_requested: 'CHANGES REQUESTED — do not merge yet',
  blocked: 'BLOCKED — serious problems found',
};

export default function ReviewDetail({ id }: { id: number }) {
  const [data, setData] = useState<ReviewDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LogLine[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await api.review(id);
      setData(payload);
      setLive(payload.logs);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const source = new EventSource(api.eventsUrl(id));
    source.onmessage = (ev) => {
      let evt: SseEvent;
      try {
        evt = JSON.parse(ev.data) as SseEvent;
      } catch {
        return;
      }
      if (evt.type === 'log') {
        setLive((prev) => [
          ...prev.slice(-800),
          {
            id: -Date.now() - prev.length,
            review_id: id,
            ts: evt.ts ?? new Date().toISOString(),
            level: (evt.level as LogLine['level']) ?? 'info',
            message: evt.message ?? '',
          },
        ]);
      } else if (evt.type === 'status') {
        setData((prev) => (prev ? { ...prev, review: { ...prev.review, status: evt.status } } : prev));
        // A terminal status carries the verdict and findings; refetch them.
        if (!ACTIVE.has(evt.status)) void load();
      } else if (evt.type === 'done') {
        void load();
      }
    };
    source.onerror = () => {
      /* EventSource retries on its own */
    };
    return () => source.close();
  }, [id, load]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [live.length]);

  if (error) return <p className="error-line">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const { review, requirements, findings } = data;
  const running = ACTIVE.has(review.status);

  const rerun = async (): Promise<void> => {
    try {
      const { review: next } = await api.rerun(review.id);
      navigate(`/review/${next.id}`);
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  const cancel = async (): Promise<void> => {
    try {
      await api.cancel(review.id);
      await load();
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  const copyReport = async (): Promise<void> => {
    try {
      const md = await api.report(review.id);
      await navigator.clipboard.writeText(md);
      setNotice('Report copied to clipboard');
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  const remove = async (): Promise<void> => {
    if (!window.confirm('Delete this review and its report?')) return;
    try {
      await api.remove(review.id);
      navigate('/');
    } catch (err) {
      setNotice((err as Error).message);
    }
  };

  const grouped = SEVERITY_ORDER.map((sev) => ({
    severity: sev,
    items: findings.filter((f) => f.severity === sev),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="stack">
      <div className={`banner verdict-${review.verdict ?? 'none'}`}>
        <div className="banner-main">
          <span className="banner-title">
            {review.verdict ? BANNER[review.verdict] : running ? 'Review in progress' : `Run ${review.status}`}
          </span>
          <span className="banner-sub mono">
            {review.repo} · {review.branch} · run #{review.run_index}
          </span>
        </div>
        <div className="banner-actions">
          <StatusPill status={review.status} />
          {running ? (
            <button className="btn ghost" type="button" onClick={() => void cancel()}>
              Cancel
            </button>
          ) : (
            <button className="btn" type="button" onClick={() => void rerun()}>
              Re-run
            </button>
          )}
          <a className="btn" href={api.reportUrl(review.id)} download={`review-${review.id}.md`}>
            Download
          </a>
          <button className="btn" type="button" onClick={() => void copyReport()}>
            Copy
          </button>
          <button className="btn danger" type="button" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </div>

      {notice && <p className="notice-line">{notice}</p>}
      {review.error && <p className="error-line">{review.error}</p>}

      <div className="split">
        <Card title="Run">
          <dl className="meta">
            <dt>Ticket</dt>
            <dd>
              {review.ticket_key ? (
                <>
                  <Link to={`/ticket/${review.ticket_key}`} className="mono">
                    {review.ticket_key}
                  </Link>{' '}
                  <span className="muted">{review.ticket_title}</span>
                </>
              ) : (
                <span className="muted">—</span>
              )}
            </dd>
            <dt>Branch</dt>
            <dd className="mono">
              {review.branch} <span className="muted">→ {review.base_branch}</span>
            </dd>
            <dt>Commits</dt>
            <dd className="mono">
              {review.head_sha ? review.head_sha.slice(0, 7) : '—'} /{' '}
              {review.base_sha ? review.base_sha.slice(0, 7) : '—'}
            </dd>
            <dt>Diff</dt>
            <dd className="mono">
              {review.files_changed ?? 0} files <span className="add">+{review.additions ?? 0}</span>{' '}
              <span className="del">-{review.deletions ?? 0}</span>
            </dd>
            <dt>Requirements</dt>
            <dd className="mono">
              {review.requirements_met ?? 0}/{review.requirements_total ?? 0} met
            </dd>
            <dt>Model</dt>
            <dd className="mono">{review.model ?? '—'}</dd>
            <dt>Started</dt>
            <dd className="muted">
              {fmtTime(review.started_at ?? review.created_at)} ·{' '}
              {fmtDuration(review.started_at, review.finished_at)}
            </dd>
          </dl>
          {review.summary && <p className="summary">{review.summary}</p>}
        </Card>

        <Card title={`Log${running ? ' · live' : ''}`}>
          <div className="log">
            {live.length === 0 && <div className="muted">No log output yet.</div>}
            {live.map((l) => (
              <div key={l.id} className={`log-line log-${l.level}`}>
                <span className="log-ts">{(l.ts ?? '').slice(11, 19)}</span>
                <span className="log-msg">{l.message}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </Card>
      </div>

      <Card title="Ticket requirements">
        {requirements.length === 0 ? (
          <p className="muted">No requirements recorded.</p>
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Requirement</th>
                  <th>Status</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {requirements.map((r, i) => (
                  <tr key={r.id}>
                    <td className="num mono">{i + 1}</td>
                    <td>{r.text}</td>
                    <td>
                      <RequirementStatusTag status={r.status} />
                    </td>
                    <td className="mono muted">{r.evidence ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={`Findings (${findings.length})`}>
        {findings.length === 0 ? (
          <p className="muted">No issues found.</p>
        ) : (
          grouped.map((group) => (
            <div key={group.severity} className="finding-group">
              <h3 className={`group-head sev-${group.severity}`}>
                {group.severity} · {group.items.length}
              </h3>
              {group.items.map((f) => (
                <FindingCard key={f.id} finding={f} />
              ))}
            </div>
          ))
        )}
      </Card>
    </div>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  const location = finding.file
    ? `${finding.file}${finding.line !== null ? `:${finding.line}` : ''}`
    : null;
  return (
    <article className={`finding sev-border-${finding.severity}`}>
      <header>
        <SeverityTag severity={finding.severity} />
        {finding.category && <span className="tag cat">{finding.category}</span>}
        <h4>{finding.title}</h4>
      </header>
      {location && <div className="mono loc">{location}</div>}
      <p>{finding.problem}</p>
      {finding.why && (
        <p>
          <span className="label">Why it matters:</span> {finding.why}
        </p>
      )}
      {finding.suggestion && (
        <p>
          <span className="label">Suggested fix:</span> {finding.suggestion}
        </p>
      )}
      {finding.snippet && <pre className="snippet">{finding.snippet}</pre>}
    </article>
  );
}
