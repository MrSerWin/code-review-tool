import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import History from '../components/History';
import { Button, Card, CloseButton, Field, Input, Segmented, Select, Toolbar } from '../components/ui';
import { navigate } from '../router';
import { readStored, writeStored } from '../storage';
import { TRACKER_LABEL, ticketLinkRef } from '../tickets';
import type { Health, LocalRepo, ResolvedTarget, ReviewerInfo, TicketInfo } from '../types';

const TICKET_RE = /^(?:[a-z]+:)?[a-z][a-z0-9_]*-\d+$/i;
/** A GitHub issue reference, the one ticket shape that is always available. */
const ISSUE_RE = /^(?:github:)?[\w.-]+\/[\w.-]+#\d+$/i;
const keyOf = (t: ResolvedTarget): string => `${t.repo}#${t.branch}`;

const REVIEWER_KEY = 'crt.reviewer';
const MODE_KEY = 'crt.mode';
type Mode = 'github' | 'local';
const MODES = [
  { value: 'github', label: 'GitHub' },
  { value: 'local', label: 'Local' },
] as const satisfies readonly { value: Mode; label: string }[];
const modelKey = (reviewer: string): string => `crt.model.${reviewer}`;

export default function Home() {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<TicketInfo | null>(null);
  const [targets, setTargets] = useState<ResolvedTarget[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  /** Bumped to make the history reload after runs were started without leaving the page. */
  const [historyToken, setHistoryToken] = useState(0);
  const [trackers, setTrackers] = useState<string[] | null>(null);
  const [reviewers, setReviewers] = useState<ReviewerInfo[]>([]);
  const [reviewer, setReviewer] = useState('claude');
  const [model, setModel] = useState('');
  const [requirements, setRequirements] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [mode, setMode] = useState<Mode>(() => (readStored(MODE_KEY) === 'local' ? 'local' : 'github'));
  const [localRepos, setLocalRepos] = useState<LocalRepo[] | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localRepo, setLocalRepo] = useState('');
  const [localBranch, setLocalBranch] = useState('');
  const [includeWorkingTree, setIncludeWorkingTree] = useState(false);
  const [localBase, setLocalBase] = useState('');
  /** Where the Base field's value came from; 'custom' once the user types in it. */
  const [baseKind, setBaseKind] = useState<'parent' | 'default' | 'custom' | null>(null);
  const baseTouched = useRef(false);

  const loadLocalRepos = useCallback(async () => {
    try {
      const { repos, unavailable } = await api.localRepos();
      setLocalRepos(repos);
      setLocalError(
        repos.length === 0
          ? unavailable.length
            ? unavailable.map((u) => `${u.repo}: ${u.reason}`).join(' · ')
            : 'No local clones configured. Set LOCAL_REPOS_DIR in .env.'
          : null,
      );
      setLocalRepo((prev) => (repos.some((r) => r.repo === prev) ? prev : repos[0]?.repo ?? ''));
    } catch (err) {
      setLocalRepos([]);
      setLocalError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (mode === 'local') void loadLocalRepos();
  }, [mode, loadLocalRepos]);

  const chosenRepo = localRepos?.find((r) => r.repo === localRepo);
  const branchRepoRef = useRef<string | null>(null);
  // The branch list is refreshed on every visit; keep the pick while it still exists.
  useEffect(() => {
    if (!chosenRepo) return;
    // A typed name is kept as-is (the server checks it exists); only a switch to
    // another repo resets the field to that clone's checked-out branch.
    setLocalBranch((prev) =>
      prev && chosenRepo.repo === branchRepoRef.current
        ? prev
        : chosenRepo.currentBranch ?? chosenRepo.branches[0]?.name ?? '');
    branchRepoRef.current = chosenRepo.repo;
  }, [chosenRepo]);

  // A new branch (or repo) hands the Base field back to detection.
  useEffect(() => {
    baseTouched.current = false;
  }, [localRepo, localBranch]);

  const branchKnown = Boolean(chosenRepo?.branches.some((b) => b.name === localBranch.trim()));
  const defaultBase = chosenRepo?.baseBranch ?? '';
  // Prefill Base with the detected parent of an existing branch, debounced, unless the
  // user has edited Base since the branch last changed.
  useEffect(() => {
    if (mode !== 'local' || !localRepo) return;
    const branch = localBranch.trim();
    if (!branchKnown) {
      if (!baseTouched.current) {
        setLocalBase(defaultBase);
        setBaseKind(defaultBase ? 'default' : null);
      }
      return;
    }
    let stale = false;
    const timer = window.setTimeout(() => {
      api
        .localParent(localRepo, branch)
        .then((parent) => {
          if (stale || baseTouched.current) return;
          setLocalBase(parent.base);
          setBaseKind(parent.reason === 'default' ? 'default' : 'parent');
        })
        .catch(() => {
          if (stale || baseTouched.current) return;
          setLocalBase(defaultBase);
          setBaseKind(defaultBase ? 'default' : null);
        });
    }, 300);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [mode, localRepo, localBranch, branchKnown, defaultBase]);

  const baseOptions = chosenRepo
    ? [
        ...(defaultBase && !chosenRepo.branches.some((b) => b.name === defaultBase) ? [defaultBase] : []),
        ...chosenRepo.branches.map((b) => b.name),
      ].filter((name) => name !== localBranch.trim())
    : [];
  const baseLabel = !localBase.trim()
    ? 'Base · detected on start'
    : baseKind === 'parent'
      ? 'Base · detected parent'
      : baseKind === 'default'
        ? 'Base · default'
        : 'Base · custom';

  const canIncludeTree = Boolean(
    chosenRepo && chosenRepo.dirty && localBranch && localBranch === chosenRepo.currentBranch,
  );
  useEffect(() => {
    if (!canIncludeTree) setIncludeWorkingTree(false);
  }, [canIncludeTree]);

  const switchMode = (next: Mode): void => {
    setMode(next);
    writeStored(MODE_KEY, next);
    setError(null);
  };

  const branchLabel = (repo: LocalRepo, name: string): string => {
    const b = repo.branches.find((x) => x.name === name);
    const marks: string[] = [];
    if (name === repo.currentBranch) marks.push(repo.dirty ? 'current, dirty' : 'current');
    if (b && !b.upstream) marks.push('unpushed');
    else if (b?.ahead) marks.push(`ahead ${b.ahead}`);
    else if (b?.unpushed) marks.push('upstream gone');
    if (b && b.upstream && b.behind) marks.push(`behind ${b.behind}`);
    return marks.length ? `${name} (${marks.join(', ')})` : name;
  };

  // GitHub Issues need no extra credentials, so they are always available; a
  // key like ABC-123 only means something when another tracker is configured.
  const hasKeyTracker = trackers === null || trackers.some((t) => t !== 'github');
  const manualText = requirements.trim();

  // A tracker's issue link names its ticket as surely as the key does; a PR link
  // is not one (it is reviewed directly, as exactly one branch). On an unknown
  // host only a configured tracker can be the self-hosted one the path suggests.
  const linkRef = ticketLinkRef(input);
  const link = linkRef && (!linkRef.guessed || trackers === null || trackers.includes(linkRef.tracker))
    ? linkRef
    : null;
  // With requirements pasted by hand no ticket is looked up, so the input only
  // has to name a branch.
  const isTicketInput = !manualText && (link !== null || (hasKeyTracker
    ? TICKET_RE.test(input.trim())
    : ISSUE_RE.test(input.trim())));
  // Named so the user sees what the link resolves to before asking for it.
  const linkHint = link && !manualText && link.tracker !== 'github'
    ? {
        label: TRACKER_LABEL[link.tracker],
        key: link.key,
        missing: trackers !== null && !trackers.includes(link.tracker),
      }
    : null;

  const placeholder = hasKeyTracker
    ? 'ABC-123 or its link, PR URL, or repo#branch'
    : 'my-org/my-service#12, issue or PR URL, or repo#branch';

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
  const reviewerLabel = useCallback(
    (name: string): string => reviewers.find((r) => r.name === name)?.label ?? name,
    [reviewers],
  );

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
    // Started from a resolved link: send the canonical `tracker:KEY` the server answered with.
    const resolvedKey =
      chosen && ticket?.key && link && link.tracker !== 'github' && ticket.provider === link.tracker
        ? `${ticket.provider}:${ticket.key}`
        : null;
    const value = mode === 'local' ? localInput() : resolvedKey ?? input.trim();
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
        ...(mode === 'local' && includeWorkingTree ? { includeWorkingTree: true } : {}),
        ...(mode === 'local' && localBase.trim() ? { baseBranch: localBase.trim() } : {}),
      });
      if (reviews.length === 1) navigate(`/review/${reviews[0]!.id}`);
      else if (reviews[0]?.ticket_key) navigate(`/ticket/${encodeURIComponent(reviews[0].ticket_key)}`);
      else setHistoryToken((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  function localInput(): string {
    return localRepo && localBranch.trim() ? `local:${localRepo}#${localBranch.trim()}` : '';
  }

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (mode === 'local') {
      await run();
      return;
    }
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
      <Segmented label="Source" options={MODES} value={mode} onChange={switchMode} />

      {mode === 'local' ? (
        <form className="toolbar toolbar-end" onSubmit={(e) => void submit(e)}>
          <Field label="Repository">
            <Select
              value={localRepo}
              onChange={(e) => setLocalRepo(e.target.value)}
              disabled={!localRepos?.length}
            >
              {(localRepos ?? []).map((r) => (
                <option key={r.repo} value={r.repo}>
                  {r.repo}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Branch" grow>
            <Input
              mono
              list={`local-branches-${localRepo}`}
              value={localBranch}
              placeholder="Type or pick a branch"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setLocalBranch(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              disabled={!chosenRepo}
            />
            <datalist id={`local-branches-${localRepo}`}>
              {(chosenRepo?.branches ?? []).map((b) => (
                <option key={b.name} value={b.name}>
                  {branchLabel(chosenRepo!, b.name)} — {b.lastCommit.subject}
                </option>
              ))}
            </datalist>
          </Field>
          <Field label={baseLabel} grow>
            <Input
              mono
              list={`local-bases-${localRepo}`}
              value={localBase}
              placeholder={defaultBase || 'Base branch'}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => {
                baseTouched.current = true;
                setLocalBase(e.target.value);
                setBaseKind('custom');
              }}
              onFocus={(e) => e.currentTarget.select()}
              disabled={!chosenRepo}
            />
            <datalist id={`local-bases-${localRepo}`}>
              {baseOptions.map((name) => (
                <option key={name} value={name}>
                  {name === defaultBase ? `${name} (default)` : branchLabel(chosenRepo!, name)}
                </option>
              ))}
            </datalist>
          </Field>
          <label
            className="local-check"
            aria-disabled={!canIncludeTree}
            title={
              canIncludeTree
                ? 'Review staged, unstaged and untracked changes too'
                : 'Only for the checked-out branch with uncommitted changes'
            }
          >
            <input
              type="checkbox"
              checked={includeWorkingTree}
              disabled={!canIncludeTree}
              onChange={(e) => setIncludeWorkingTree(e.target.checked)}
            />
            Include uncommitted changes
          </label>
          <Button variant="ghost" onClick={() => void loadLocalRepos()} disabled={busy}>
            Refresh
          </Button>
          <Button type="submit" disabled={busy || !localRepo || !localBranch.trim()}>
            {busy ? 'Working…' : 'Review'}
          </Button>
        </form>
      ) : (
      <form className="launcher" onSubmit={(e) => void submit(e)}>
        <Input
          mono
          className="launcher-input"
          placeholder={placeholder}
          value={input}
          spellCheck={false}
          onChange={(e) => {
            setInput(e.target.value);
            if (ticket) reset();
          }}
        />
        <Button type="submit" disabled={busy || !input.trim()}>
          {busy ? 'Working…' : isTicketInput ? 'Find branches' : 'Review'}
        </Button>
      </form>
      )}
      {mode === 'local' && localError && <p className="muted manual-hint">{localError}</p>}
      {mode === 'github' && linkHint && (
        <p className="muted manual-hint">
          {linkHint.label} ticket <span className="mono">{linkHint.key}</span>
          {linkHint.missing && ` · ${linkHint.label} is not configured on this server`}
        </p>
      )}

      <Toolbar align="end">
        <Field label="Reviewer">
          <Select
            value={reviewer}
            onChange={(e) => onReviewerChange(e.target.value)}
          >
            {reviewers.map((r) => (
              <option key={r.name} value={r.name} disabled={!r.available}>
                {r.available ? r.label : `${r.label} (not installed)`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model" grow>
          <Input
            mono
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
        </Field>
      </Toolbar>

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
              <Button
                variant="primary"
                onClick={() => void startPicked()}
                disabled={busy || picked.length === 0}
                title={picked.length === 0 ? 'Select at least one branch' : undefined}
              >
                {busy ? 'Starting…' : `Start review${picked.length > 1 ? ` (${picked.length})` : ''}`}
              </Button>
              <CloseButton onClick={reset} />
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

      <History reviewerLabel={reviewerLabel} refreshToken={historyToken} />
    </div>
  );
}
