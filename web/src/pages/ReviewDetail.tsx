import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import PreviewPanel from '../components/PreviewPanel';
import {
  Card,
  RequirementStatusTag,
  SeverityTag,
  StatusPill,
  fmtDuration,
  fmtTime,
} from '../components/ui';
import { Link, navigate } from '../router';
import type {
  Finding,
  LogLine,
  Observation,
  ReviewDetailPayload,
  RunComparison,
  Severity,
  SseEvent,
} from '../types';

const ACTIVE = new Set(['queued', 'fetching', 'reviewing']);
const SEVERITY_ORDER: Severity[] = ['blocker', 'major', 'minor', 'nit'];

const BANNER: Record<string, string> = {
  approve: 'APPROVED — safe to merge',
  changes_requested: 'CHANGES REQUESTED — do not merge yet',
  blocked: 'BLOCKED — serious problems found',
};

/** The lens passes the runner is expected to emit progress for, in display order. */
const LENSES = ['correctness', 'security', 'tests', 'contracts', 'regressions'] as const;

type LensState = 'pending' | 'running' | 'done' | 'failed';
interface LensProgress {
  name: string;
  state: LensState;
  note: string;
}

// Matches run-log lines such as `lens correctness: started` or
// `lens correctness: 2 findings, 1 observation`.
const LENS_RE = /^\s*lens\s+([a-z][\w-]*)\s*:\s*(.+?)\s*$/i;

/**
 * Best-effort read of per-lens progress out of the run log. Returns null when the
 * log carries no recognisable lens lines, so the caller can fall back to the raw log.
 */
function deriveLensProgress(logs: LogLine[]): LensProgress[] | null {
  const seen = new Map<string, { state: LensState; note: string }>();
  for (const line of logs) {
    const match = LENS_RE.exec(String(line?.message ?? ''));
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    const rest = match[2]!;
    const lower = rest.toLowerCase();
    if (lower.startsWith('start')) seen.set(name, { state: 'running', note: '' });
    else if (lower.includes('fail') || lower.includes('error')) seen.set(name, { state: 'failed', note: rest });
    else seen.set(name, { state: 'done', note: rest });
  }
  if (seen.size === 0) return null;

  const known: LensProgress[] = LENSES.map((name) => ({
    name,
    state: seen.get(name)?.state ?? 'pending',
    note: seen.get(name)?.note ?? '',
  }));
  // An unexpected lens name still deserves a chip rather than being dropped.
  const extra: LensProgress[] = [...seen.entries()]
    .filter(([name]) => !(LENSES as readonly string[]).includes(name))
    .map(([name, v]) => ({ name, ...v }));
  return [...known, ...extra];
}

export default function ReviewDetail({ id }: { id: number }) {
  const [data, setData] = useState<ReviewDetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LogLine[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  // name -> label, so the run details can name the reviewer the way the picker does.
  const [reviewerLabels, setReviewerLabels] = useState<Record<string, string>>({});
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
    // Labels only, so the cheap health payload is enough: /api/reviewers
    // would also ask every CLI for its model list.
    api
      .health()
      .then(({ reviewers }) => {
        setReviewerLabels(Object.fromEntries((reviewers ?? []).map((r) => [r.name, r.label])));
      })
      .catch(() => setReviewerLabels({}));
  }, []);

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

  const lenses = useMemo(() => deriveLensProgress(live), [live]);

  if (error) return <p className="error-line">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const { review, requirements, findings, comparison } = data;
  const observations = data.observations ?? [];
  const running = ACTIVE.has(review.status);
  const finished = review.status === 'done';
  const unmet = requirements.filter((r) => r.status === 'missing' || r.status === 'partial');

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
                  <Link to={`/ticket/${encodeURIComponent(review.ticket_key)}`} className="mono">
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
            <dt>Reviewer</dt>
            <dd>
              {review.reviewer ? (reviewerLabels[review.reviewer] ?? review.reviewer) : '—'}
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
          {lenses && <LensChips lenses={lenses} />}
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

      <PreviewPanel reviewId={review.id} repo={review.repo} branch={review.branch} />

      {comparison && finished && (
        <Card title={`Changes since run #${comparison.previousRunIndex}`}>
          <RunComparisonView comparison={comparison} />
        </Card>
      )}

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
          review.verdict && review.verdict !== 'approve' ? (
            <div className="empty-note">
              <p>
                No individual defects were raised, yet the verdict is{' '}
                <strong>{BANNER[review.verdict]?.split('—')[0]?.trim().toLowerCase() ?? review.verdict}</strong>.
              </p>
              <p className="muted">
                {unmet.length > 0
                  ? `The blocker is requirement coverage: ${unmet.length} of ${requirements.length} ticket requirements are not fully met. Fix those rows above — they are the work left to do.`
                  : 'Nothing was pinned to a specific line. Check the run summary and the log below for what the review objected to.'}
              </p>
            </div>
          ) : (
            <p className="muted">No issues found.</p>
          )
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

      <Card title={`Suggestions (non-blocking) · ${observations.length}`}>
        {observations.length === 0 ? (
          <p className="muted">
            {finished
              ? 'No suggestions — the review had nothing non-blocking to add.'
              : running
                ? 'Suggestions appear once the review finishes.'
                : 'No suggestions were recorded for this run.'}
          </p>
        ) : (
          <div className="observation-list">
            {observations.map((o) => (
              <ObservationCard key={o.id} observation={o} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function RunComparisonView({ comparison }: { comparison: RunComparison }) {
  const { resolved, new: added, persistent } = comparison;
  if (resolved.length === 0 && added.length === 0 && persistent.length === 0) {
    return <p className="muted">No findings in either run.</p>;
  }
  return (
    <div className="comparison">
      {resolved.length > 0 && (
        <ComparisonGroup
          label="Resolved"
          tone="resolved"
          items={resolved}
          emptyNote="Nothing from the previous run was cleared."
        />
      )}
      {added.length > 0 && (
        <ComparisonGroup label="New" tone="new" items={added} />
      )}
      {persistent.length > 0 && (
        <ComparisonGroup label="Still open" tone="persistent" items={persistent} />
      )}
    </div>
  );
}

function ComparisonGroup({
  label,
  tone,
  items,
  emptyNote,
}: {
  label: string;
  tone: 'resolved' | 'new' | 'persistent';
  items: RunComparison['resolved'];
  emptyNote?: string;
}) {
  if (items.length === 0) {
    return emptyNote ? <p className="muted">{emptyNote}</p> : null;
  }
  return (
    <div className={`comparison-group comparison-${tone}`}>
      <h3 className="group-head">
        {label} · {items.length}
      </h3>
      <ul className="comparison-list">
        {items.map((item) => {
          const loc = item.file
            ? `${item.file}${item.line !== null ? `:${item.line}` : ''}`
            : null;
          return (
            <li key={`${item.severity}|${loc ?? ''}|${item.title}`}>
              <SeverityTag severity={item.severity} />
              <span className="comparison-title">{item.title}</span>
              {loc && <span className="mono muted comparison-loc">{loc}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function LensChips({ lenses }: { lenses: LensProgress[] }) {
  return (
    <div className="lens-row" role="list" aria-label="Lens progress">
      {lenses.map((l) => (
        <span key={l.name} role="listitem" className={`lens lens-${l.state}`} title={l.note || l.state}>
          <span className="lens-dot" aria-hidden="true" />
          <span className="lens-name">{l.name}</span>
          {l.note && <span className="lens-note">{l.note}</span>}
        </span>
      ))}
    </div>
  );
}

function ObservationCard({ observation }: { observation: Observation }) {
  const location = observation.file
    ? `${observation.file}${observation.line !== null ? `:${observation.line}` : ''}`
    : null;
  return (
    <article className="observation">
      {location && <div className="mono loc">{location}</div>}
      <p className="observation-note">{observation.note}</p>
      {observation.rationale && <p className="observation-why muted">{observation.rationale}</p>}
    </article>
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
