import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { api } from '../api';
import { Link, navigate } from '../router';
import { readStored, writeStored } from '../storage';
import type { Review, ReviewGroup, ReviewGroupBranch } from '../types';
import { Card, Pager, StatusPill, VerdictBadge, fmtTime } from './ui';

const ACTIVE = new Set(['queued', 'fetching', 'reviewing']);
const VIEW_KEY = 'crt.historyView';
const GROUPS_PER_PAGE = 20;
const RUNS_PER_PAGE = 25;
/** Runs shown when a group is expanded; the ticket page lists the rest. */
const GROUP_RUNS_LIMIT = 100;
const POLL_MS = 4000;
const DEBOUNCE_MS = 300;

type View = 'groups' | 'runs';

/** The runs of one expanded group; `runs` is null until the first answer. */
interface GroupRuns {
  runs: Review[] | null;
  error: string | null;
}

type ReviewerLabel = (name: string) => string;

const stop = (e: MouseEvent): void => e.stopPropagation();
const ticketPath = (key: string): string => `/ticket/${encodeURIComponent(key)}`;

/** The group key of a run when it names a ticket, not the run's own repo#branch. */
function ticketLikeGroup(r: Review): string | null {
  const key = r.group_key;
  return key && key !== `${r.repo}#${r.branch}` ? key : null;
}

export default function History({
  reviewerLabel,
  refreshToken,
}: {
  reviewerLabel: ReviewerLabel;
  /** Bumped by the page when it started runs without leaving it. */
  refreshToken: number;
}) {
  const [view, setView] = useState<View>(() => (readStored(VIEW_KEY) === 'runs' ? 'runs' : 'groups'));
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [groupOffset, setGroupOffset] = useState(0);
  const [runOffset, setRunOffset] = useState(0);
  const [groups, setGroups] = useState<ReviewGroup[] | null>(null);
  const [groupTotal, setGroupTotal] = useState(0);
  const [runs, setRuns] = useState<Review[] | null>(null);
  const [runTotal, setRunTotal] = useState(0);
  const [expanded, setExpanded] = useState<Record<string, GroupRuns>>({});
  const [error, setError] = useState<string | null>(null);

  // Debounced filter; a new filter starts from the first page.
  useEffect(() => {
    const q = queryInput.trim();
    if (q === query) return;
    const timer = window.setTimeout(() => {
      setQuery(q);
      setGroupOffset(0);
      setRunOffset(0);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [queryInput, query]);

  // Only the newest request may write: a slow answer for an old page or filter is dropped.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const id = ++seq.current;
    try {
      if (view === 'groups') {
        const res = await api.reviewGroups({ limit: GROUPS_PER_PAGE, offset: groupOffset, q: query || undefined });
        if (id !== seq.current) return;
        // The page emptied under us (runs deleted): step back to the last page that exists.
        if (res.groups.length === 0 && res.total > 0 && groupOffset > 0) {
          setGroupOffset(Math.floor((res.total - 1) / GROUPS_PER_PAGE) * GROUPS_PER_PAGE);
          return;
        }
        setGroups(res.groups);
        setGroupTotal(res.total);
      } else {
        const res = await api.listReviews({ limit: RUNS_PER_PAGE, offset: runOffset, q: query || undefined });
        if (id !== seq.current) return;
        if (res.reviews.length === 0 && res.total > 0 && runOffset > 0) {
          setRunOffset(Math.floor((res.total - 1) / RUNS_PER_PAGE) * RUNS_PER_PAGE);
          return;
        }
        setRuns(res.reviews);
        setRunTotal(res.total);
      }
      setError(null);
    } catch (err) {
      if (id === seq.current) setError((err as Error).message);
    }
  }, [view, query, groupOffset, runOffset]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  const loadRuns = useCallback(async (key: string) => {
    try {
      const { reviews } = await api.listReviews({ group: key, limit: GROUP_RUNS_LIMIT });
      setExpanded((prev) => (prev[key] ? { ...prev, [key]: { runs: reviews, error: null } } : prev));
    } catch (err) {
      const message = (err as Error).message;
      setExpanded((prev) => (prev[key] ? { ...prev, [key]: { runs: prev[key]!.runs, error: message } } : prev));
    }
  }, []);

  const toggle = (key: string): void => {
    if (expanded[key]) {
      setExpanded((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    setExpanded((prev) => ({ ...prev, [key]: { runs: null, error: null } }));
    void loadRuns(key);
  };

  const switchView = (next: View): void => {
    setView(next);
    writeStored(VIEW_KEY, next);
  };

  // Poll every few seconds while anything on screen is still running: the page,
  // and the runs of the groups expanded on it.
  const openKeys = view === 'groups' ? (groups ?? []).filter((g) => expanded[g.key]).map((g) => g.key) : [];
  const running =
    view === 'groups'
      ? (groups ?? []).some((g) => g.activeCount > 0) ||
        openKeys.some((key) => expanded[key]?.runs?.some((r) => ACTIVE.has(r.status)))
      : (runs ?? []).some((r) => ACTIVE.has(r.status));
  const openKeysRef = useRef<string[]>([]);
  openKeysRef.current = openKeys;

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void load();
      for (const key of openKeysRef.current) void loadRuns(key);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load, loadRuns]);

  const empty = <p className="muted">{query ? `No reviews match “${query}”.` : 'No reviews yet.'}</p>;

  return (
    <Card
      title="History"
      actions={
        <>
          <div className="mode-switch" role="group" aria-label="History view">
            {(['groups', 'runs'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={`btn${view === v ? ' primary' : ' ghost'}`}
                aria-pressed={view === v}
                onClick={() => switchView(v)}
              >
                {v === 'groups' ? 'By ticket' : 'All runs'}
              </button>
            ))}
          </div>
          <input
            className="history-search mono"
            placeholder="Filter ticket, repo, branch…"
            aria-label="Filter history"
            value={queryInput}
            spellCheck={false}
            onChange={(e) => setQueryInput(e.target.value)}
          />
        </>
      }
    >
      {error && <p className="error-line">{error}</p>}
      {view === 'groups' ? (
        groups === null ? (
          <p className="muted">Loading…</p>
        ) : groups.length === 0 ? (
          empty
        ) : (
          <>
            <div className="table-wrap">
              <table className="grid group-grid">
                <thead>
                  <tr>
                    <th className="col-toggle">
                      <span className="sr-only">Expand</span>
                    </th>
                    <th>Ticket</th>
                    <th>Branches</th>
                    <th>Runs</th>
                    <th>Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g, index) => (
                    <GroupRow
                      key={g.key}
                      group={g}
                      panelId={`group-runs-${index}`}
                      state={expanded[g.key]}
                      onToggle={() => toggle(g.key)}
                      reviewerLabel={reviewerLabel}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pager offset={groupOffset} limit={GROUPS_PER_PAGE} total={groupTotal} onChange={setGroupOffset} />
          </>
        )
      ) : runs === null ? (
        <p className="muted">Loading…</p>
      ) : runs.length === 0 ? (
        empty
      ) : (
        <>
          <RunsTable runs={runs} showTicket reviewerLabel={reviewerLabel} />
          <Pager offset={runOffset} limit={RUNS_PER_PAGE} total={runTotal} onChange={setRunOffset} />
        </>
      )}
    </Card>
  );
}

function GroupRow({
  group,
  panelId,
  state,
  onToggle,
  reviewerLabel,
}: {
  group: ReviewGroup;
  panelId: string;
  state: GroupRuns | undefined;
  onToggle: () => void;
  reviewerLabel: ReviewerLabel;
}) {
  const open = state !== undefined;
  return (
    <>
      <tr className={`row-link group-row${open ? ' row-open' : ''}`} onClick={onToggle}>
        <td className="col-toggle">
          <button
            type="button"
            className="chevron"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            aria-label={`${open ? 'Hide' : 'Show'} runs of ${group.key}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <span className="chevron-icon" aria-hidden="true" />
          </button>
        </td>
        <td className="group-cell">
          <div className="group-key">
            {group.isTicket ? (
              <span onClick={stop}>
                <Link to={ticketPath(group.key)} className="mono" title={`Every run of ${group.key}`}>
                  {group.key}
                </Link>
              </span>
            ) : (
              <span className="mono group-branch-key" title={group.key}>
                {group.key}
              </span>
            )}
            {group.activeCount > 0 && (
              <span className="pill status-reviewing">
                <span className="pulse" aria-hidden="true" />
                {group.activeCount} active
              </span>
            )}
          </div>
          {group.title && (
            <div className="group-title muted" title={group.title}>
              {group.title}
            </div>
          )}
        </td>
        <td>
          <div className="chip-row">
            {group.branches.map((b) => (
              <BranchChip key={`${b.repo}#${b.branch}`} branch={b} />
            ))}
          </div>
        </td>
        <td className="nowrap muted">
          {group.runCount} {group.runCount === 1 ? 'run' : 'runs'}
        </td>
        <td className="nowrap muted">{fmtTime(group.lastActivity)}</td>
      </tr>
      {open && (
        <tr className="group-runs" id={panelId}>
          <td colSpan={5}>
            {state.error && <p className="error-line">{state.error}</p>}
            {state.runs === null ? (
              !state.error && <p className="muted">Loading runs…</p>
            ) : (
              <>
                <RunsTable runs={state.runs} showTicket={false} reviewerLabel={reviewerLabel} />
                {group.runCount > state.runs.length && (
                  <p className="muted group-runs-more">
                    Newest {state.runs.length} of {group.runCount} runs.{' '}
                    {group.isTicket && <Link to={ticketPath(group.key)}>See all</Link>}
                  </p>
                )}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/** One branch of a group: repo, branch, and the outcome of its latest run, linking to that run. */
function BranchChip({ branch: b }: { branch: ReviewGroupBranch }) {
  return (
    <span className="branch-chip">
      <span className="chip-main" onClick={stop}>
        <Link
          to={`/review/${b.latest.id}`}
          className="chip-link"
          title={`${b.repo} · ${b.branch} — open run #${b.latest.run_index}`}
        >
          <span className="chip-repo">{b.repo}</span>
          <span className="chip-branch mono">{b.branch}</span>
        </Link>
      </span>
      {b.source === 'local' && <span className="tag local">local</span>}
      {b.latest.status === 'done' ? <VerdictBadge verdict={b.latest.verdict} /> : <StatusPill status={b.latest.status} />}
      <span className="mono muted">#{b.latest.run_index}</span>
    </span>
  );
}

function RunsTable({
  runs,
  showTicket,
  reviewerLabel,
}: {
  runs: Review[];
  showTicket: boolean;
  reviewerLabel: ReviewerLabel;
}) {
  return (
    <div className="table-wrap">
      <table className="grid">
        <thead>
          <tr>
            {showTicket && <th>Ticket</th>}
            <th>Repo</th>
            <th>Branch</th>
            <th>Reviewer</th>
            <th>Run</th>
            <th>Verdict</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="row-link" onClick={() => navigate(`/review/${r.id}`)}>
              {showTicket && (
                <td onClick={stop}>
                  <TicketCell review={r} />
                </td>
              )}
              <td>
                {r.repo}
                {r.source === 'local' && (
                  <>
                    {' '}
                    <span className="tag local">local</span>
                  </>
                )}
              </td>
              <td className="mono truncate" title={r.branch}>
                {r.branch}
              </td>
              <td>{r.reviewer ? reviewerLabel(r.reviewer) : '—'}</td>
              <td className="mono" onClick={stop}>
                <Link to={`/review/${r.id}`}>#{r.run_index}</Link>
              </td>
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
  );
}

function TicketCell({ review: r }: { review: Review }) {
  if (r.ticket_key) {
    return (
      <Link to={ticketPath(r.ticket_key)} className="mono">
        {r.ticket_key}
      </Link>
    );
  }
  // Pasted requirements carry no ticket key, but the branch name may.
  const key = ticketLikeGroup(r);
  if (key) {
    return (
      <Link to={ticketPath(key)} className="mono muted" title="Key found in the branch name">
        {key}
      </Link>
    );
  }
  return <span className="muted">—</span>;
}
