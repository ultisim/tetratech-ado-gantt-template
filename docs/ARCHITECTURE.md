# Architecture

The dashboard is intentionally small. Two Azure resources, one file of frontend, one file of API routing, a handful of shared modules. No database, no queue, no worker pool. If you understand how a single HTTP request flows, you understand the whole system.

## The stack

| Layer | Tech | Why |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS in a single file | Zero build. Anyone can edit `index.html` and see the change on next push. |
| API | Azure Functions v4 (Node 20, ES modules) | Auto-scales, first-class SWA integration, ~free at typical traffic. |
| Hosting | Azure Static Web Apps (Standard tier) | Colocates frontend + API + custom domain + auth at one bill. Free tier is generous. |
| Secrets | Azure Key Vault (referenced via `@Microsoft.KeyVault(...)` app settings) | PAT never appears in code, config, or logs. |
| CI/CD | GitHub Actions → `Azure/static-web-apps-deploy@v1` | One workflow deploys both frontend and API on push. |
| Data source | Azure DevOps REST API (WIQL + Work Items) | Same PAT used by the ADO web UI; no separate integration. |

## Data flow for a single request

```
Browser                    SWA CDN                   Managed Function                 Azure DevOps
  │                          │                             │                              │
  ├──GET /                ──>│                             │                              │
  │<── index.html + config.js│                             │                              │
  ├──GET /api/tasks       ──>│──proxy──>                   │                              │
  │                          │                             │──check in-memory cache──     │
  │                          │                             │  hit? return cached ─────────┤
  │                          │                             │                              │
  │                          │                             │──WIQL: SELECT [System.Id]──>│
  │                          │                             │<──list of ids────────────────┤
  │                          │                             │──batch fetch (200 at a time)>│
  │                          │                             │<──work items with fields────┤
  │                          │                             │──iteration map──────────────>│
  │                          │                             │──parent map (WorkItemLinks)>│
  │                          │                             │──dependency links───────────>│
  │                          │                             │──map to task shape           │
  │                          │                             │──roll up dates + status      │
  │                          │                             │──compute critical path       │
  │                          │                             │──cache for 5 min             │
  │<── JSON: 300+ tasks   ───┼─────────────────────────────┤                              │
  │                          │                             │                              │
```

Total ADO calls per cache-miss: **3 to 6** depending on project size (WIQL + up to 3 parallel batches + iteration map + parent map + dependency links). Wall clock: ~1-3 seconds. Then cached for 5 min.

## The three transformations

Between raw ADO and what the frontend renders, there are three data transformations worth understanding:

### 1. Date resolution (`api/shared/mapping.js` → `resolveDates`)

Not every ADO work item has explicit dates. The resolver falls back in this order:
1. `Microsoft.VSTS.Scheduling.StartDate` / `TargetDate` — if set
2. Iteration dates from `System.IterationPath` (sprint dates)
3. `System.CreatedDate` + 14 days (last-resort placeholder)

The date source is tracked (`_dateSource: 'explicit' | 'iteration' | 'fallback'`) so the roll-up step knows what to override.

### 2. Roll-up (`rollUpDates`, `rollUpStatus`)

Parents whose own dates fell back to `created+14` get their dates replaced with `min(child.start) → max(child.end)`. Runs twice for `Epic → Feature → PBI` propagation.

Similarly, status rolls up: **all children Done → parent Done**, **any child active → parent In Progress**. Runs three times for the 4-level hierarchy.

This is what makes an Epic bar span its actual work range on the Gantt, not the sprint it was created in.

### 3. Critical path (`computeCriticalPath`, `annotateCriticalPath`)

Reads all `System.LinkTypes.Dependency-Forward` links between work items. Builds a DAG. Runs longest-path via topological sort + DP. Marks every item on the winning path (and their parent chain) with `is_critical_path: 1`.

Frontend renders those bars in purple with a ⚡ badge. Tooltip shows `Depends on:` and `Blocks:` with names, aggregated up from children when the item is a parent.

## Security model

- **PAT** lives in Key Vault. Managed Identity on the Static Web App grants read access. Neither the frontend nor the Functions code ever sees the raw secret string in a log — it's read from the env var, but the env var value is a `@Microsoft.KeyVault(...)` reference resolved at runtime.
- **Admin endpoints** (`/api/admin/*`) require the `X-Admin-Secret` header. If the `ADMIN_SECRET` env var is unset, they return 404. If it's set but the header is wrong, they return 401.
- **Read endpoints** (`/api/tasks`, `/api/sprint/*`, `/api/health`) are anonymous — anyone with the site URL can view the data. For most internal projects this is fine (the URL is not indexed). If you need real auth, SWA supports built-in Entra ID / Google / GitHub auth via `staticwebapp.config.json`.

## Cache design

- **In-memory** per Function instance. Keyed by `tasks:<project>` and `sprint:<n>`. TTL 5 min.
- **Cold start** = cache miss = full ADO pull. Not a problem in practice: a dashboard with 5 viewers costs 5 misses per Function instance per 5 min, well under any ADO rate limit.
- **Admin mutations** (`/api/admin/*`) call `bustAllCaches()` so the very next `/api/tasks` reflects the change.
- **Browser-side caching:** the API sends `Cache-Control: no-store`, so as long as the server returns fresh JSON the browser will use it.

If you outgrow in-memory (multiple Function instances, high traffic, want shared cache), swap `api/shared/cache.js` for Azure Cache for Redis — the surface (`cacheGet/cacheSet/cacheDelete`) is identical.

## The frontend

Single `public/index.html`. Big, but flat: `<style>`, `<body>`, `<script>`. Search-friendly.

Key concepts inside:
- **`allTasks`** — flat array with `parent_id` links. Loaded once from `/api/tasks`.
- **`tasks`** — top-level parents (no parent). Root of the tree.
- **`taskMap`** — id → task object, for O(1) parent lookups.
- **`expandedTasks`** — set of ids currently expanded in the Gantt.
- **`renderGanttRowRecursive(item, depth)`** — the whole rendering engine. Recursion covers any hierarchy depth. Depth drives indentation.

The frontend calls three endpoints:
- `GET /api/tasks` — on load
- `GET /api/sprint/{n}` — when the Sprint dropdown is opened
- (no calls for the Sprint Review view — it reads from `allTasks` already in memory)

## Extending it

**Add a new frontend view:**
1. Add a button in `.view-selector`
2. Add a `<div id="myview" class="view-container">` container
3. Add a case in `switchView()` and an init function
4. All data is already in `allTasks` — no API changes needed

**Add a new API endpoint:**
1. Add `app.http('name', {...})` in `api/src/index.js`
2. Reuse `getConfig()`, `wiqlQueryIds()`, `batchFetchWorkItems()` from `shared/`
3. Push → auto-deploys

**Change what fields we fetch from ADO:**
Edit `FIELDS` array in `api/shared/mapping.js`. Add the reference name (e.g. `Microsoft.VSTS.Common.AcceptanceCriteria`). Then use it in `mapWorkItem`.
