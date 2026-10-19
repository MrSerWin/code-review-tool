import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { BranchLink, Card, PrLink, StatusPill, VerdictBadge, fmtTime } from '../components/ui';
import { Link, navigate } from '../router';
import { openTicketLabel, openTicketTitle } from '../tickets';
import type {
  AnchorStatus,
  Coverage,
  CoverageStatus,
  GroupBranch,
  ParentReason,
  Review,
  ReviewerInfo,
  TicketGroupPayload,
} from '../types';

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

const PARENT_REASON: Record<ParentReason, string> = {
  pr: 'PR base',
  detected: 'detected',
  default: 'default branch',
  user: 'set by hand',
  stored: 'from an earlier run',
};

const COVERAGE_LABEL: Record<CoverageStatus, string> = { covered: 'covered', partial: 'partial', missing: 'missing' };
const COVERAGE_TAG: Record<CoverageStatus, string> = { covered: 'req-met', partial: 'req-partial', missing: 'req-missing' };

const ANCHOR_WARNING: Partial<Record<AnchorStatus, string>> = {
  missing_path: 'path not found',
  line_out_of_range: 'line out of range',
  off_diff: 'outside this branch’s diff',
};

export default function TicketView({ ticketKey }: { ticketKey: string }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [ticket, setTicket] = useState<TicketGroupPayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      // By group, not ticket_key: runs with pasted requirements whose branch name
      // carries the key belong here too, and so does a plain repo#branch group.
      const [{ reviews: rows }, group] = await Promise.all([
        api.listReviews({ group: ticketKey, limit: 200 }),
        // A plain repo#branch group has no ticket group: 404.
        api.ticketGroup(ticketKey).catch(() => null),
      ]);
      setReviews(rows);
      setTicket(group);
      setLoaded(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [ticketKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const running = reviews.some((r) => ACTIVE.has(r.status));
  const live = running || Boolean(ticket?.coverage_pending);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  const act = async (what: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const done = await what();
      if (done) setNotice(done);
      await load();
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="error-line">{error}</p>;

  // Rows are newest first: the newest non-empty title and link win.
  const rawTitle = ticket?.group.title ?? reviews.find((r) => r.ticket_title?.trim())?.ticket_title ?? '';
  const title = rawTitle ? cleanTitle(rawTitle, ticketKey) : '';
  const url = ticket?.group.ticketUrl ?? reviews.find((r) => r.ticket_url?.trim())?.ticket_url ?? null;

  return (
    <div className="stack">
      <header className="page-head">
        <h1 className="mono">{ticketKey}</h1>
        <p className="muted">{title}</p>
        {url && (
          <a className="link-btn" href={url} target="_blank" rel="noreferrer" title={openTicketTitle(url, ticketKey)}>
            {openTicketLabel(url)}
            <span className="link-arrow" aria-hidden="true">↗</span>
          </a>
        )}
      </header>

      {notice && <p className="notice-line">{notice}</p>}

      {ticket && (
        <>
          <TicketActions
            ticketKey={ticketKey}
            busy={busy}
            running={running}
            onReview={(body) =>
              act(async () => {
                const out = await api.reviewTicket(ticketKey, body);
                const notes = [...(out.notes ?? []), ...(out.resolve_warning ? [out.resolve_warning] : [])];
                return `Queued ${out.reviews.length} branch review(s).${notes.length ? ` ${notes.join(' ')}` : ''}`;
              })
            }
            onRecompute={() =>
              act(async () => {
                const out = await api.recomputeCoverage(ticketKey);
                return out.started ? 'Coverage pass started.' : 'A coverage pass is already running; another one follows it.';
              })
            }
            onDetect={() =>
              act(async () => {
                await api.detectParents(ticketKey, true);
                return 'Parents detected again; parents set by hand were reset.';
              })
            }
          />
          <ChainsCard
            ticket={ticket}
            busy={busy}
            onParent={(repo, branch, parent) =>
              act(async () => {
                await api.setBranchParent(ticketKey, { repo, branch, parent });
                return null;
              })
            }
            onOrder={(repo, branches) =>
              act(async () => {
                await api.setChainOrder(ticketKey, { repo, branches });
                return null;
              })
            }
          />
          <CoverageCard ticketKey={ticketKey} ticket={ticket} />
        </>
      )}

      {loaded && !ticket && reviews.length > 0 && (
        <p className="muted">A single branch without a ticket: no ticket group, no coverage.</p>
      )}

      <RunsSection reviews={reviews} />
    </div>
  );
}

function TicketActions({
  ticketKey,
  busy,
  running,
  onReview,
  onRecompute,
  onDetect,
}: {
  ticketKey: string;
  busy: boolean;
  running: boolean;
  onReview: (body: { reviewer?: string; model?: string; requirementsText?: string }) => void;
  onRecompute: () => void;
  onDetect: () => void;
}) {
  const [reviewers, setReviewers] = useState<ReviewerInfo[]>([]);
  const [reviewer, setReviewer] = useState('');
  const [model, setModel] = useState('');
  const [extra, setExtra] = useState('');
  const [showExtra, setShowExtra] = useState(false);

  useEffect(() => {
    api
      .reviewers()
      .then(({ reviewers: list, defaultReviewer }) => {
        setReviewers(list ?? []);
        setReviewer(defaultReviewer);
        setModel(list.find((r) => r.name === defaultReviewer)?.defaultModel ?? '');
      })
      .catch(() => setReviewers([]));
  }, []);

  const info = reviewers.find((r) => r.name === reviewer);
  return (
    <Card title="Review this ticket">
      <p className="muted ticket-hint">
        Every branch is reviewed against its parent in the chains below, parents first. Each gets a code verdict from
        its own findings; once all are done, one coverage pass checks the ticket requirements across all branches.
      </p>
      <form
        className="reviewer-row"
        onSubmit={(e) => {
          e.preventDefault();
          onReview({
            ...(reviewer ? { reviewer } : {}),
            ...(model.trim() ? { model: model.trim() } : {}),
            ...(extra.trim() ? { requirementsText: extra.trim() } : {}),
          });
        }}
      >
        {reviewers.length > 0 && (
          <>
            <label className="reviewer-field">
              <span className="label">Reviewer</span>
              <select
                className="reviewer-select"
                value={reviewer}
                onChange={(e) => {
                  setReviewer(e.target.value);
                  setModel(reviewers.find((r) => r.name === e.target.value)?.defaultModel ?? '');
                }}
              >
                {reviewers.map((r) => (
                  <option key={r.name} value={r.name} disabled={!r.available}>
                    {r.available ? r.label : `${r.label} (not installed)`}
                  </option>
                ))}
              </select>
            </label>
            <label className="reviewer-field reviewer-model">
              <span className="label">Model</span>
              <input
                className="reviewer-input mono"
                value={model}
                list={`ticket-models-${reviewer}`}
                placeholder={info?.defaultModel ?? 'model'}
                onChange={(e) => setModel(e.target.value)}
              />
              <datalist id={`ticket-models-${reviewer}`}>
                {(info?.models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </datalist>
            </label>
          </>
        )}
        <button className="btn primary" type="submit" disabled={busy} title={`Review every branch of ${ticketKey}`}>
          Review ticket
        </button>
        <button className="btn" type="button" disabled={busy} onClick={onRecompute}>
          Recompute coverage
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={busy || running}
          onClick={onDetect}
          title="Detect every parent again, also those set by hand"
        >
          Re-detect order
        </button>
      </form>
      <div className="manual">
        <button className="manual-toggle" type="button" onClick={() => setShowExtra((v) => !v)} aria-expanded={showExtra}>
          {showExtra ? '− Added requirements' : '+ Added requirements or decisions'}
        </button>
        {showExtra && (
          <textarea
            className="manual-input"
            rows={4}
            value={extra}
            placeholder="Approved decisions that change the ticket, or scope notes. Added to the ticket text for every branch and for coverage."
            onChange={(e) => setExtra(e.target.value)}
          />
        )}
      </div>
    </Card>
  );
}

function ChainsCard({
  ticket,
  busy,
  onParent,
  onOrder,
}: {
  ticket: TicketGroupPayload;
  busy: boolean;
  onParent: (repo: string, branch: string, parent: string | null) => void;
  onOrder: (repo: string, branches: string[]) => void;
}) {
  const [dragging, setDragging] = useState<{ repo: string; branch: string } | null>(null);
  const chains = ticket.group.chains;
  return (
    <Card title={`Branches · ${chains.reduce((n, c) => n + c.branches.length, 0)}`}>
      {chains.length === 0 && <p className="muted">No branches yet.</p>}
      {chains.map((chain) => {
        const order = chain.branches.map((b) => b.branch);
        const move = (from: number, to: number): void => {
          if (from < 0 || to < 0 || to >= order.length || from === to) return;
          const next = [...order];
          const [item] = next.splice(from, 1);
          next.splice(to, 0, item!);
          onOrder(chain.repo, next);
        };
        return (
          <div key={chain.repo} className="chain">
            <h3 className="chain-repo mono">{chain.repo}</h3>
            <ol className="chain-list">
              {chain.branches.map((b, index) => (
                <li
                  key={b.branch}
                  className={`chain-item${dragging?.repo === chain.repo && dragging.branch === b.branch ? ' dragging' : ''}`}
                  style={{ paddingLeft: `calc(${b.depth} * var(--space-5))` }}
                  draggable={!busy}
                  onDragStart={() => setDragging({ repo: chain.repo, branch: b.branch })}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(e) => {
                    if (dragging?.repo === chain.repo) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragging && dragging.repo === chain.repo) move(order.indexOf(dragging.branch), index);
                    setDragging(null);
                  }}
                >
                  <ChainRow
                    branch={b}
                    siblings={chain.branches}
                    busy={busy}
                    canUp={index > 0}
                    canDown={index < order.length - 1}
                    onUp={() => move(index, index - 1)}
                    onDown={() => move(index, index + 1)}
                    onParent={(parent) => onParent(chain.repo, b.branch, parent)}
                  />
                </li>
              ))}
            </ol>
          </div>
        );
      })}
      <p className="muted ticket-hint">
        Drag a branch, or use ↑ ↓, to make its repository one chain in that order: the first sits on the default
        branch, each next one on the one before. The parent menu sets the base of one branch. Changes apply to the
        next run.
      </p>
    </Card>
  );
}

function ChainRow({
  branch: b,
  siblings,
  busy,
  canUp,
  canDown,
  onUp,
  onDown,
  onParent,
}: {
  branch: GroupBranch;
  siblings: GroupBranch[];
  busy: boolean;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
  onParent: (parent: string | null) => void;
}) {
  const def = b.defaultBranch ?? 'main';
  const options = [
    ...new Set([def, ...siblings.filter((s) => s.branch !== b.branch).map((s) => s.branch), ...(b.parent ? [b.parent] : [])]),
  ];
  const run = b.latest;
  const done = b.latestDone;
  return (
    <div className="chain-row">
      <span className="chain-handle" aria-hidden="true" title="Drag to reorder">
        ⋮⋮
      </span>
      <div className="chain-main">
        <div className="chain-title">
          {b.depth > 0 && (
            <span className="chain-arrow" aria-hidden="true">
              ↳
            </span>
          )}
          <BranchLink branch={b.branch} href={b.links?.branch} local={b.source === 'local'} />
          {b.source === 'local' && <span className="tag local">local</span>}
          {b.links?.pr && <PrLink href={b.links.pr} number={b.prNumber} />}
        </div>
        <div className="chain-sub">
          <label className="chain-parent">
            <span className="label">on</span>
            <select
              className="reviewer-select mono"
              value={b.parent ?? def}
              disabled={busy}
              onChange={(e) => onParent(e.target.value === def ? null : e.target.value)}
              aria-label={`Parent of ${b.branch}`}
            >
              {options.map((name) => (
                <option key={name} value={name}>
                  {name === def ? `${name} (default)` : name}
                </option>
              ))}
            </select>
          </label>
          {b.parentReason && <span className="tag cat">{PARENT_REASON[b.parentReason]}</span>}
          {b.parentInGroup && b.parentReviewed === false && (
            <span className="tag req-partial" title="The parent has no finished review yet">
              parent not reviewed
            </span>
          )}
        </div>
      </div>
      <div className="chain-run">
        {run ? (
          <>
            <StatusPill status={run.status} />
            {done && (
              <Link to={`/review/${done.id}`} title="Code verdict of the latest finished run: its findings only">
                <VerdictBadge verdict={done.code_verdict ?? done.verdict} />
              </Link>
            )}
            <Link to={`/review/${run.id}`} className="mono muted">
              #{run.run_index}
            </Link>
            {b.parent && run.base_branch !== b.parent && (
              <span className="muted chain-base" title="The base the latest run was diffed against">
                ran on {run.base_branch}
              </span>
            )}
          </>
        ) : (
          <span className="muted">not reviewed</span>
        )}
      </div>
      <div className="chain-move">
        <button className="btn ghost ctl" type="button" disabled={busy || !canUp} onClick={onUp} aria-label="Move up">
          ↑
        </button>
        <button className="btn ghost ctl" type="button" disabled={busy || !canDown} onClick={onDown} aria-label="Move down">
          ↓
        </button>
      </div>
    </div>
  );
}

function CoverageCard({ ticketKey, ticket }: { ticketKey: string; ticket: TicketGroupPayload }) {
  const coverage: Coverage | null = ticket.coverage;
  const latest = ticket.latest_coverage;
  const state = ticket.coverage_pending
    ? 'A coverage pass is pending or running; this page updates on its own.'
    : latest?.status === 'failed'
      ? `The last coverage pass failed: ${latest.error ?? 'unknown error'}`
      : null;
  return (
    <Card
      title={
        <span className="coverage-title">
          Ticket coverage
          {coverage?.verdict && (
            <span className={`badge ${coverage.verdict === 'covered' ? 'verdict-approve' : 'verdict-changes_requested'}`}>
              {coverage.verdict === 'covered' ? 'Covered' : 'Needs work'}
            </span>
          )}
        </span>
      }
      actions={
        coverage?.report_path ? (
          <a className="link-btn" href={api.coverageReportUrl(ticketKey)} target="_blank" rel="noreferrer">
            Report
            <span className="link-arrow" aria-hidden="true">↗</span>
          </a>
        ) : undefined
      }
    >
      {state && <p className="notice-line">{state}</p>}
      {!coverage ? (
        <p className="muted">No coverage yet. It is computed once the ticket’s branch reviews finish.</p>
      ) : (
        <>
          {coverage.summary && <p>{coverage.summary}</p>}
          <CoverageTable coverage={coverage} />
          <p className="muted ticket-hint">
            Coverage #{coverage.id} · {fmtTime(coverage.finished_at ?? coverage.created_at)} · read runs{' '}
            {coverage.review_ids.map((id, i) => (
              <span key={id}>
                {i > 0 && ', '}
                <Link to={`/review/${id}`}>#{id}</Link>
              </span>
            ))}
          </p>
        </>
      )}
    </Card>
  );
}

function CoverageTable({ coverage }: { coverage: Coverage }) {
  return (
    <div className="table-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Requirement</th>
            <th>Status</th>
            <th>Covered by</th>
          </tr>
        </thead>
        <tbody>
          {coverage.requirements.map((r, i) => (
            <tr key={`${i}-${r.text}`}>
              <td className="num mono">{i + 1}</td>
              <td>
                {r.text}
                {r.note && <div className="muted coverage-note">{r.note}</div>}
              </td>
              <td>
                <span className={`tag ${COVERAGE_TAG[r.status]}`}>{COVERAGE_LABEL[r.status]}</span>
              </td>
              <td>
                {r.branches.length === 0 ? (
                  <span className="muted">not covered anywhere</span>
                ) : (
                  <ul className="coverage-branches">
                    {r.branches.map((b) => (
                      <li key={`${b.repo}#${b.branch}`}>
                        <span className="mono">
                          {b.repo}#{b.branch}
                        </span>
                        {b.status === 'partial' && <span className="tag req-partial">partial</span>}
                        {b.evidence.map((e) => {
                          const warn = ANCHOR_WARNING[e.anchor_status];
                          const loc = e.line ? `${e.file}:${e.line}` : e.file;
                          return (
                            <span key={loc} className="coverage-evidence mono muted">
                              {loc}
                              {warn && (
                                <span className="tag anchor-warning" title={warn}>
                                  {warn}
                                </span>
                              )}
                            </span>
                          );
                        })}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** All runs of the group, per branch, newest first. */
function RunsSection({ reviews }: { reviews: Review[] }) {
  const groups = new Map<string, Review[]>();
  for (const r of reviews) {
    const key = `${r.repo}#${r.branch}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  if (groups.size === 0) return <p className="muted">No runs for this ticket.</p>;
  return (
    <>
      {[...groups.entries()].map(([key, rows]) => (
        <Card key={key} title={<BranchTitle rows={rows} />}>
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Verdict</th>
                  <th>Status</th>
                  <th>Base</th>
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
                    <td className="mono muted">{r.base_branch}</td>
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
    </>
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
