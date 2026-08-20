import type { ReactNode } from 'react';
import type { RequirementStatus, ReviewStatus, Severity, Verdict } from '../types';

const VERDICT_LABEL: Record<Verdict, string> = {
  approve: 'Approved',
  changes_requested: 'Changes requested',
  blocked: 'Blocked',
};

export function VerdictBadge({ verdict }: { verdict: Verdict | null }) {
  if (!verdict) return <span className="badge badge-idle">No verdict</span>;
  return <span className={`badge verdict-${verdict}`}>{VERDICT_LABEL[verdict]}</span>;
}

export function StatusPill({ status }: { status: ReviewStatus }) {
  const active = status === 'queued' || status === 'fetching' || status === 'reviewing';
  return (
    <span className={`pill status-${status}`}>
      {active && <span className="pulse" aria-hidden="true" />}
      {status}
    </span>
  );
}

export function SeverityTag({ severity }: { severity: Severity }) {
  return <span className={`tag sev-${severity}`}>{severity}</span>;
}

const REQ_ICON: Record<RequirementStatus, string> = {
  met: '✓',
  partial: '~',
  missing: '✕',
  not_verifiable: '?',
};

export function RequirementStatusTag({ status }: { status: RequirementStatus }) {
  return (
    <span className={`tag req-${status}`}>
      <span aria-hidden="true">{REQ_ICON[status]}</span> {status.replace('_', ' ')}
    </span>
  );
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          <h2>{title}</h2>
          <div className="card-actions">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtDuration(from: string | null, to: string | null): string {
  if (!from || !to) return '—';
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
