# ADO Gantt Dashboard — Template

A drop-in web dashboard that renders **any number of Azure DevOps projects** as interactive **Gantt**, **Timeline**, **Table**, and per-sprint **Sprint Review** views. Live-syncs from ADO every 5 minutes. Locked with **Entra ID**. Hosted entirely in **your** Azure subscription (Static Web Apps + Managed Functions + Key Vault + Table Storage) — nothing runs on our servers.

**One install, many projects.** Add projects through the dashboard UI (`/setup.html`) once it's deployed — no code changes, no redeploys.

---

## What you get out of the box

- **Gantt Chart** — recursive Epic → Feature → PBI → Task rows with:
  - Green = Done, Blue = In Progress, Grey = Pending
  - Amber striped bars for code-review tasks
  - Purple critical path (auto-computed from ADO dependency links)
  - Red "TODAY" line
  - Per-bar sprint label (`16d · S3`)
- **Sprint Review** — one-click **Copy as Email** and **Download as Word** for retro prep
- **Sprint dropdown** in the header — auto-populated from your ADO data
- **Project switcher** in the header — swap between your ADO projects instantly
- **Bulk migration endpoints** (opt-in per project) for one-off moves like "move all unfinished Sprint 6 items to Sprint 7" — see [docs/RUNBOOK.md](docs/RUNBOOK.md)
- **Entra ID sign-in** — all authenticated users can view; only users with the `admin` role can add/edit/delete projects

## Get started in 15 minutes

**Prereqs on your machine:**
- An Azure subscription (any tier — this fits comfortably in the Standard SWA tier at ~$9/mo, or free with SWA free tier + Consumption Functions)
- The [Azure CLI (`az`)](https://learn.microsoft.com/cli/azure/install-azure-cli)
- Node.js 20+ ([download](https://nodejs.org/))

**Steps:**

1. **Use this template.** Click **"Use this template"** at the top of this repo. Name your fork (anything you like), then clone it locally.

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run the setup wizard:**
   ```bash
   npm run setup
   ```
   A browser opens at `http://localhost:3000/setup/` and walks you through:
   - Prereqs check → Azure sign-in → subscription pick
   - Resource group + region
   - Site name + optional Entra tenant restriction
   - Entra app registration (the wizard gives you the two `az ad app` commands to run; paste back the client id + secret)
   - Provisions the Static Web App, Key Vault, Storage Account, and role assignments
   - Deploys the frontend + Functions
   - Attempts to invite you as an admin automatically

4. **Accept the admin invite** from the wizard's success screen (or grant yourself the admin role via Azure Portal → your Static Web App → Role management).

5. **Sign in and add your first ADO project.** Visit `<your-site>/setup.html`, click "Add a project", paste your ADO org, project name, and a Personal Access Token with **Work Items: Read, write, & manage** scope. The wizard validates the PAT against ADO before storing it.

6. **Bookmark the URL.** From here on:
   - **Add more projects** anytime via `/setup.html`
   - **Update states or assignees** in ADO — changes appear on the dashboard within 5 min (cache TTL)
   - **Rotate a PAT** by editing the project in `/setup.html`
   - **Invite other viewers** via Azure Portal → SWA → Role management → Invite (role: `authenticated` for view-only; `admin` for project management)

## Ongoing: how to change things

For all operational tasks, see [**docs/RUNBOOK.md**](docs/RUNBOOK.md). Highlights:

- [Add a new ADO project](docs/RUNBOOK.md#add-a-new-ado-project)
- [Rotate a PAT](docs/RUNBOOK.md#rotate-a-pat)
- [Force a cache refresh](docs/RUNBOOK.md#force-a-cache-refresh)
- [Bulk-move items between sprints](docs/RUNBOOK.md#bulk-move-items-between-sprints)
- [Bulk-close code reviews](docs/RUNBOOK.md#bulk-mark-items-done)
- [Bulk-create items from a CSV](docs/RUNBOOK.md#bulk-create-items-from-csv)
- [Invite another user](docs/RUNBOOK.md#invite-another-user)
- [Add a custom domain](docs/RUNBOOK.md#add-a-custom-domain)
- [Customize branding](docs/RUNBOOK.md#customize-branding)

## Architecture

See [**docs/ARCHITECTURE.md**](docs/ARCHITECTURE.md). Short version:

```
    Browser                Azure Static Web App                     Azure DevOps
   ┌──────┐               ┌──────────────────────┐               ┌─────────────┐
   │ /    │──HTML/JS─────>│ public/index.html    │               │ Project A   │
   │      │               │  + setup.html        │               │ Project B   │
   │ /api │──GET──────────│ Managed Functions    │──WIQL+REST───>│ ...         │
   │ /... │<──JSON────────│ (5 min in-memory     │<──work items──│             │
   │      │  Entra ID     │  cache per project)  │               └─────────────┘
   └──────┘               └──────────────────────┘                       ▲
                                    │           │                        │
                          Managed Identity      │                    Per-project
                                    │           └───reads────────>   PAT + admin
                                    ▼                             secret in Key
                            ┌──────────────┐                          Vault
                            │ Table Storage│
                            │  'projects'  │
                            │  <config>    │
                            └──────────────┘
```

- **Frontend:** vanilla HTML/CSS/JS. Two files (`public/index.html` for the dashboard, `public/setup.html` for admin).
- **API:** Azure Functions v4 (Node 20 JS). Per-project routes: `/api/projects/{id}/tasks`, `/api/projects/{id}/sprint/{n}`, etc.
- **Auth:** SWA built-in Entra ID. Two roles: `authenticated` (view) and `admin` (project CRUD + migration endpoints).
- **Config:** Table Storage row per project. PATs and admin secrets in Key Vault, accessed via Managed Identity.
- **CI/CD:** GitHub Actions deploys on every push to `main` — see [`.github/workflows/azure-deploy.yml`](.github/workflows/azure-deploy.yml).

## Files at a glance

```
├── public/                        # Frontend
│   ├── index.html                 # Dashboard (Gantt, Timeline, Table, Sprint Review)
│   ├── setup.html                 # Admin: project CRUD (add / edit / remove)
│   ├── 403.html                   # Access denied fallback
│   └── staticwebapp.config.json   # Auth + route rules
├── api/                           # Azure Functions v4 (Node 20)
│   ├── src/index.js               # All HTTP endpoints
│   ├── shared/                    # ADO client, mapping, cache, project store, key vault
│   └── host.json
├── infra/main.bicep               # SWA + Key Vault + Storage + role assignments
├── setup/                         # Local install wizard (Express + one HTML page)
│   ├── server.js
│   └── ui/index.html
├── .github/workflows/             # GitHub Actions CI/CD
└── docs/
    ├── README.md                  # ← you are here
    ├── ARCHITECTURE.md            # Data flow + module map + security model
    ├── RUNBOOK.md                 # Task-oriented ops
    └── VIDEO-SCRIPT.md            # 5-min walkthrough script
```

## License

MIT. Fork it, brand it, ship it.
