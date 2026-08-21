import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Link } from '../router';
import type {
  DumpModeRequest,
  Preview,
  PreviewLogLine,
  PreviewSseEvent,
  Recipe,
  RecipesPayload,
} from '../types';
import {
  DumpModeBadge,
  DumpModeNote,
  PhaseTrack,
  PREVIEW_LIVE,
  PreviewStatusPill,
  RoleChips,
  baseRoles,
  fmtAge,
  fmtExpiry,
} from './preview';
import { Card, fmtTime } from './ui';

const DUMP_CHOICES: { value: DumpModeRequest; label: string }[] = [
  { value: 'auto', label: 'data: auto' },
  { value: 'pg_dump', label: 'data: fresh dump' },
  { value: 'dump-dir', label: 'data: stored dump' },
  { value: 'clean', label: 'data: clean install' },
];

/** How many log lines a failed preview shows without the user asking. */
const FAILURE_TAIL = 20;

export default function PreviewPanel({
  reviewId,
  repo,
  branch,
}: {
  reviewId: number;
  repo: string;
  branch: string;
}) {
  const [recipes, setRecipes] = useState<RecipesPayload | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [others, setOthers] = useState(0);
  const [logs, setLogs] = useState<PreviewLogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dumpMode, setDumpMode] = useState<DumpModeRequest>('auto');
  const [logOpen, setLogOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api.recipes().then(setRecipes).catch(() => setRecipes(null));
  }, []);

  const loadList = useCallback(async () => {
    try {
      const { previews } = await api.listPreviews({ reviewId, limit: 20 });
      setPreview(previews[0] ?? null);
      setOthers(Math.max(0, previews.length - 1));
      if (previews[0]) {
        const detail = await api.preview(previews[0].id);
        setPreview(detail.preview);
        setLogs(detail.logs);
      } else {
        setLogs([]);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [reviewId]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const reload = useCallback(async (id: number) => {
    try {
      const detail = await api.preview(id);
      setPreview(detail.preview);
      setLogs(detail.logs);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const streamId = preview && PREVIEW_LIVE.has(preview.status) ? preview.id : null;

  useEffect(() => {
    if (streamId === null) return;
    const source = new EventSource(api.previewEventsUrl(streamId));
    source.onmessage = (ev) => {
      let evt: PreviewSseEvent;
      try {
        evt = JSON.parse(ev.data) as PreviewSseEvent;
      } catch {
        return;
      }
      if (evt.type === 'log') {
        setLogs((prev) => [
          ...prev.slice(-800),
          {
            id: -Date.now() - prev.length,
            preview_id: streamId,
            ts: evt.ts ?? new Date().toISOString(),
            level: (evt.level as PreviewLogLine['level']) ?? 'info',
            message: evt.message ?? '',
          },
        ]);
      } else if (evt.type === 'status') {
        setPreview((prev) => (prev && prev.id === streamId ? { ...prev, status: evt.status } : prev));
        // Ready and terminal statuses carry the URL, data mode and expiry.
        void reload(streamId);
      }
    };
    source.onerror = () => {
      /* EventSource retries on its own */
    };
    return () => source.close();
  }, [streamId, reload]);

  // A live preview has a countdown; nothing else needs a ticking clock.
  useEffect(() => {
    if (streamId === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [streamId]);

  useEffect(() => {
    if (logOpen || preview?.status === 'failed') logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [logs.length, logOpen, preview?.status]);

  const recipe = useMemo<Recipe | null>(() => {
    if (!recipes?.enabled) return null;
    return recipes.recipes.find((r) => r.roles.some((role) => role.repo === repo)) ?? null;
  }, [recipes, repo]);

  if (!recipe) return null;

  const start = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { preview: created } = await api.createPreview({
        reviewId,
        recipe: recipe.name,
        ...(dumpMode === 'auto' ? {} : { dumpMode }),
      });
      setPreview(created);
      setLogs([]);
      setLogOpen(true);
      if (preview) setOthers((n) => n + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      await api.stopPreview(preview.id);
      await reload(preview.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!preview) return;
    if (!window.confirm('Stop this preview and delete its record?')) return;
    setBusy(true);
    setError(null);
    try {
      await api.removePreview(preview.id);
      await loadList();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const live = preview ? PREVIEW_LIVE.has(preview.status) : false;
  const failed = preview?.status === 'failed';
  const ready = preview?.status === 'ready';
  const tail = failed && !logOpen ? logs.slice(-FAILURE_TAIL) : logs;

  return (
    <Card
      title={
        <>
          Preview <span className="tag tracker">{recipe.name}</span>
        </>
      }
      actions={
        <>
          {!live && (
            <>
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
              <button className="btn primary" type="button" onClick={() => void start()} disabled={busy}>
                {busy ? 'Starting…' : preview ? 'Start again' : 'Start preview'}
              </button>
            </>
          )}
          {live && (
            <button className="btn ghost" type="button" onClick={() => void stop()} disabled={busy}>
              Stop
            </button>
          )}
          {preview && (
            <button className="btn danger" type="button" onClick={() => void remove()} disabled={busy}>
              Delete
            </button>
          )}
        </>
      }
    >
      {error && <p className="error-line">{error}</p>}

      {!preview && (
        <div className="preview-intro">
          <p className="muted">
            Runs {recipe.roles.map((r) => r.repo).join(' + ')} from this ticket&rsquo;s branches on a local
            port. A repo without a branch of its own runs its base branch.
          </p>
          <p className="muted mono">
            {branch} · {recipe.database ? `${recipe.database.engine} ${recipe.database.version ?? ''}` : 'no database'}{' '}
            · ready timeout {Math.round(recipe.readyTimeoutSec / 60)}m
          </p>
        </div>
      )}

      {preview && (
        <div className="preview-body">
          <div className="preview-head">
            <PreviewStatusPill preview={preview} />
            <DumpModeBadge mode={preview.dump_mode} source={preview.dump_source} />
            <span className="muted mono">#{preview.id}</span>
            <span className="muted">started {fmtAge(preview.created_at, now)}</span>
          </div>

          {live && !ready && <PhaseTrack preview={preview} />}

          {ready && preview.url && (
            <a className="preview-url" href={preview.url} target="_blank" rel="noreferrer">
              {preview.url} <span aria-hidden="true">↗</span>
            </a>
          )}

          {preview.status === 'expired' && (
            <p className="notice-line">
              This preview reached its time limit and was torn down. Start it again to get a fresh one.
            </p>
          )}

          {failed && preview.error && <p className="error-line">{preview.error}</p>}

          <DumpModeNote mode={preview.dump_mode} />

          <dl className="meta">
            <dt>Branches</dt>
            <dd>
              <RoleChips roles={preview.roles} />
              {baseRoles(preview.roles).length > 0 && (
                <p className="role-warning">
                  {baseRoles(preview.roles)
                    .map((r) => r.role)
                    .join(', ')}{' '}
                  {baseRoles(preview.roles).length === 1 ? 'is' : 'are'} not under review here — running the
                  base branch.
                </p>
              )}
            </dd>
            {Object.keys(preview.ports).length > 0 && (
              <>
                <dt>Ports</dt>
                <dd className="mono">
                  {Object.entries(preview.ports)
                    .map(([id, port]) => `${id} ${port}`)
                    .join(' · ')}
                </dd>
              </>
            )}
            {preview.dump_source && (
              <>
                <dt>Data from</dt>
                <dd className="mono muted">{preview.dump_source}</dd>
              </>
            )}
            <dt>Expires</dt>
            <dd className={preview.status === 'expired' ? 'muted' : ''}>
              {fmtExpiry(preview, now)}
              {preview.expires_at && PREVIEW_LIVE.has(preview.status) && (
                <span className="muted"> · {fmtTime(preview.expires_at)}</span>
              )}
            </dd>
            {ready && preview.credentials_hint && (
              <>
                <dt>Sign in</dt>
                <dd>
                  <pre className="credentials">{preview.credentials_hint}</pre>
                </dd>
              </>
            )}
          </dl>

          <div className="preview-log-head">
            <button className="manual-toggle" type="button" onClick={() => setLogOpen((v) => !v)}>
              {logOpen ? '▾' : '▸'} Log{live ? ' · live' : ''}
              {failed && !logOpen ? <span className="muted"> (last {FAILURE_TAIL} lines shown)</span> : null}
            </button>
            {others > 0 && (
              <Link to="/previews" className="mono">
                {others} earlier preview{others === 1 ? '' : 's'}
              </Link>
            )}
          </div>

          {(logOpen || live || failed) && (
            <div className="log log-compact">
              {tail.length === 0 && <div className="muted">No log output yet.</div>}
              {tail.map((l) => (
                <div key={l.id} className={`log-line log-${l.level}`}>
                  <span className="log-ts">{(l.ts ?? '').slice(11, 19)}</span>
                  <span className="log-msg">{l.message}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
