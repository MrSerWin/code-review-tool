import { useEffect, useId, useMemo, useState } from 'react';
import { api } from '../api';
import type { LocalRepo, LocalReposPayload, PreviewRoleRequest, RepoBranchesPayload } from '../types';

/** How long a branch listing is reused before it is asked for again. */
const LISTING_TTL_MS = 60_000;
/** Suggestions per input; the native dropdown gets unwieldy past this. */
const MAX_OPTIONS = 100;
const DEBOUNCE_MS = 200;

/**
 * Listings shared by every input on the page, per repository and query. A
 * failed listing (an older server, the sandbox down) resolves to null and is
 * forgotten, so the inputs keep working as plain text and a later mount retries.
 */
const listings = new Map<string, { at: number; listing: Promise<RepoBranchesPayload | null> }>();

function loadBranches(repo: string, q = ''): Promise<RepoBranchesPayload | null> {
  const key = `${repo}\n${q}`;
  const hit = listings.get(key);
  if (hit && Date.now() - hit.at < LISTING_TTL_MS) return hit.listing;
  const listing = api.repoBranches(repo, q || undefined).catch(() => {
    listings.delete(key);
    return null;
  });
  listings.set(key, { at: Date.now(), listing });
  return listing;
}

let localListing: { at: number; listing: Promise<LocalReposPayload | null> } | null = null;

/** The configured local clones, shared and cached like the remote listings. */
function loadLocalRepos(): Promise<LocalReposPayload | null> {
  if (localListing && Date.now() - localListing.at < LISTING_TTL_MS) return localListing.listing;
  const listing = api.localRepos().catch(() => {
    localListing = null;
    return null;
  });
  localListing = { at: Date.now(), listing };
  return listing;
}

/** A local branch as the picker shows it: name plus whether it is pushed. */
export function localBranchLabel(repo: LocalRepo, name: string): string {
  const b = repo.branches.find((x) => x.name === name);
  const marks: string[] = [];
  if (name === repo.currentBranch) marks.push('checked out');
  if (b && !b.upstream) marks.push('unpushed');
  else if (b?.ahead) marks.push(`ahead ${b.ahead}`);
  else if (b?.unpushed) marks.push('upstream gone');
  return marks.length ? `${name} (${marks.join(', ')})` : name;
}

/**
 * The request for the chosen branches, one entry per recipe role. With
 * `keepEmpty`, a role left empty is sent without a branch (= its base branch)
 * instead of being left out (= decided by the ticket, or the base without one).
 * A local role is always sent: empty means the clone's checked-out branch.
 */
export function roleRequests(
  roles: { role: string }[],
  values: Record<string, string>,
  keepEmpty = false,
  local: Record<string, boolean> = {},
): PreviewRoleRequest[] {
  return roles.flatMap(({ role }) => {
    const branch = (values[role] ?? '').trim();
    if (local[role]) return [branch ? { role, branch, local: true } : { role, local: true }];
    if (branch) return [{ role, branch }];
    return keepEmpty ? [{ role }] : [];
  });
}

/**
 * One branch input per recipe role, with the role's branches as suggestions:
 * the remote's, or with Local on, the configured clone's (unpushed ones marked).
 */
export default function RoleBranchInputs({
  roles,
  values,
  onChange,
  local = {},
  onLocalChange,
  disabled = false,
}: {
  roles: { role: string; repo: string }[];
  values: Record<string, string>;
  onChange: (role: string, branch: string) => void;
  /** Roles copied from the local clone; without `onLocalChange` there is no Local switch. */
  local?: Record<string, boolean>;
  onLocalChange?: (role: string, local: boolean) => void;
  disabled?: boolean;
}) {
  const idBase = useId();
  const [clones, setClones] = useState<LocalReposPayload | null>(null);
  const wantsLocal = Boolean(onLocalChange);
  useEffect(() => {
    if (!wantsLocal) return;
    let live = true;
    void loadLocalRepos().then((l) => {
      if (live) setClones(l);
    });
    return () => {
      live = false;
    };
  }, [wantsLocal]);
  return (
    <div className="role-branches">
      {roles.map((r, i) => (
        <BranchRow
          key={r.role}
          id={`${idBase}-${i}`}
          role={r.role}
          repo={r.repo}
          value={values[r.role] ?? ''}
          onChange={(v) => onChange(r.role, v)}
          local={Boolean(local[r.role])}
          clone={clones?.repos.find((c) => c.repo === r.repo) ?? null}
          onLocalChange={onLocalChange ? (v) => onLocalChange(r.role, v) : undefined}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function BranchRow({
  id,
  role,
  repo,
  value,
  onChange,
  local,
  clone,
  onLocalChange,
  disabled,
}: {
  id: string;
  role: string;
  repo: string;
  value: string;
  onChange: (value: string) => void;
  local: boolean;
  /** The configured clone of this repo, when there is one. */
  clone: LocalRepo | null;
  onLocalChange: ((local: boolean) => void) | undefined;
  disabled: boolean;
}) {
  const [listing, setListing] = useState<RepoBranchesPayload | null>(null);
  const [narrowed, setNarrowed] = useState<RepoBranchesPayload | null>(null);
  const [query, setQuery] = useState(() => value.trim());

  useEffect(() => {
    let live = true;
    void loadBranches(repo).then((l) => {
      if (live) setListing(l);
    });
    return () => {
      live = false;
    };
  }, [repo]);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(value.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);

  // A capped listing cannot answer every query: the server filters the rest.
  const capped = listing?.truncated === true;
  useEffect(() => {
    setNarrowed(null);
    if (!capped || !query) return;
    let live = true;
    void loadBranches(repo, query).then((l) => {
      if (live) setNarrowed(l);
    });
    return () => {
      live = false;
    };
  }, [repo, capped, query]);

  const source = narrowed ?? listing;
  const options = useMemo(() => {
    if (!source) return [];
    const needle = query.toLowerCase();
    return source.branches.filter((b) => !needle || b.toLowerCase().includes(needle)).slice(0, MAX_OPTIONS);
  }, [source, query]);

  const typed = value.trim();
  // Only a complete answer can say a branch does not exist; the server checks again on start.
  const unknown = local
    ? typed !== '' && clone !== null && !clone.branches.some((b) => b.name === typed)
    : typed !== '' && typed === query && source !== null && !source.truncated && !source.branches.includes(typed);
  const base = listing?.defaultBranch;
  const localOptions = useMemo(() => {
    if (!local || !clone) return [];
    const needle = typed.toLowerCase();
    return clone.branches
      .filter((b) => !needle || b.name === typed || b.name.toLowerCase().includes(needle))
      .slice(0, MAX_OPTIONS);
  }, [local, clone, typed]);
  const placeholder = local
    ? clone?.currentBranch
      ? `checked-out branch (${clone.currentBranch})`
      : 'local branch'
    : base
      ? `base branch (${base})`
      : 'base branch';
  const selected = local ? clone?.branches.find((b) => b.name === typed) : undefined;

  return (
    <div className={`role-branch${onLocalChange ? ' role-branch-local' : ''}`}>
      <label className="role-branch-label" htmlFor={id}>
        <span className="role-branch-role">{role}</span>
        <span className="role-branch-repo mono">{repo}</span>
      </label>
      {onLocalChange && (
        <label
          className="local-check role-local"
          title={
            clone
              ? `Copy the branch from the local clone ${clone.path} (committed state, pushed or not)`
              : `No local clone of ${repo} is configured (LOCAL_REPOS)`
          }
        >
          <input
            type="checkbox"
            checked={local}
            disabled={disabled || (!clone && !local)}
            onChange={(e) => onLocalChange(e.target.checked)}
          />
          Local
        </label>
      )}
      <div className="role-branch-field">
        <input
          id={id}
          className="launcher-input role-branch-input"
          list={`${id}-list`}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          aria-invalid={unknown || undefined}
          aria-describedby={unknown ? `${id}-hint` : undefined}
        />
        <datalist id={`${id}-list`}>
          {local && clone
            ? localOptions.map((b) => (
                <option key={b.name} value={b.name}>
                  {localBranchLabel(clone, b.name)}
                </option>
              ))
            : options.map((b) => <option key={b} value={b} />)}
        </datalist>
        {unknown && (
          <span id={`${id}-hint`} className="role-branch-hint">
            No branch {typed} in {local ? 'the local clone of ' : ''}
            {repo}
          </span>
        )}
        {local && selected && !unknown && (
          <span className="role-branch-note muted">
            {selected.upstream ? (selected.ahead ? `${selected.ahead} unpushed commit(s)` : 'pushed') : 'unpushed'} ·{' '}
            {selected.lastCommit.sha.slice(0, 7)}
          </span>
        )}
      </div>
    </div>
  );
}
