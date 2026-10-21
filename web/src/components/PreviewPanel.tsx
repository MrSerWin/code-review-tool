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
  DumpSelect,
  DumpModeNote,
  PhaseTrack,
  PREVIEW_LIVE,
  PreviewLinks,
  PreviewStatusPill,
  RoleChips,
  baseRoles,
  fmtAge,
  fmtExpiry,
} from './preview';
import RoleBranchInputs, { roleRequests } from './RoleBranchInputs';
import { Button, Card, fmtTime } from './ui';

/** How many log lines a failed preview shows without the user asking. */
const FAILURE_TAIL = 20;

export default function PreviewPanel({
  reviewId,
  repo,
  branch,
  source = 'github',
}: {
  reviewId: number;
  repo: string;
  branch: string;
  /** A local review's branch runs from its review checkout while that is on disk, else from the clone again. */
  source?: 'github' | 'local';
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
  // Custom launch: branches picked per role instead of resolved from the ticket.
  const [custom, setCustom] = useState(false);
  const [branches, setBranches] = useState<Record<string, string>>({});
  const [localRoles, setLocalRoles] = useState<Record<string, boolean>>({});
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCustom(false);
  }, [reviewId]);

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
        // Every role is sent: an empty one runs its base branch, not the ticket's branch.
        ...(custom ? { roles: roleRequests(recipe.roles, branches, true, localRoles) } : {}),
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

  /**
   * Opens the custom launch prefilled with what the ticket would run: this
   * review's branch for its repo, and for the others the branch the last
   * preview ran (empty, so the base branch, when it ran the base or there is none).
   */
  const toggleCustom = (): void => {
    if (custom) {
      setCustom(false);
      return;
    }
    const prefill: Record<string, string> = {};
    const prefillLocal: Record<string, boolean> = {};
    for (const r of recipe.roles) {
      if (r.repo === repo) {
        prefill[r.role] = branch;
        prefillLocal[r.role] = source === 'local';
        continue;
      }
      const last = preview?.roles.find((p) => p.role === r.role && p.repo === r.repo && !p.usedBase);
      prefill[r.role] = last?.branch ?? '';
      prefillLocal[r.role] = last?.source === 'local';
    }
    setBranches(prefill);
    setLocalRoles(prefillLocal);
    setCustom(true);
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
              <Button
                variant="ghost"
                aria-pressed={custom}
                onClick={toggleCustom}
                title="Pick the branch of each repo by hand"
              >
                Custom…
              </Button>
              <DumpSelect value={dumpMode} onChange={setDumpMode} disabled={busy} />
              <Button variant="primary" onClick={() => void start()} disabled={busy}>
                {busy ? 'Starting…' : preview ? 'Start again' : 'Start preview'}
              </Button>
            </>
          )}
          {live && (
            <Button
              variant="danger"
              onClick={() => void stop()}
              disabled={busy || preview?.status === 'stopping'}
              title={preview?.status === 'stopping' ? 'Teardown is running' : undefined}
            >
              Stop
            </Button>
          )}
          {preview && (
            <Button variant="danger" onClick={() => void remove()} disabled={busy}>
              Delete
            </Button>
          )}
        </>
      }
    >
      {error && <p className="error-line">{error}</p>}

      {custom && !live && (
        <div className="preview-custom">
          <RoleBranchInputs
            roles={recipe.roles}
            values={branches}
            onChange={(role, value) => setBranches((prev) => ({ ...prev, [role]: value }))}
            local={localRoles}
            onLocalChange={(role, value) => setLocalRoles((prev) => ({ ...prev, [role]: value }))}
            disabled={busy}
          />
          <p className="muted custom-launch-hint">
            Start preview runs these branches. Leave one empty to run its base branch. Local copies the committed
            branch from the local clone.
          </p>
        </div>
      )}

      {!preview && !custom && (
        <div className="preview-intro">
          <p className="muted">
            Runs {recipe.roles.map((r) => r.repo).join(' + ')} from this ticket&rsquo;s branches on a local
            port. A repo without a branch of its own runs its base branch.
            {source === 'local' && (
              <>
                {' '}
                <span className="tag local" title="Read from the local clone; may not be pushed yet">
                  local run
                </span>{' '}
                {repo} runs the reviewed commit while the review&rsquo;s checkout is on disk, otherwise the
                branch is copied from the local clone again (committed state).
              </>
            )}
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

          {ready && <PreviewLinks preview={preview} variant="card" />}

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
