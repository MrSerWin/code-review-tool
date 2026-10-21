import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { api } from '../api';
import { Link, navigate } from '../router';
import { readStored, writeStored } from '../storage';
import { openTicketTitle } from '../tickets';
import type { Review, ReviewGroup, ReviewGroupBranch, ReviewGroupRun, ReviewStatus, Verdict } from '../types';
import {
  BranchLink, Card, Icon, IconButton, Input, Pager, PrLink, Segmented, StatusPill, TicketExternalLink, VerdictBadge,
  fmtTime,
} from './ui';

const ACTIVE = new Set(['queued', 'fetching', 'reviewing']);
const VIEW_KEY = 'crt.historyView';
const GROUPS_PER_PAGE = 20;
const RUNS_PER_PAGE = 25;
/** Runs shown when a group is expanded; the ticket page lists the rest. */
const GROUP_RUNS_LIMIT = 100;
const POLL_MS = 4000;
const DEBOUNCE_MS = 300;
/** Runs shown per branch of an expanded group before "N older" folds the rest. */
const BRANCH_RUNS_SHOWN = 5;

type View = 'groups' | 'runs';
const VIEWS = [
  { value: 'groups', label: 'By ticket' },
  { value: 'runs', label: 'All runs' },
] as const satisfies readonly { value: View; label: string }[];

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
          <Segmented label="History view" options={VIEWS} value={view} onChange={switchView} />
          <Input
            mono
            className="history-search"
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
                <colgroup>
                  <col className="col-toggle" />
                  <col />
                  <col className="col-summary" />
                  <col className="col-activity" />
                </colgroup>
                <thead>
                  <tr>
                    <th className="col-toggle">
                      <span className="sr-only">Expand</span>
                    </th>
                    <th>Ticket</th>
                    <th>Branches · runs · outcome</th>
                    <th className="col-activity">Last activity</th>
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

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const VERDICT_RANK: Record<Verdict, number> = { blocked: 0, changes_requested: 1, approve: 2 };
const OUTCOME_LABEL: Record<string, string> = {
  approve: 'approved',
  changes_requested: 'changes requested',
  blocked: 'blocked',
  none: 'no verdict',
};

/** What one run came to: its verdict once done, else its status. */
function RunOutcome({ run }: { run: Pick<ReviewGroupRun, 'status' | 'verdict'> }) {
  return run.status === 'done' ? <VerdictBadge verdict={run.verdict} /> : <StatusPill status={run.status} />;
}

/**
 * One badge for a whole group, judged on the latest run of each branch:
 * something running wins; else the worst verdict (blocked, changes requested,
 * approved); else, with nothing done, the latest status.
 */
function GroupOutcome({ group }: { group: ReviewGroup }) {
  const heads = group.branches.map((b) => b.latest);
  const active = Math.max(group.activeCount, heads.filter((h) => ACTIVE.has(h.status)).length);
  if (active > 0) {
    return (
      <span className="pill status-reviewing">
        <span className="pulse" aria-hidden="true" />
        {active} active
      </span>
    );
  }
  const done = heads.filter((h) => h.status === 'done');
  if (done.length > 0) {
    const worst = done
      .map((h) => h.verdict)
      .sort((a, b) => (a ? VERDICT_RANK[a] : 3) - (b ? VERDICT_RANK[b] : 3))[0];
    return <VerdictBadge verdict={worst ?? null} />;
  }
  const latest: ReviewStatus | undefined = heads[0]?.status;
  return latest ? <StatusPill status={latest} /> : <span className="muted">—</span>;
}

/** "2 approved · 1 failed": how the latest runs of a group's branches ended, for a tooltip. */
function outcomeBreakdown(group: ReviewGroup): string {
  const counts = new Map<string, number>();
  for (const { latest } of group.branches) {
    const label = latest.status === 'done' ? OUTCOME_LABEL[latest.verdict ?? 'none'] ?? 'done' : latest.status;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([label, n]) => `${n} ${label}`);
  return `Latest run per branch: ${parts.join(' · ')}`;
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
  const branchCount = group.branches.length;
  return (
    <>
      <tr className={`row-link group-row${open ? ' row-open' : ''}`} onClick={onToggle}>
        <td className="col-toggle">
          <IconButton
            size="sm"
            className="chevron"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            label={`${open ? 'Hide' : 'Show'} branches and runs of ${group.key}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <Icon name="chevron" />
          </IconButton>
        </td>
        <td className="group-cell">
          <div className="group-line">
            {group.isTicket ? (
              <span className="group-key" onClick={stop}>
                <Link to={ticketPath(group.key)} className="mono" title={`Every run of ${group.key}`}>
                  {group.key}
                </Link>
                {group.ticketUrl && (
                  <TicketExternalLink href={group.ticketUrl} label={openTicketTitle(group.ticketUrl, group.key)} />
                )}
              </span>
            ) : (
              <span className="mono group-branch-key" title={group.key}>
                {group.key}
              </span>
            )}
            {group.title && (
              <span className="group-title muted" title={group.title}>
                {group.title}
              </span>
            )}
          </div>
        </td>
        <td className="group-summary" title={outcomeBreakdown(group)}>
          <span className="group-counts muted">
            {plural(branchCount, 'branch', 'branches')} · {plural(group.runCount, 'run', 'runs')}
          </span>
          <GroupOutcome group={group} />
          <span className="group-when muted">{fmtTime(group.lastActivity)}</span>
        </td>
        <td className="col-activity nowrap muted">{fmtTime(group.lastActivity)}</td>
      </tr>
      {open && (
        <tr className="group-runs" id={panelId}>
          <td colSpan={4}>
            {state.error && <p className="error-line">{state.error}</p>}
            {state.runs === null ? (
              !state.error && <p className="muted">Loading runs…</p>
            ) : (
              <>
                <BranchRuns group={group} runs={state.runs} reviewerLabel={reviewerLabel} />
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

interface BranchSection {
  key: string;
  repo: string;
  branch: string;
  head: ReviewGroupBranch | undefined;
  runs: Review[];
}

/** The runs of an expanded group, one section per repo/branch in the group's order, newest run first. */
function BranchRuns({
  group,
  runs,
  reviewerLabel,
}: {
  group: ReviewGroup;
  runs: Review[];
  reviewerLabel: ReviewerLabel;
}) {
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const sections = new Map<string, BranchSection>();
  for (const b of group.branches) {
    const key = `${b.repo}#${b.branch}`;
    sections.set(key, { key, repo: b.repo, branch: b.branch, head: b, runs: [] });
  }
  for (const r of runs) {
    const key = `${r.repo}#${r.branch}`;
    // A branch whose first run started after the group row was loaded still gets its section.
    if (!sections.has(key)) sections.set(key, { key, repo: r.repo, branch: r.branch, head: undefined, runs: [] });
    sections.get(key)!.runs.push(r);
  }
  const list = [...sections.values()].filter((s) => s.runs.length > 0);
  if (list.length === 0) return <p className="muted">No runs.</p>;

  return (
    <div className="table-wrap">
      <table className="grid branch-runs">
        <colgroup>
          <col className="col-run" />
          <col className="col-outcome" />
          <col className="col-reviewer" />
          <col className="col-created" />
        </colgroup>
        <thead className="sr-only">
          <tr>
            <th>Run</th>
            <th>Outcome</th>
            <th>Reviewer</th>
            <th>Created</th>
          </tr>
        </thead>
        {list.map((s) => {
          const newest = s.runs[0]!;
          const links = s.head?.links ?? newest.links;
          const prNumber = s.head?.prNumber ?? s.runs.find((r) => r.pr_number)?.pr_number ?? null;
          const prUrl = links?.pr ?? s.runs.find((r) => r.links?.pr)?.links?.pr ?? null;
          const local = (s.head?.source ?? newest.source) === 'local';
          const open = unfolded.has(s.key);
          const shown = open ? s.runs : s.runs.slice(0, BRANCH_RUNS_SHOWN);
          const hidden = s.runs.length - shown.length;
          return (
            <tbody key={s.key}>
              <tr className="branch-head">
                <th colSpan={4} scope="rowgroup">
                  <div className="branch-head-line">
                    <span className="branch-repo">{s.repo}</span>
                    <BranchLink branch={s.branch} href={links?.branch} local={local} className="branch-name" />
                    {local && <span className="tag local">local</span>}
                    {prUrl && <PrLink href={prUrl} number={prNumber} />}
                    <span className="branch-head-outcome">
                      <span className="muted">latest</span>
                      <RunOutcome run={s.head?.latest ?? newest} />
                    </span>
                  </div>
                </th>
              </tr>
              {shown.map((r) => (
                <tr key={r.id} className="row-link" onClick={() => navigate(`/review/${r.id}`)}>
                  <td className="mono" onClick={stop}>
                    <Link to={`/review/${r.id}`}>#{r.run_index}</Link>
                  </td>
                  <td>
                    <RunOutcome run={r} />
                  </td>
                  <td className="col-reviewer truncate-cell muted" title={r.model ?? undefined}>
                    {r.reviewer ? reviewerLabel(r.reviewer) : '—'}
                    {r.model && <span className="mono"> · {r.model}</span>}
                  </td>
                  <td className="muted nowrap">{fmtTime(r.created_at)}</td>
                </tr>
              ))}
              {hidden > 0 && (
                <tr className="branch-more">
                  <td colSpan={4}>
                    <button
                      type="button"
                      className="link-like"
                      onClick={() => setUnfolded((prev) => new Set(prev).add(s.key))}
                    >
                      {plural(hidden, 'older run', 'older runs')}
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          );
        })}
      </table>
    </div>
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
      <table className="grid runs-grid">
        <thead>
          <tr>
            {showTicket && <th>Ticket</th>}
            <th>Repo</th>
            <th>Branch</th>
            <th>Reviewer</th>
            <th>Run</th>
            <th>Outcome</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="row-link" onClick={() => navigate(`/review/${r.id}`)}>
              {showTicket && (
                <td className="ticket-cell" onClick={stop}>
                  <TicketCell review={r} />
                </td>
              )}
              <td className="nowrap">
                {r.repo}
                {r.source === 'local' && (
                  <>
                    {' '}
                    <span className="tag local">local</span>
                  </>
                )}
              </td>
              <td>
                <div className="branch-cell">
                  <BranchLink branch={r.branch} href={r.links?.branch} local={r.source === 'local'} />
                  {r.links?.pr && <PrLink href={r.links.pr} number={r.pr_number} />}
                </div>
              </td>
              <td className="nowrap" title={r.model ?? undefined}>
                {r.reviewer ? reviewerLabel(r.reviewer) : '—'}
              </td>
              <td className="mono" onClick={stop}>
                <Link to={`/review/${r.id}`}>#{r.run_index}</Link>
              </td>
              <td className="nowrap">
                <RunOutcome run={r} />
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
      <Link to={ticketPath(r.ticket_key)} className="mono" title={r.ticket_key}>
        {r.ticket_key}
      </Link>
    );
  }
  // Pasted requirements carry no ticket key, but the branch name may.
  const key = ticketLikeGroup(r);
  if (key) {
    return (
      <Link to={ticketPath(key)} className="mono muted" title={`${key} — key found in the branch name`}>
        {key}
      </Link>
    );
  }
  return <span className="muted">—</span>;
}
