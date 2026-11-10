Example service (Django REST API). Keep this file short: one rule per line, grouped, with the paths that matter.

## Customer docs (customer-facing: `docs/customer/<topic>.md`)
- A change to user-facing behavior updates the matching `docs/customer/<topic>.md` in the same PR; a missing update is `major`.
- Internal docs (AGENTS.md, CLAUDE.md, docs/design/) left stale are `minor`.

## Security
- Tenant data is filtered by the requesting user's organization; never trust `organization` from request data.
- Access to another tenant's object reads as a 404, like a missing one.

## Code
- Views stay thin; workflows live in services, invariants in models.
- List endpoints are paginated and consistently ordered.
- Background work runs on the task queue, never in the request.

## Copy
- No em dashes in user-facing copy or customer docs.
