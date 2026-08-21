import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import {
  DumpModeBadge,
  PREVIEW_LIVE,
  PreviewStatusPill,
  RoleChips,
  baseRoles,
  fmtAge,
  fmtExpiry,
} from '../components/preview';
import { Card } from '../components/ui';
import { Link } from '../router';
import type { Preview, PreviewLogLine, RecipesPayload } from '../types';

/** Lines of log shown inline when a row is expanded. */
const TAIL = 25;

export default function Previews() {
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [recipes, setRecipes] = useState<RecipesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [openId, setOpenId] = useState<number | null>(null);
  const [openLogs, setOpenLogs] = useState<PreviewLogLine[]>([]);

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

      <Card>
        {previews.length === 0 ? (
          <p className="muted">
            No previews yet. Start one from a review page: open a review and use the Preview card.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th>Recipe</th>
                  <th>Ticket</th>
                  <th>Branches</th>
                  <th>Status</th>
                  <th>URL</th>
                  <th>Data</th>
                  <th>Age</th>
                  <th>Expires</th>
                  <th />
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
                        {p.ticket_key ? (
                          <Link to={`/ticket/${p.ticket_key}`} className="mono">
                            {p.ticket_key}
                          </Link>
                        ) : (
                          <span className="muted">—</span>
                        )}
                        {p.review_id !== null && (
                          <>
                            {' '}
                            <Link to={`/review/${p.review_id}`} className="mono muted">
                              review
                            </Link>
                          </>
                        )}
                      </td>
                      <td>
                        <RoleChips roles={p.roles} />
                        {bases.length > 0 && (
                          <p className="role-warning">
                            {bases.map((r) => r.role).join(', ')} on base branch, not under review
                          </p>
                        )}
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
                          <a className="mono" href={p.url} target="_blank" rel="noreferrer">
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
                      <td className="row-actions">
                        {PREVIEW_LIVE.has(p.status) && (
                          <button
                            className="btn ghost"
                            type="button"
                            onClick={() => void stop(p)}
                            disabled={busy === p.id}
                          >
                            Stop
                          </button>
                        )}
                        <button
                          className="btn danger"
                          type="button"
                          onClick={() => void remove(p)}
                          disabled={busy === p.id}
                        >
                          Delete
                        </button>
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
