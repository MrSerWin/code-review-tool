import { useEffect, useId, useMemo, useState } from 'react';
import { api } from '../api';
import type { PreviewRoleRequest, RepoBranchesPayload } from '../types';

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

/**
 * The request for the chosen branches, one entry per recipe role. With
 * `keepEmpty`, a role left empty is sent without a branch (= its base branch)
 * instead of being left out (= decided by the ticket, or the base without one).
 */
export function roleRequests(
  roles: { role: string }[],
  values: Record<string, string>,
  keepEmpty = false,
): PreviewRoleRequest[] {
  return roles.flatMap(({ role }) => {
    const branch = (values[role] ?? '').trim();
    if (branch) return [{ role, branch }];
    return keepEmpty ? [{ role }] : [];
  });
}

/** One branch input per recipe role, with the role's remote branches as suggestions. */
export default function RoleBranchInputs({
  roles,
  values,
  onChange,
  disabled = false,
}: {
  roles: { role: string; repo: string }[];
  values: Record<string, string>;
  onChange: (role: string, branch: string) => void;
  disabled?: boolean;
}) {
  const idBase = useId();
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
  disabled,
}: {
  id: string;
  role: string;
  repo: string;
  value: string;
  onChange: (value: string) => void;
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
  const unknown =
    typed !== '' && typed === query && source !== null && !source.truncated && !source.branches.includes(typed);
  const base = listing?.defaultBranch;

  return (
    <div className="role-branch">
      <label className="role-branch-label" htmlFor={id}>
        <span className="role-branch-role">{role}</span>
        <span className="role-branch-repo mono">{repo}</span>
      </label>
      <div className="role-branch-field">
        <input
          id={id}
          className="launcher-input role-branch-input"
          list={`${id}-list`}
          placeholder={base ? `base branch (${base})` : 'base branch'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          aria-invalid={unknown || undefined}
          aria-describedby={unknown ? `${id}-hint` : undefined}
        />
        <datalist id={`${id}-list`}>
          {options.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
        {unknown && (
          <span id={`${id}-hint`} className="role-branch-hint">
            No branch {typed} in {repo}
          </span>
        )}
      </div>
    </div>
  );
}
