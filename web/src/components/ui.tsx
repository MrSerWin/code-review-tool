import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  MouseEvent,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';
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

/** `boxed` draws the pill with an outline and a steady dot, for headers. */
export function StatusPill({ status, boxed = false }: { status: ReviewStatus; boxed?: boolean }) {
  const active = status === 'queued' || status === 'fetching' || status === 'reviewing';
  return (
    <span className={`pill status-${status}${boxed ? ' pill-boxed' : ''}`}>
      {active ? (
        <span className="pulse" aria-hidden="true" />
      ) : (
        boxed && <span className="pill-dot" aria-hidden="true" />
      )}
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
          {actions && <div className="card-actions toolbar">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/*
 * Controls. Every button, select and input shares one scale (--ctl-* in
 * styles.css): `md` everywhere, `sm` only inside dense rows such as table
 * cells and the chain list.
 */

export type ControlSize = 'md' | 'sm';
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');

/** The class list of a button, for elements that must stay links (router `Link`). */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ControlSize = 'md', extra?: string): string {
  return cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', extra);
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ControlSize };

export function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}

/** An anchor that looks like a button: external pages, downloads. */
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ControlSize }) {
  return <a className={buttonClass(variant, size, className)} {...rest} />;
}

/** A square button holding only an icon; `label` is its accessible name and tooltip. */
export function IconButton({
  label,
  variant = 'ghost',
  size = 'md',
  className,
  type = 'button',
  children,
  ...rest
}: Omit<ButtonProps, 'aria-label'> & { label: string }) {
  return (
    <button
      type={type}
      className={buttonClass(variant, size, cx('btn-icon', className))}
      aria-label={label}
      {...rest}
      title={rest.title ?? label}
    >
      {children}
    </button>
  );
}

/** The dismiss control of cards, panels and inline editors. */
export function CloseButton({ onClick, label = 'Close', size = 'md' }: { onClick: () => void; label?: string; size?: ControlSize }) {
  return (
    <IconButton label={label} size={size} onClick={onClick}>
      <Icon name="close" />
    </IconButton>
  );
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: ControlSize; mono?: boolean };

export function Input({ size = 'md', mono = false, className, ...rest }: InputProps) {
  return <input className={cx('input', size === 'sm' && 'input-sm', mono && 'mono', className)} {...rest} />;
}

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & {
  size?: ControlSize;
  mono?: boolean;
  /** A short label drawn inside the control, left of the value ("data", "recipe"). */
  label?: string;
};

export function Select({ size = 'md', mono = false, label, className, ...rest }: SelectProps) {
  if (!label) {
    return <select className={cx('input', 'select', size === 'sm' && 'input-sm', mono && 'mono', className)} {...rest} />;
  }
  return (
    <label className={cx('input-group', size === 'sm' && 'input-group-sm', className)}>
      <span className="ig-label">{label}</span>
      <select className={cx('ig-field', 'ig-select', mono && 'mono')} {...rest} />
    </label>
  );
}

/** A form field with its label above the control; `grow` lets it take the free width. */
export function Field({ label, grow = false, children }: { label: ReactNode; grow?: boolean; children: ReactNode }) {
  return (
    <label className={cx('field', grow && 'field-grow')}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

/** One row of controls on a shared centre line; a `ToolbarSpacer` pushes what follows to the end. */
export function Toolbar({
  children,
  className,
  align = 'center',
}: {
  children: ReactNode;
  className?: string;
  /** `end` lines the controls up with the bottom of labelled `Field`s. */
  align?: 'center' | 'end';
}) {
  return <div className={cx('toolbar', align === 'end' && 'toolbar-end', className)}>{children}</div>;
}

export function ToolbarSpacer() {
  return <span className="toolbar-spacer" aria-hidden="true" />;
}

/** A row of mutually exclusive choices drawn as one joined control. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="segmented-btn"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type IconName = 'rerun' | 'download' | 'copy' | 'trash' | 'close' | 'up' | 'down' | 'chevron';

const ICON_PATHS: Record<IconName, string> = {
  rerun: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3',
  download: 'M8 2.5v8m0 0L4.8 7.3M8 10.5l3.2-3.2M3 13.5h10',
  copy: 'M5.5 5.5V3.2c0-.4.3-.7.7-.7h6.6c.4 0 .7.3.7.7v6.6c0 .4-.3.7-.7.7h-2.3M3.2 5.5h6.6c.4 0 .7.3.7.7v6.6c0 .4-.3.7-.7.7H3.2a.7.7 0 0 1-.7-.7V6.2c0-.4.3-.7.7-.7Z',
  trash: 'M2.5 4.5h11M6.5 4.5V3c0-.3.2-.5.5-.5h2c.3 0 .5.2.5.5v1.5M4 4.5l.6 8.4c0 .3.3.6.7.6h5.4c.4 0 .7-.3.7-.6l.6-8.4',
  close: 'M4 4l8 8M12 4l-8 8',
  up: 'M8 12.5v-9M4.5 7 8 3.5 11.5 7',
  down: 'M8 3.5v9M4.5 9 8 12.5 11.5 9',
  chevron: 'M6 3.5 10.5 8 6 12.5',
};

/** A 14px line icon; decorative, the control around it carries the name. */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d={ICON_PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** ‹ Prev · 1–20 of 143 · Next ›. Renders nothing while there is nothing to page. */
export function Pager({
  offset,
  limit,
  total,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  if (total <= 0) return null;
  const from = Math.min(offset + 1, total);
  const to = Math.min(offset + limit, total);
  return (
    <nav className="pager" aria-label="Pages">
      <Button variant="ghost" disabled={offset <= 0} onClick={() => onChange(Math.max(0, offset - limit))}>
        ‹ Prev
      </Button>
      <span className="muted mono" aria-live="polite">
        {from}–{to} of {total}
      </span>
      <Button variant="ghost" disabled={to >= total} onClick={() => onChange(offset + limit)}>
        Next ›
      </Button>
    </nav>
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

const stopPropagation = (e: MouseEvent): void => e.stopPropagation();

/**
 * A branch name opening its GitHub page in a new tab; plain text when the
 * server sent no link. Clicks never reach a clickable row around it.
 */
export function BranchLink({
  branch,
  href,
  local = false,
  className = '',
}: {
  branch: string;
  href: string | null | undefined;
  /** A local run: the branch may never have been pushed. */
  local?: boolean;
  className?: string;
}) {
  const classes = `branch-link mono ${className}`.trim();
  if (!href) {
    return (
      <span className={classes} title={branch}>
        {branch}
      </span>
    );
  }
  return (
    <a
      className={classes}
      href={href}
      target="_blank"
      rel="noreferrer"
      title={local ? `${branch} — local run — may not be pushed` : `${branch} — open on GitHub`}
      onClick={stopPropagation}
    >
      {branch}
    </a>
  );
}

/** `PR #12 ↗`, opening the pull request on GitHub in a new tab. */
export function PrLink({ href, number }: { href: string; number: number | null | undefined }) {
  const n = number ?? Number(/\/pull\/(\d+)/.exec(href)?.[1] ?? NaN);
  return (
    <a
      className="pr-link"
      href={href}
      target="_blank"
      rel="noreferrer"
      title={Number.isFinite(n) ? `Pull request #${n} on GitHub` : 'Pull request on GitHub'}
      onClick={stopPropagation}
    >
      PR{Number.isFinite(n) ? ` #${n}` : ''}
      <span className="link-arrow" aria-hidden="true">↗</span>
    </a>
  );
}

/** A small ↗ next to a ticket key, opening the ticket in its tracker. */
export function TicketExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      className="ext-link"
      href={href}
      target="_blank"
      rel="noreferrer"
      title={label}
      aria-label={label}
      onClick={stopPropagation}
    >
      ↗
    </a>
  );
}
