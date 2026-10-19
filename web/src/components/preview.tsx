import { Link } from '../router';
import type { DumpMode, DumpModeRequest, Preview, PreviewLink, PreviewRole, PreviewStatus } from '../types';

/** Database contents offered when starting a preview, shared by every start form. */
export const DUMP_CHOICES: { value: DumpModeRequest; label: string }[] = [
  { value: 'auto', label: 'data: auto' },
  { value: 'pg_dump', label: 'data: fresh dump' },
  { value: 'dump-dir', label: 'data: stored dump' },
  { value: 'clean', label: 'data: clean install' },
];

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

/** One line per repo in the preview, flagging any role that is not under review. */
export function RoleChips({ roles }: { roles: PreviewRole[] }) {
  if (roles.length === 0) return <span className="muted">—</span>;
  return (
    <ul className="role-list">
      {roles.map((r) => {
        const branch = r.usedBase ? r.base : r.branch;
        const local = r.source === 'local';
        const at = r.sha ? ` @ ${r.sha.slice(0, 7)}` : '';
        const title = r.usedBase
          ? `${r.repo}: ${branch}${at}. No ticket branch to run (never had one, or it is gone from the remote), so the base branch runs.`
          : `${r.repo}: ${branch}${at} (base ${r.base})${local ? ', copied from the local clone' : ''}`;
        return (
          <li key={r.role} className={`role-chip${r.usedBase ? ' role-base' : ''}`}>
            <span className="role-name" title={r.role}>
              {r.role}
            </span>
            {r.url ? (
              <a className="role-branch" href={r.url} target="_blank" rel="noreferrer" title={`${title} Open on GitHub.`}>
                {branch}
              </a>
            ) : (
              <span className="role-branch" title={title}>
                {branch}
              </span>
            )}
            {local && (
              <span className="tag local role-source" title="Copied from the local clone; may not be pushed yet">
                local
              </span>
            )}
            {r.usedBase && (
              <span className="tag role-flag" title={title}>
                base branch
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The preview's links, primary first; a bare `url` stands in when the server sent none. */
export function previewLinksOf(preview: Preview): PreviewLink[] {
  if (preview.links?.length) return preview.links;
  return preview.url ? [{ label: 'app', url: preview.url, port_id: '', primary: true }] : [];
}

const shortUrl = (url: string): string => url.replace(/^https?:\/\//, '');

/**
 * Every address of a ready preview. `card` puts the primary link in the big
 * button and the rest in a compact list under it; `row` is one compact line each.
 */
export function PreviewLinks({ preview, variant }: { preview: Preview; variant: 'card' | 'row' }) {
  const links = previewLinksOf(preview);
  if (links.length === 0) return null;
  const [first, ...rest] = links;
  const lead = variant === 'card' && first?.primary ? first : null;
  const listed = lead ? rest : links;
  return (
    <>
      {lead && (
        <a className="preview-url" href={lead.url} target="_blank" rel="noreferrer" title={lead.label}>
          {lead.url} <span aria-hidden="true">↗</span>
        </a>
      )}
      {listed.length > 0 && (
        <ul className={`preview-links preview-links-${variant}`}>
          {listed.map((link) => (
            <li key={`${link.port_id}:${link.url}`} className={link.primary ? 'preview-link-primary' : undefined}>
              <span className="preview-link-label">{link.label}</span>
              <a className="mono" href={link.url} target="_blank" rel="noreferrer" title={link.url}>
                {shortUrl(link.url)} <span aria-hidden="true">↗</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** How a preview's ticket reads in a narrow column, and where it leads. */
export interface TicketDisplay {
  label: string;
  href: string;
  external: boolean;
}

function decodeRef(ref: string): string {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

/**
 * A ticket key as is; a pull request (URL or `org/repo#N`) as `repo#N`; a tree
 * URL as `repo#branch`. URLs open GitHub, everything else the ticket's page.
 */
export function ticketDisplay(key: string): TicketDisplay {
  const value = key.trim();
  const pr = /^https?:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/i.exec(value);
  if (pr) return { label: `${pr[1]}#${pr[2]}`, href: value, external: true };
  const tree = /^https?:\/\/github\.com\/[^/]+\/([^/]+)\/tree\/(.+?)\/?$/i.exec(value);
  if (tree) return { label: `${tree[1]}#${decodeRef(tree[2] ?? '')}`, href: value, external: true };
  if (/^https?:\/\//i.test(value)) return { label: value.replace(/^https?:\/\//i, ''), href: value, external: true };
  const shortPr = /^[^/\s#]+\/([^/\s#]+)#(\d+)$/.exec(value);
  return {
    label: shortPr ? `${shortPr[1]}#${shortPr[2]}` : value,
    href: `/ticket/${encodeURIComponent(value)}`,
    external: false,
  };
}

/** The ticket a preview was started for, shortened, with the full value on hover. */
export function TicketLabel({ ticketKey }: { ticketKey: string }) {
  const t = ticketDisplay(ticketKey);
  return t.external ? (
    <a className="mono ticket-label" href={t.href} target="_blank" rel="noreferrer" title={ticketKey}>
      {t.label}
    </a>
  ) : (
    <Link to={t.href} className="mono ticket-label" title={ticketKey}>
      {t.label}
    </Link>
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
