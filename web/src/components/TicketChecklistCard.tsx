import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { TicketChecklist, TicketRequirement } from '../types';
import { Button, Card, Icon, IconButton, Input, fmtTime } from './ui';

/** `R12`: the id every review and coverage pass uses for the item. */
export function requirementRef(id: number): string {
  return `R${id}`;
}

/**
 * The ticket's stored requirement checklist: derived once from the ticket,
 * then edited here. Every branch review and the coverage evaluate these items
 * by id. Edits save at once (the whole list in order).
 */
export default function TicketChecklistCard({ ticketKey, live = false }: { ticketKey: string; live?: boolean }) {
  const [list, setList] = useState<TicketChecklist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [draft, setDraft] = useState('');
  const [showRemoved, setShowRemoved] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.ticketRequirements(ticketKey));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [ticketKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // A derivation runs for a minute or two, and the first review of the ticket starts one: follow both.
  const deriving = Boolean(list?.deriving);
  useEffect(() => {
    if (!deriving && !live) return;
    const timer = window.setInterval(() => void load(), deriving ? 3000 : 5000);
    return () => window.clearInterval(timer);
  }, [deriving, live, load]);

  const save = async (items: { id?: number; text: string }[]): Promise<void> => {
    setBusy(true);
    try {
      setList(await api.setTicketRequirements(ticketKey, { items }));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const current = (list?.items ?? []).map((r) => ({ id: r.id, text: r.text }));

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= current.length) return;
    const next = [...current];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    void save(next);
  };

  const rederive = async (): Promise<void> => {
    const derived = (list?.items ?? []).filter((r) => r.source === 'derived').length;
    const user = (list?.items ?? []).filter((r) => r.source === 'user').length;
    const ok = window.confirm(
      `Derive the checklist of ${ticketKey} again from the ticket and its comments?\n\n` +
        `The ${derived} derived item(s) are replaced (an unchanged text keeps its id). ` +
        `Your ${user} item(s) added or edited by hand stay.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      setList(await api.deriveTicketRequirements(ticketKey));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const items = list?.items ?? [];
  const removed = list?.removed ?? [];
  return (
    <Card
      title={`Requirement checklist · ${items.length}`}
      actions={
        <Button size="sm" disabled={busy || deriving} onClick={() => void rederive()} title="Derive the items again from the ticket">
          {deriving ? 'Deriving…' : 'Re-derive'}
        </Button>
      }
    >
      <p className="muted ticket-hint">
        Every branch review and the coverage check exactly these items, by id.{' '}
        {list?.derived_at
          ? `Derived ${fmtTime(list.derived_at)}; edits apply to the next review.`
          : 'Derived by the first review of the ticket, or with Re-derive.'}
      </p>
      {error && <p className="error-line">{error}</p>}
      {list?.derive_error && !deriving && (
        <p className="notice-line">The last derivation failed: {list.derive_error.error}</p>
      )}
      {deriving && <p className="notice-line">Deriving the checklist from the ticket; this card updates on its own.</p>}
      {items.length === 0 ? (
        <p className="muted">No items yet.</p>
      ) : (
        <ol className="checklist">
          {items.map((r, index) => (
            <li key={r.id} className="checklist-item">
              <span className="mono muted checklist-id">{requirementRef(r.id)}</span>
              {editing?.id === r.id ? (
                <form
                  className="checklist-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = editing.text.trim();
                    if (!text) return;
                    setEditing(null);
                    void save(current.map((c) => (c.id === r.id ? { id: c.id, text } : c)));
                  }}
                >
                  <Input
                    size="sm"
                    autoFocus
                    value={editing.text}
                    aria-label={`Text of ${requirementRef(r.id)}`}
                    onChange={(e) => setEditing({ id: r.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                  <Button size="sm" variant="primary" type="submit" disabled={busy}>
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <span className="checklist-text">{r.text}</span>
              )}
              <SourceTag item={r} />
              <span className="checklist-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || editing !== null}
                  onClick={() => setEditing({ id: r.id, text: r.text })}
                >
                  Edit
                </Button>
                <IconButton size="sm" label="Move up" disabled={busy || index === 0} onClick={() => move(index, index - 1)}>
                  <Icon name="up" />
                </IconButton>
                <IconButton
                  size="sm"
                  label="Move down"
                  disabled={busy || index === items.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <Icon name="down" />
                </IconButton>
                <IconButton
                  size="sm"
                  label={`Remove ${requirementRef(r.id)}`}
                  disabled={busy}
                  onClick={() => void save(current.filter((c) => c.id !== r.id))}
                >
                  <Icon name="trash" />
                </IconButton>
              </span>
            </li>
          ))}
        </ol>
      )}
      <form
        className="toolbar checklist-add"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (!text) return;
          setDraft('');
          void save([...current, { text }]);
        }}
      >
        <Input
          size="sm"
          className="checklist-input"
          value={draft}
          placeholder="Add a requirement or an approved decision"
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button size="sm" type="submit" disabled={busy || !draft.trim()}>
          Add
        </Button>
      </form>
      {(list?.not_verifiable_notes.length ?? 0) > 0 && (
        <div className="checklist-notes">
          <p className="muted ticket-hint">Not checked in code (no repository can show it):</p>
          <ul>
            {list!.not_verifiable_notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      {removed.length > 0 && (
        <div className="manual">
          <button
            className="manual-toggle"
            type="button"
            onClick={() => setShowRemoved((v) => !v)}
            aria-expanded={showRemoved}
          >
            {showRemoved ? `− Removed · ${removed.length}` : `+ Removed · ${removed.length}`}
          </button>
          {showRemoved && (
            <ul className="checklist removed">
              {removed.map((r) => (
                <li key={r.id} className="checklist-item">
                  <span className="mono muted checklist-id">{requirementRef(r.id)}</span>
                  <span className="checklist-text muted">{r.text}</span>
                  <SourceTag item={r} />
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save([...current, { id: r.id, text: r.text }])}>
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function SourceTag({ item }: { item: TicketRequirement }) {
  return item.source === 'user' ? (
    <span className="tag cat" title="Added or edited by hand; kept by Re-derive">
      by hand
    </span>
  ) : (
    <span className="tag cat" title="Derived from the ticket and its comments">
      derived
    </span>
  );
}
