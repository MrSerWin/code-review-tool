import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import {
  DUMP_CHOICES,
  DumpModeBadge,
  PREVIEW_LIVE,
  PreviewStatusPill,
  RoleChips,
  TicketLabel,
  baseRoles,
  fmtAge,
  fmtExpiry,
} from '../components/preview';
import RoleBranchInputs, { roleRequests } from '../components/RoleBranchInputs';
import { Card } from '../components/ui';
import { Link } from '../router';
import { readStored, writeStored } from '../storage';
import type { DumpModeRequest, Preview, PreviewLogLine, PreviewRoleRequest, RecipesPayload } from '../types';

/** Lines of log shown inline when a row is expanded. */
const TAIL = 25;

/** Start from a ticket (branches resolved) or from branches picked per role. */
type StartMode = 'ticket' | 'custom';
const START_MODE_KEY = 'crt.previewStartMode';

export default function Previews() {
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [recipes, setRecipes] = useState<RecipesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [openId, setOpenId] = useState<number | null>(null);
  const [openLogs, setOpenLogs] = useState<PreviewLogLine[]>([]);
  // The start form: a ticket (or PR URL / repo#branch), which recipe to run, and what data to load.
  const [ticket, setTicket] = useState('');
  const [recipeName, setRecipeName] = useState('');
  const [dumpMode, setDumpMode] = useState<DumpModeRequest>('auto');
  const [starting, setStarting] = useState(false);
  const [startMode, setStartMode] = useState<StartMode>(() =>
    readStored(START_MODE_KEY) === 'custom' ? 'custom' : 'ticket',
  );
  // Custom mode: the branch typed per role; empty runs the role's base branch.
  const [branches, setBranches] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const { previews: rows } = await api.listPreviews({ limit: 100 });
      setPreviews(rows);
      setNow(Date.now());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openRow = useCallback(async (id: number | null) => {
    setOpenId(id);
    setOpenLogs([]);
    if (id === null) return;
    try {
      const detail = await api.preview(id);
      setOpenLogs(detail.logs.slice(-TAIL));
      setPreviews((prev) => prev.map((row) => (row.id === id ? detail.preview : row)));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // An open row keeps up with a preview that is still working.
  useEffect(() => {
    if (openId === null) return;
    const row = previews.find((p) => p.id === openId);
    if (!row || !PREVIEW_LIVE.has(row.status)) return;
    const timer = window.setInterval(() => {
      api
        .preview(openId)
        .then((detail) => setOpenLogs(detail.logs.slice(-TAIL)))
        .catch(() => undefined);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [openId, previews]);

  useEffect(() => {
    api.recipes().then(setRecipes).catch(() => setRecipes(null));
  }, []);

  // Same cadence as the review history: one poller, no second mechanism.
  useEffect(() => {
    if (!previews.some((p) => PREVIEW_LIVE.has(p.status))) return;
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [previews, load]);

  const stop = async (p: Preview): Promise<void> => {
    setBusy(p.id);
    try {
      await api.stopPreview(p.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (p: Preview): Promise<void> => {
    if (!window.confirm(`Stop preview #${p.id} and delete its record?`)) return;
    setBusy(p.id);
    try {
      await api.removePreview(p.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const disabled = recipes !== null && !recipes.enabled;
  const canStart = recipes !== null && recipes.enabled && recipes.recipes.length > 0;

  // A single recipe needs no picking: run it implicitly.
  const recipe = recipes?.recipes.find((r) => r.name === recipeName) ?? recipes?.recipes[0] ?? null;

  const switchStartMode = (next: StartMode): void => {
    setStartMode(next);
    writeStored(START_MODE_KEY, next);
  };

  const launch = async (from: { ticket?: string; roles?: PreviewRoleRequest[] }): Promise<void> => {
    if (!canStart || !recipe) return;
    setStarting(true);
    setError(null);
    try {
      const { preview: created } = await api.createPreview({
        ...from,
        recipe: recipe.name,
        ...(dumpMode === 'auto' ? {} : { dumpMode }),
      });
      await load();
      await openRow(created.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const start = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (startMode === 'custom') {
      // Only the roles given a branch; the rest run their base branch.
      if (recipe) await launch({ roles: roleRequests(recipe.roles, branches) });
      return;
    }
    if (ticket.trim()) await launch({ ticket: ticket.trim() });
  };

  const recipeSelect = recipes && recipes.recipes.length > 1 && (
    <select
      className="mini-select"
      value={recipe?.name ?? ''}
      onChange={(e) => setRecipeName(e.target.value)}
      aria-label="Recipe to run"
    >
      {recipes.recipes.map((r) => (
        <option key={r.name} value={r.name}>
          {r.name}
        </option>
      ))}
    </select>
  );

  const dumpSelect = (
    <select
      className="mini-select"
      value={dumpMode}
      onChange={(e) => setDumpMode(e.target.value as DumpModeRequest)}
      aria-label="Database contents for the preview"
    >
      {DUMP_CHOICES.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Previews</h1>
        <span className="muted">
          {previews.filter((p) => PREVIEW_LIVE.has(p.status)).length} running · {previews.length} total
        </span>
      </div>

      {error && <p className="error-line">{error}</p>}
      {disabled && <p className="notice-line">Previews are disabled. Set PREVIEW_ENABLED and configure a recipe.</p>}
      {recipes?.errors.map((e) => (
        <p key={e.file} className="error-line">
          {e.error}
        </p>
      ))}

      {canStart && recipe && (
        <Card
          title="Start a preview"
          actions={
            <div className="mode-switch" role="group" aria-label="Start the preview from">
              {(['ticket', 'custom'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`btn btn-sm${startMode === m ? ' primary' : ' ghost'}`}
                  aria-pressed={startMode === m}
                  onClick={() => switchStartMode(m)}
                >
                  {m === 'ticket' ? 'From ticket' : 'Custom branches'}
                </button>
              ))}
            </div>
          }
        >
          {startMode === 'ticket' ? (
            <>
              <form className="launcher" onSubmit={(e) => void start(e)}>
                <input
                  className="launcher-input"
                  placeholder="ABC-123, PR URL, or repo#branch"
                  value={ticket}
                  spellCheck={false}
                  onChange={(e) => setTicket(e.target.value)}
                />
                {recipeSelect}
                {dumpSelect}
                <button className="btn primary" type="submit" disabled={starting || !ticket.trim()}>
                  {starting ? 'Starting…' : 'Start preview'}
                </button>
              </form>
              <p className="muted">
                Branches are resolved from the ticket. A repo without a branch of its own runs its base branch.
              </p>
            </>
          ) : (
            <form className="custom-launch" onSubmit={(e) => void start(e)}>
              <RoleBranchInputs
                roles={recipe.roles}
                values={branches}
                onChange={(role, value) => setBranches((prev) => ({ ...prev, [role]: value }))}
                disabled={starting}
              />
              <div className="custom-launch-foot">
                <p className="muted custom-launch-hint">
                  Pick a branch for each repo, from any ticket. Leave one empty to run its base branch.
                </p>
                <div className="custom-launch-actions">
                  {recipeSelect}
                  {dumpSelect}
                  <button className="btn primary" type="submit" disabled={starting}>
                    {starting ? 'Starting…' : 'Start preview'}
                  </button>
                </div>
              </div>
            </form>
          )}
        </Card>
      )}

      <Card>
        {previews.length === 0 ? (
          <p className="muted">
            No previews yet. Start one with the form above, or from a review page&rsquo;s Preview card.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="grid previews-table">
              <thead>
                <tr>
                  <th>Recipe</th>
                  <th>Ticket</th>
                  <th className="col-branches">Branches</th>
                  <th>Status</th>
                  <th>URL</th>
                  <th>Data</th>
                  <th>Age</th>
                  <th>Expires</th>
                  <th className="col-actions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {previews.flatMap((p) => {
                  const bases = baseRoles(p.roles);
                  const open = openId === p.id;
                  return [
                    <tr key={p.id} className={open ? 'row-open' : undefined}>
                      <td>
                        <span className="mono">{p.recipe}</span>{' '}
                        <span className="muted mono">#{p.id}</span>
                      </td>
                      <td>
                        {p.ticket_key ? <TicketLabel ticketKey={p.ticket_key} /> : <span className="muted">—</span>}
                        {p.review_id !== null && (
                          <Link to={`/review/${p.review_id}`} className="mono muted cell-sub">
                            review #{p.review_id}
                          </Link>
                        )}
                      </td>
                      <td className="col-branches">
                        <div className="role-cell">
                          <RoleChips roles={p.roles} />
                          {bases.length > 0 && (
                            <p className="role-warning">
                              {bases.map((r) => r.role).join(', ')} on base branch, not under review
                            </p>
                          )}
                        </div>
                      </td>
                      <td>
                        <button
                          className="status-toggle"
                          type="button"
                          aria-expanded={open}
                          onClick={() => void openRow(open ? null : p.id)}
                          title="Show the preview log"
                        >
                          <PreviewStatusPill preview={p} />
                        </button>
                        {p.status === 'failed' && p.error && (
                          <p className="cell-error mono" title={p.error}>
                            {p.error}
                          </p>
                        )}
                      </td>
                      <td>
                        {p.status === 'ready' && p.url ? (
                          <a className="mono nowrap" href={p.url} target="_blank" rel="noreferrer">
                            {p.url.replace(/^https?:\/\//, '')} ↗
                          </a>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <DumpModeBadge mode={p.dump_mode} source={p.dump_source} />
                        {p.dump_mode === 'clean' && <p className="role-warning">empty tenant</p>}
                      </td>
                      <td className="muted nowrap">{fmtAge(p.created_at, now)}</td>
                      <td className="muted nowrap">{fmtExpiry(p, now)}</td>
                      <td className="col-actions">
                        <div className="row-actions">
                          {PREVIEW_LIVE.has(p.status) && (
                            <button
                              className="btn ghost btn-sm"
                              type="button"
                              onClick={() => void stop(p)}
                              disabled={busy === p.id}
                            >
                              Stop
                            </button>
                          )}
                          <button
                            className="btn danger btn-sm"
                            type="button"
                            onClick={() => void remove(p)}
                            disabled={busy === p.id}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>,
                    open ? (
                      <tr key={`${p.id}-log`} className="row-open">
                        <td colSpan={9}>
                          {p.error && <p className="error-line">{p.error}</p>}
                          <div className="log log-compact">
                            {openLogs.length === 0 && <div className="muted">No log output.</div>}
                            {openLogs.map((l) => (
                              <div key={l.id} className={`log-line log-${l.level}`}>
                                <span className="log-ts">{(l.ts ?? '').slice(11, 19)}</span>
                                <span className="log-msg">{l.message}</span>
                              </div>
                            ))}
                          </div>
                          {p.credentials_hint && p.status === 'ready' && (
                            <pre className="credentials">{p.credentials_hint}</pre>
                          )}
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
