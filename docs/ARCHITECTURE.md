# Architecture

The dashboard is intentionally small. Three Azure resources, one file of frontend, one file of admin UI, one file of API routing, a handful of shared modules. No database, no queue, no worker pool. If you understand how a single HTTP request flows, you understand the whole system.

## The stack

| Layer | Tech | Why |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS in one file per page | Zero build. Edit and see the change on next push. |
| API | Azure Functions v4 (Node 20, ES modules) | Auto-scales, first-class SWA integration, ~free at typical traffic. |
| Hosting | Azure Static Web Apps (Standard tier) | Colocates frontend + API + Entra ID auth + custom domain at one bill. |
| Auth | SWA built-in Entra ID | User + role management via Portal; no auth code to maintain. |
| Config | Azure Table Storage (`projects` table) | Dynamic project add/remove without restart. Cheap, fast, per-row. |
| Secrets | Azure Key Vault (referenced by name from Table Storage rows) | PATs never appear in code, config, or logs. Rotation is one API call. |
| Access | Managed Identity on the SWA | No secrets stored anywhere for Azure resource access. |
| CI/CD | GitHub Actions → `Azure/static-web-apps-deploy@v1` | One workflow deploys both frontend and API on push. |
| Data source | Azure DevOps REST API (WIQL + Work Items) | Same PAT the ADO web UI uses; no separate integration to maintain. |

## Data flow for a single dashboard request

```
Browser                    SWA                    Managed Function                      Azure
  │                         │                            │                                │
  ├──GET /                ─>│                            │                                │
  │<── index.html           │                            │                                │
  │                         │                            │                                │
  ├──GET /api/me         ──>│──proxy──>                  │                                │
  │<── {authed, roles}      │                            │                                │
  │                         │                            │                                │
  ├──GET /api/projects   ──>│──proxy──>                  │                                │
  │                         │                            │──Table Storage: list──────────>│
  │<── [projects]           │                            │<──rows──────────────────────────┤
  │                         │                            │                                │
  ├──GET /api/projects/    ─>│──proxy──>                 │──Table: get(id)───────────────>│
  │  {id}/tasks             │                            │<──row + patSecretName───────────┤
  │                         │                            │──Key Vault: getSecret(pat)────>│
  │                         │                            │<──PAT string────────────────────┤
  │                         │                            │──ADO WIQL──────────────────────>ADO
  │                         │                            │<──work items────────────────────ADO
  │                         │                            │  ... map, roll up, critical path
  │                         │                            │  ... cache for 5 min
  │<── JSON: 300+ tasks     │                            │                                │
```

Total Azure calls per cache-miss dashboard request: **2** (Table + Key Vault, each < 50 ms with Managed Identity).
Total ADO calls per cache-miss: **3 to 6** (WIQL + batch fetches + iteration + parent + dependency links). Wall clock: ~1-3 seconds. Then cached in-Function for 5 min.

## The three transformations

Between raw ADO and what the frontend renders, three transformations worth understanding — all in `api/shared/mapping.js`:

### 1. Date resolution (`resolveDates`)

Not every ADO work item has explicit dates. The resolver falls back in this order:
1. `Microsoft.VSTS.Scheduling.StartDate` / `TargetDate` — if set
2. Iteration dates from `System.IterationPath` (sprint dates)
3. `System.CreatedDate` + 14 days (last-resort placeholder)

The date source is tracked (`_dateSource: 'explicit' | 'iteration' | 'fallback'`) so the roll-up step knows what to override.

### 2. Roll-up (`rollUpDates`, `rollUpStatus`)

Parents whose own dates fell back to `created+14` get their dates replaced with `min(child.start) → max(child.end)`. Two passes for `Epic → Feature → PBI` propagation.

Similarly, status rolls up: **all children Done → parent Done**, **any child active → parent In Progress**. Three passes cover the 4-level hierarchy.

This is what makes an Epic bar span its actual work range on the Gantt, not the sprint it was created in.

### 3. Critical path (`computeCriticalPath`, `annotateCriticalPath`)

Reads all `System.LinkTypes.Dependency-Forward` links between work items. Builds a DAG. Runs longest-path via topological sort + DP. Marks every item on the winning path (and its parent chain) with `is_critical_path: 1`.

Frontend renders those bars in purple with a ⚡ badge. Tooltip shows `Depends on:` and `Blocks:` names, aggregated up from children when the item is a parent.

## Multi-project model

**One SWA instance holds many ADO projects.** Table Storage stores one row per project:

```
PartitionKey: 'project'   (fixed — single install per PM)
RowKey:       <projectId> (kebab-case slug — becomes the URL segment)
Fields:
  displayName        e.g. "Force Account Automation"
  adoOrg             e.g. "TetraTech"
  adoProject         e.g. "Force Account Automation" (case-sensitive)
  patSecretName      "ado-pat-<projectId>"    (Key Vault reference)
  adminSecretName    "admin-secret-<projectId>" or empty
  createdBy, createdAt, updatedAt
```

Each project's PAT lives in Key Vault at `ado-pat-{projectId}`. The Function reads it per-request via Managed Identity — never cached, never in memory beyond the request's lifetime. On project delete, both secrets are soft-deleted from Key Vault (7-day retention).

**Adding a project** hits `POST /api/projects`, which:
1. Requires the caller to have the `admin` role (SWA-enforced)
2. Validates the PAT with a smoke WIQL call against ADO before writing anything
3. Stores the PAT in Key Vault
4. Stores the admin secret (if provided) in Key Vault
5. Writes the row to Table Storage

If ADO rejects the PAT, nothing gets written — the API returns 400 with the ADO error message.

## Auth model

**Sign-in:** SWA's built-in Entra ID provider (`azureActiveDirectory`). The Bicep template accepts an `AAD_CLIENT_ID` and `AAD_CLIENT_SECRET` from an app registration you create in your own tenant. Optional `ALLOWED_TENANT_ID` locks sign-in to a single tenant.

**Roles:** two, both managed by SWA:
- `authenticated` — everyone signed in. Can view all projects.
- `admin` — assigned via SWA Role management (Portal or invite URL). Can add/edit/delete projects, hit migration endpoints.

**Enforcement:** two layers. First, `staticwebapp.config.json` blocks routes at the platform level (`/api/projects POST` requires `admin`, etc.). Second, every Function double-checks the principal via `x-ms-client-principal` header — defense in depth in case the config file gets edited wrong.

**Migration endpoints (`/api/projects/{id}/admin/*`):** require both the `admin` role AND a per-project `X-Admin-Secret` header. The admin secret is optional per project — if unset, admin endpoints return 404 as if they don't exist. This lets you enable bulk-migration powers on a per-project basis, and rotate secrets independently.

## Cache design

- **In-memory** per Function instance. Keys are `tasks:{projectId}` and `sprint:{projectId}:{n}`. TTL 5 min.
- **Cold start** = cache miss = full ADO pull. Not a problem in practice — a dashboard with 5 viewers on 3 projects costs ~15 misses per Function instance per 5 min, well under any ADO rate limit.
- **Admin mutations** (`/api/projects/{id}/admin/*`) call `bustProjectCaches(id)` so the very next task fetch reflects the change.
- **Browser-side caching:** the API sends `Cache-Control: no-store`, so as long as the server returns fresh JSON the browser will use it.

If you outgrow in-memory (multiple Function instances, high traffic, want shared cache), swap `api/shared/cache.js` for Azure Cache for Redis — the surface (`cacheGet/cacheSet/cacheDelete`) is identical.

## The frontend

Two files:

- **`public/index.html`** — the dashboard. Loads `/api/me` first (redirects to Entra sign-in if anonymous), then `/api/projects` (shows a project picker), then `/api/projects/{id}/tasks`. Picker selection persists in `localStorage` and via `?project=<id>` URL param.
- **`public/setup.html`** — the admin CRUD UI. Restricted to `admin` role at the SWA layer. Add/edit/remove projects, rotate PATs, toggle per-project admin secrets. Every save validates against ADO before writing.

## Extending it

**Add a new frontend view:**
1. Add a button in `.view-selector`
2. Add a `<div id="myview" class="view-container">` container
3. Add a case in `switchView()` and an init function
4. All data is already in `allTasks` for the current project — no API changes needed

**Add a new API endpoint:**
1. Add `app.http('name', {...})` in `api/src/index.js`
2. Reuse `getConfig()`, `loadProjectContext()`, `wiqlQueryIds()`, `batchFetchWorkItems()` from `shared/`
3. Push → auto-deploys

**Change what fields we fetch from ADO:**
Edit `FIELDS` array in `api/shared/mapping.js`. Add the reference name (e.g. `Microsoft.VSTS.Common.AcceptanceCriteria`). Then use it in `mapWorkItem`.

**Restrict which projects a specific user can see:**
Not supported out of the box — every authenticated user sees every project. If you need this, add a `visibleTo` field to the Table Storage row (array of user ids or emails), then filter in `listProjects()` by matching against `principal.id` / `principal.name`. About 20 lines of code.

## Security notes

- Every ADO PAT lives only in Key Vault. No writes to logs, no writes to Table Storage rows. The Function reads it per-request via Managed Identity.
- Storage Account has `allowSharedKeyAccess: false` — Managed Identity is the only way to reach the Table.
- Key Vault uses RBAC (not access policies), with soft-delete retention of 7 days.
- The `X-Admin-Secret` on migration endpoints is a second factor on top of the `admin` role. Removing the secret disables those endpoints entirely (they return 404, not 401 — no side channel about whether the project exists).
- `staticwebapp.config.json` enforces auth at the edge before requests reach the Function. Cheaper than blocking inside the Function, and if the Function crashes the endpoint is still protected.
