import type { DumpMode, Preview, PreviewRole, PreviewStatus } from '../types';

/** Statuses in which the preview is still working towards being clickable. */
export const PREVIEW_ACTIVE = new Set<PreviewStatus>([
  'queued',
  'preparing',
  'starting',
  'stopping',
]);

/** Statuses that still hold containers and ports, so Stop is meaningful. */
export const PREVIEW_LIVE = new Set<PreviewStatus>([
  'queued',
  'preparing',
  'starting',
  'ready',
  'stopping',
]);

/** The lifecycle a preview walks through, in display order. */
const PHASES: PreviewStatus[] = ['queued', 'preparing', 'starting', 'ready'];

const PHASE_LABEL: Record<string, string> = {
  queued: 'queued',
  preparing: 'preparing',
  starting: 'starting',
  ready: 'ready',
};

export function PreviewStatusPill({ preview }: { preview: Preview }) {
  const { status } = preview;
  const waiting = status === 'queued' && preview.queuePosition > 0;
  return (
    <span className={`pill pstatus-${status}`}>
      {PREVIEW_ACTIVE.has(status) && <span className="pulse" aria-hidden="true" />}
      {status}
      {waiting && <span className="muted"> #{preview.queuePosition}</span>}
    </span>
  );
}

/** Where the preview is in its lifecycle, without hiding a failure. */
export function PhaseTrack({ preview }: { preview: Preview }) {
  const { status } = preview;
  const failed = status === 'failed';
  const reachedIndex = PHASES.indexOf(status);
  return (
    <div className="phase-track" role="list" aria-label="Preview progress">
      {PHASES.map((phase, i) => {
        const done = reachedIndex > i || status === 'ready';
        const current = status === phase;
        const state = failed && reachedIndex < 0 ? 'phase-idle' : current ? 'phase-current' : done ? 'phase-done' : 'phase-idle';
        return (
          <span key={phase} role="listitem" className={`phase ${state}`}>
            <span className="phase-dot" aria-hidden="true" />
            {PHASE_LABEL[phase]}
            {current && phase === 'queued' && preview.queuePosition > 0 && (
              <span className="muted"> · #{preview.queuePosition} in line</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

const DUMP_LABEL: Record<DumpMode, string> = {
  'pg_dump': 'pg_dump',
  'dump-dir': 'dump-dir',
  clean: 'clean',
};

const DUMP_NOTE: Record<DumpMode, string> = {
  'pg_dump': 'Data was dumped from the live database when the preview started.',
  'dump-dir': 'Data was restored from a stored dump file.',
  clean:
    'No data: a clean install boots the app but the tenant is empty, so this is good for "does it run" and poor for "click through the feature".',
};

/** The data mode badge plus the one sentence that keeps it honest. */
export function DumpModeBadge({ mode, source }: { mode: DumpMode | null; source?: string | null }) {
  if (!mode) return <span className="tag">data pending</span>;
  return (
    <span className={`tag dump-${mode}`} title={source ?? DUMP_NOTE[mode]}>
      {DUMP_LABEL[mode]}
    </span>
  );
}

export function DumpModeNote({ mode }: { mode: DumpMode | null }) {
  if (!mode) return null;
  return <p className={`dump-note${mode === 'clean' ? ' dump-note-warn' : ''}`}>{DUMP_NOTE[mode]}</p>;
}

/** One chip per repo in the preview, flagging any role that is not under review. */
export function RoleChips({ roles }: { roles: PreviewRole[] }) {
  if (roles.length === 0) return <span className="muted">—</span>;
  return (
    <div className="role-row">
      {roles.map((r) => (
        <span
          key={r.role}
          className={`role-chip${r.usedBase ? ' role-base' : ''}`}
          title={
            r.usedBase
              ? `${r.repo}: no ticket branch to run (never had one, or it is gone from the remote); running its base branch ${r.base}`
              : `${r.repo}: ${r.branch} (base ${r.base})`
          }
        >
          <span className="role-name">{r.role}</span>
          <span className="mono role-branch">{r.usedBase ? r.base : r.branch}</span>
          {r.usedBase && <span className="role-flag">base branch</span>}
        </span>
      ))}
    </div>
  );
}

/** Roles running their base branch — the part of the stack that is not under review. */
export function baseRoles(roles: PreviewRole[]): PreviewRole[] {
  return roles.filter((r) => r.usedBase);
}

function humanMinutes(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** "3m ago" for a timestamp in the past. */
export function fmtAge(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = now - t;
  if (diff < 0) return 'just now';
  if (diff < 60000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  return `${humanMinutes(diff)} ago`;
}

/** "expires in 1h 12m", or a plain statement once it is gone. */
export function fmtExpiry(preview: Preview, now: number = Date.now()): string {
  if (preview.status === 'expired') return 'expired';
  if (!PREVIEW_LIVE.has(preview.status)) return '—';
  if (!preview.expires_at) return 'set once ready';
  const t = new Date(preview.expires_at).getTime();
  if (!Number.isFinite(t)) return '—';
  const left = t - now;
  if (left <= 0) return 'expiring now';
  return `in ${humanMinutes(left)}`;
}
