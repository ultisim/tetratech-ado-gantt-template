# ADO Gantt Dashboard — Template

A drop-in web dashboard that renders any Azure DevOps project as an interactive **Gantt chart**, **Timeline**, **Table**, and per-sprint **Sprint Review** view. Live-syncs from ADO every 5 minutes. Hosted on **Azure Static Web Apps** (frontend + Managed Functions API), no server to run.

---

## What you get out of the box

- **Gantt Chart** — recursive Epic → Feature → PBI → Task rows with:
  - Green = Done, Blue = In Progress, Grey = Pending
  - Amber striped bars for code-review tasks
  - Purple critical path (auto-computed from ADO dependency links)
  - Red "TODAY" line
  - Per-bar sprint label (`16d · S3`)
- **Sprint Review** — one-click **Copy as Email** and **Download as Word** for sprint retro prep
- **Sprint dropdown** in the header — auto-populated from your data (no hardcoding)
- **Bulk migration endpoints** (opt-in, disabled by default) for one-time moves like "move all unfinished Sprint 6 items to Sprint 7" — see [docs/RUNBOOK.md](docs/RUNBOOK.md)

## Get started in 15 minutes

**You'll need:**
- An Azure subscription (any tier — the site fits in the free Static Web Apps tier for typical projects)
- The [Azure CLI (`az`)](https://learn.microsoft.com/cli/azure/install-azure-cli) installed and signed in
- Your ADO org name, project name, and a Personal Access Token with **Work Items: Read, write, & manage** scope ([create one here](https://dev.azure.com/))
- Node.js 20+ ([download](https://nodejs.org/))

**Steps:**

1. **Fork this template.** Click "Use this template" at the top of the GitHub repo, name your fork, then clone it locally.

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run the setup wizard:**
   ```bash
   npm run setup
   ```
   A browser tab opens at `http://localhost:4321/setup/` and walks you through:
   - Prerequisites check
   - Azure sign-in and subscription pick
   - Resource group + region
   - ADO org, project, PAT (validated against ADO before proceeding)
   - Optional admin secret (leaves migration endpoints disabled unless set)
   - Provisions Static Web App + Key Vault via Bicep
   - Deploys the site
   - Shows you the URL

4. **Bookmark the URL.** Your dashboard is live and syncing.

That's it. From here on:

- **New work items in ADO** appear on the dashboard within 5 min (cache TTL)
- **State changes** (In Progress → Done) reflect on the Gantt within 5 min
- **New sprints** in ADO auto-populate the sprint dropdown — no code change needed

## Ongoing: how to change things

For all operational tasks, see [**docs/RUNBOOK.md**](docs/RUNBOOK.md). Highlights:

- [Force a cache refresh](docs/RUNBOOK.md#force-a-cache-refresh)
- [Bulk-move items between sprints](docs/RUNBOOK.md#bulk-move-items-between-sprints)
- [Bulk-close code reviews after a sprint](docs/RUNBOOK.md#bulk-mark-items-done)
- [Create items in bulk from a CSV](docs/RUNBOOK.md#bulk-create-items-from-csv)
- [Rotate the ADO PAT](docs/RUNBOOK.md#rotate-the-ado-pat)
- [Change the site's colors or branding](docs/RUNBOOK.md#customize-branding)
- [Add a custom domain](docs/RUNBOOK.md#add-a-custom-domain)

## Architecture

See [**docs/ARCHITECTURE.md**](docs/ARCHITECTURE.md) for the full picture. Short version:

```
    Browser                Azure Static Web App                    Azure DevOps
   ┌──────┐               ┌─────────────────────┐               ┌─────────────┐
   │ /    │──HTML/JS─────>│ public/index.html   │               │ Your        │
   │      │               ├─────────────────────┤               │ Project     │
   │ /api │──GET──────────│ Managed Functions   │──WIQL+REST───>│             │
   │ /... │<──JSON────────│ (5 min in-memory    │<──work items──│             │
   │      │               │  cache per Function)│               └─────────────┘
   └──────┘               └─────────────────────┘                       ▲
                                    │                                   │
                              ADO_PAT via                          Secret in
                              Managed Identity  ────────────>       Key Vault
```

- **Frontend:** vanilla HTML/CSS/JS. One file (`public/index.html`), no build.
- **API:** Azure Functions v4 (Node 20 JS). Cached with an in-memory LRU per Function instance.
- **Secrets:** ADO PAT lives in Key Vault, surfaced to Functions via a `@Microsoft.KeyVault(...)` reference.
- **CI/CD:** GitHub Actions deploys on every push to `main`. Free — [see the workflow](.github/workflows/azure-deploy.yml).

## Files at a glance

```
├── public/                    # Static frontend (one HTML file, one config.js)
│   ├── index.html             # The whole dashboard UI
│   ├── config.js              # Written by `npm run setup` — project name + ADO URL
│   └── staticwebapp.config.json
├── api/                       # Azure Functions v4 (Node 20)
│   ├── src/index.js           # All HTTP endpoints
│   ├── shared/                # ADO client, mapping logic, cache, pipeline
│   └── host.json
├── infra/main.bicep           # Static Web App + Key Vault provisioning
├── setup/                     # Local setup wizard (Express + one HTML page)
│   ├── server.js
│   └── ui/index.html
├── .github/workflows/         # GitHub Actions CI/CD
└── docs/
    ├── README.md              # ← you are here
    ├── ARCHITECTURE.md        # How the data flows
    └── RUNBOOK.md             # How to do operational tasks
```

## License

MIT. Fork it, brand it, ship it.
