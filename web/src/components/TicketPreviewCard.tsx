import { useEffect, useState } from 'react';
import { api } from '../api';
import { Link, navigate } from '../router';
import type { DumpModeRequest, PreviewRoleRequest, Recipe, TicketPreviewPlan } from '../types';
import { DumpSelect, PreviewStatusPill, RecipeSelect, RoleChips } from './preview';
import RoleBranchInputs, { roleRequests } from './RoleBranchInputs';
import { Card } from './ui';

/** The inputs a plan prefills: the chain tip per role, empty (= base branch) where the repo has none. */
function planInputs(plan: TicketPreviewPlan): { values: Record<string, string>; local: Record<string, boolean> } {
  const values: Record<string, string> = {};
  const local: Record<string, boolean> = {};
  for (const r of plan.roles) {
    values[r.role] = r.usedBase ? '' : r.branch;
    local[r.role] = r.source === 'local';
  }
  return { values, local };
}

function sameInputs(
  plan: TicketPreviewPlan,
  values: Record<string, string>,
  local: Record<string, boolean>,
): boolean {
  const planned = planInputs(plan);
  return plan.roles.every(
    (r) =>
      (values[r.role] ?? '').trim() === planned.values[r.role] && Boolean(local[r.role]) === planned.local[r.role],
  );
}

/**
 * "Preview ticket": one preview of the whole ticket, each repo at the tip of
 * its chain (the server resolves it), confirmed and optionally changed per
 * role before it starts. A live preview that already runs the plan is opened
 * instead of starting a second one.
 */
export default function TicketPreviewCard({
  ticketKey,
  recipes,
  onClose,
}: {
  ticketKey: string;
  recipes: Recipe[];
  onClose: () => void;
}) {
  const [recipeName, setRecipeName] = useState(recipes[0]?.name ?? '');
  const [plan, setPlan] = useState<TicketPreviewPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [localRoles, setLocalRoles] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState(false);
  const [dumpMode, setDumpMode] = useState<DumpModeRequest>('auto');
  const [starting, setStarting] = useState(false);

  const recipe = recipes.find((r) => r.name === recipeName) ?? recipes[0] ?? null;

  useEffect(() => {
    if (!recipe) return;
    let live = true;
    setPlan(null);
    setError(null);
    api
      .ticketPreviewPlan(ticketKey, recipe.name)
      .then((p) => {
        if (!live) return;
        const inputs = planInputs(p);
        setPlan(p);
        setValues(inputs.values);
        setLocalRoles(inputs.local);
        setEditing(false);
      })
      .catch((err: Error) => {
        if (live) setError(err.message);
      });
    return () => {
      live = false;
    };
  }, [ticketKey, recipe?.name]);

  if (!recipe) return null;

  const unchanged = plan ? sameInputs(plan, values, localRoles) : false;
  const reuse = unchanged ? plan?.live_preview ?? null : null;

  const start = async (): Promise<void> => {
    if (!plan) return;
    setStarting(true);
    setError(null);
    try {
      // Unchanged: the plan as the server resolved it (bases included). Changed: every role as typed.
      const roles: PreviewRoleRequest[] = unchanged
        ? plan.request.roles
        : roleRequests(recipe.roles, values, true, localRoles);
      const { preview } = await api.createPreview({
        ticket: ticketKey,
        recipe: recipe.name,
        roles,
        ...(dumpMode === 'auto' ? {} : { dumpMode }),
      });
      navigate(`/previews?open=${preview.id}`);
    } catch (err) {
      setError((err as Error).message);
      setStarting(false);
    }
  };

  return (
    <Card
      title="Preview this ticket"
      actions={
        <button className="btn ghost btn-sm" type="button" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="muted ticket-hint">
        Each repo runs the tip of its chain below (the last branch, which contains the whole stack), from the local
        clone when that branch was last reviewed locally. A repo without a branch in this ticket runs its base branch.
      </p>
      {error && <p className="error-line">{error}</p>}
      {!plan && !error && <p className="muted">Resolving the branches…</p>}
      {plan && (
        <div className="custom-launch">
          <RoleChips roles={plan.roles} />
          {plan.notes.map((n) => (
            <p key={n} className="notice-line">
              {n}
            </p>
          ))}
          {editing && (
            <RoleBranchInputs
              roles={recipe.roles}
              values={values}
              onChange={(role, value) => setValues((prev) => ({ ...prev, [role]: value }))}
              local={localRoles}
              onLocalChange={(role, value) => setLocalRoles((prev) => ({ ...prev, [role]: value }))}
              disabled={starting}
            />
          )}
          {reuse && (
            <p className="notice-line">
              Preview #{reuse.id} already runs these branches <PreviewStatusPill preview={reuse} />
            </p>
          )}
          {plan.other_live.length > 0 && (
            <p className="muted ticket-hint">
              Other live previews of this ticket:{' '}
              {plan.other_live.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && ', '}
                  <Link to={`/previews?open=${p.id}`}>#{p.id}</Link> ({p.status})
                </span>
              ))}
            </p>
          )}
          <div className="custom-launch-foot">
            <button
              className="btn ghost btn-sm"
              type="button"
              aria-pressed={editing}
              onClick={() => {
                if (editing) {
                  const inputs = planInputs(plan);
                  setValues(inputs.values);
                  setLocalRoles(inputs.local);
                }
                setEditing((v) => !v);
              }}
              disabled={starting}
            >
              {editing ? 'Reset branches' : 'Change branches'}
            </button>
            <div className="custom-launch-actions">
              <RecipeSelect recipes={recipes} value={recipe.name} onChange={setRecipeName} disabled={starting} />
              {!reuse && <DumpSelect value={dumpMode} onChange={setDumpMode} disabled={starting} />}
              {reuse ? (
                <button className="btn primary" type="button" onClick={() => navigate(`/previews?open=${reuse.id}`)}>
                  Open preview #{reuse.id}
                </button>
              ) : (
                <button className="btn primary" type="button" onClick={() => void start()} disabled={starting}>
                  {starting ? 'Starting…' : 'Start preview'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
