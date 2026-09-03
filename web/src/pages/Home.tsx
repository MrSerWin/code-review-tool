import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Card, StatusPill, VerdictBadge, fmtTime } from '../components/ui';
import { Link, navigate } from '../router';
import type { Health, ResolvedTarget, Review, ReviewerInfo, TicketInfo } from '../types';

const TICKET_RE = /^(?:[a-z]+:)?[a-z][a-z0-9_]*-\d+$/i;
/** A GitHub issue reference, the one ticket shape that is always available. */
const ISSUE_RE = /^(?:github:)?[\w.-]+\/[\w.-]+#\d+$/i;
const ACTIVE = new Set(['queued', 'fetching', 'reviewing']);
const keyOf = (t: ResolvedTarget): string => `${t.repo}#${t.branch}`;

const REVIEWER_KEY = 'crt.reviewer';
const modelKey = (reviewer: string): string => `crt.model.${reviewer}`;

/** localStorage can be missing or throw (private mode, blocked storage); never let it break the page. */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — remembering is a convenience, not a requirement */
  }
}

export default function Home() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<TicketInfo | null>(null);
  const [targets, setTargets] = useState<ResolvedTarget[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [history, setHistory] = useState<Review[]>([]);
  const [historyQuery, setHistoryQuery] = useState('');
  const [trackers, setTrackers] = useState<string[] | null>(null);
  const [reviewers, setReviewers] = useState<ReviewerInfo[]>([]);
  const [reviewer, setReviewer] = useState('claude');
  const [model, setModel] = useState('');
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
      const q = historyQuery.trim();
      const { reviews } = await api.listReviews({ limit: 60, ...(q ? { q } : {}) });
      setHistory(reviews);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [historyQuery]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    api
      .health()
      .then((h: Health) => setTrackers(h.trackers ?? []))
      .catch(() => setTrackers(null));
  }, []);

  useEffect(() => {
    api
      .reviewers()
      .then(({ reviewers: list, defaultReviewer }) => {
        const all = list ?? [];
        setReviewers(all);

        // A remembered reviewer only counts while the server still offers it and its CLI is installed.
        const remembered = readStored(REVIEWER_KEY);
        const usable = (name: string | null): ReviewerInfo | undefined =>
          all.find((r) => r.name === name && r.available);
        const chosen =
          usable(remembered) ??
          usable(defaultReviewer) ??
          all.find((r) => r.available) ??
          all.find((r) => r.name === defaultReviewer);

        const name = chosen?.name ?? defaultReviewer ?? 'claude';
        setReviewer(name);
        setModel(readStored(modelKey(name)) ?? chosen?.defaultModel ?? '');
      })
      .catch(() => setReviewers([]));
  }, []);

  const onReviewerChange = (name: string): void => {
    setReviewer(name);
    writeStored(REVIEWER_KEY, name);
    const info = reviewers.find((r) => r.name === name);
    setModel(readStored(modelKey(name)) ?? info?.defaultModel ?? '');
  };

  const onModelChange = (value: string): void => {
    setModel(value);
    writeStored(modelKey(reviewer), value);
  };

  const selected = reviewers.find((r) => r.name === reviewer);
  const reviewerLabel = (name: string): string =>
    reviewers.find((r) => r.name === name)?.label ?? name;

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
        reviewer,
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      if (reviews.length === 1) navigate(`/review/${reviews[0]!.id}`);
      else if (reviews[0]?.ticket_key) navigate(`/ticket/${encodeURIComponent(reviews[0].ticket_key)}`);
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

      <div className="reviewer-row">
        <label className="reviewer-field">
          <span className="muted">Reviewer</span>
          <select
            className="reviewer-select"
            value={reviewer}
            onChange={(e) => onReviewerChange(e.target.value)}
          >
            {reviewers.map((r) => (
              <option key={r.name} value={r.name} disabled={!r.available}>
                {r.available ? r.label : `${r.label} (not installed)`}
              </option>
            ))}
          </select>
        </label>
        <label className="reviewer-field reviewer-model">
          <span className="muted">Model</span>
          <input
            className="reviewer-input mono"
            value={model}
            spellCheck={false}
            list={`models-${reviewer}`}
            placeholder={selected?.defaultModel ?? ''}
            onChange={(e) => onModelChange(e.target.value)}
          />
          <datalist id={`models-${reviewer}`}>
            {(selected?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </datalist>
        </label>
      </div>

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

      <Card
        title="History"
        actions={
          <input
            className="history-search mono"
            placeholder="Filter ticket, repo, branch…"
            value={historyQuery}
            spellCheck={false}
            onChange={(e) => setHistoryQuery(e.target.value)}
          />
        }
      >
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
                  <th>Reviewer</th>
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
                        <Link to={`/ticket/${encodeURIComponent(r.ticket_key)}`} className="mono">
                          {r.ticket_key}
                        </Link>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{r.repo}</td>
                    <td className="mono truncate">{r.branch}</td>
                    <td>{r.reviewer ? reviewerLabel(r.reviewer) : '—'}</td>
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
