# Runbook — Operational Tasks

Task-oriented reference. Each section is a "how do I…" for something you'll actually need to do. Skim the headings; jump to the one you need.

**Variables used below** — replace with your values:
- `<SITE>` — your site name (e.g. `gantt-tetratech`)
- `<RG>` — your Azure resource group name
- `<SITE_URL>` — e.g. `https://gantt-tetratech.azurestaticapps.net`
- `<PROJECT_ID>` — kebab-case project id from `/setup.html` (e.g. `force-account`)
- `<ADMIN_SECRET>` — the per-project admin secret you set in the setup UI

---

## Contents

- [Add a new ADO project](#add-a-new-ado-project)
- [Edit or rename a project](#edit-or-rename-a-project)
- [Remove a project](#remove-a-project)
- [Rotate a PAT](#rotate-a-pat)
- [Enable or disable the admin API per project](#enable-or-disable-the-admin-api-per-project)
- [Force a cache refresh](#force-a-cache-refresh)
- [Bulk-move items between sprints](#bulk-move-items-between-sprints)
- [Bulk-mark items Done](#bulk-mark-items-done)
- [Bulk-create items from CSV](#bulk-create-items-from-csv)
- [Invite another user](#invite-another-user)
- [Add a custom domain](#add-a-custom-domain)
- [Customize branding or colors](#customize-branding-or-colors)
- [Add a new custom tag category](#add-a-new-custom-tag-category)
- [Troubleshooting: stale cache](#troubleshooting-stale-cache)
- [Troubleshooting: auth errors](#troubleshooting-auth-errors)
- [Troubleshooting: missing items](#troubleshooting-missing-items)
- [Uninstall / clean up Azure resources](#uninstall--clean-up-azure-resources)

---

## Add a new ADO project

**1.** Sign in to your dashboard as an admin.
**2.** Click **⚙ Manage projects** in the top nav (or visit `<SITE_URL>/setup.html`).
**3.** Click **+ Add a project**. Fill in:
- **Project id** — kebab-case slug. Becomes the URL segment. Cannot be changed after creation.
- **Display name** — human label shown in the dropdown.
- **ADO org** — your `dev.azure.com/<ORG>` name.
- **ADO project** — exact, case-sensitive project name.
- **PAT** — Personal Access Token with **Work Items: Read, write, & manage** scope. [How to create one](https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate).
- **Admin secret** (optional) — pick any strong string. Enables the bulk migration endpoints for this project.

**4.** Click **Save**. The wizard validates the PAT against ADO before storing anything. If ADO rejects it, you'll see the exact error.

---

## Edit or rename a project

Visit `<SITE_URL>/setup.html` → click **Edit** on the project row.

You can change:
- **Display name** — updates the dropdown label
- **ADO org / project** — if they've been renamed on the ADO side
- **PAT** — paste a new value (blank keeps the existing one)
- **Admin secret** — paste to add/rotate

The **project id cannot change** — that would break bookmarks, cache keys, and Key Vault secret names.

---

## Remove a project

`<SITE_URL>/setup.html` → **Remove** on the project row → confirm.

What happens:
- Table Storage row is deleted
- Both Key Vault secrets are soft-deleted (7-day retention window — you can recover them via `az keyvault secret recover` if it was a mistake)
- The ADO project itself is not touched

---

## Rotate a PAT

Two ways.

**In-app (recommended):**
`<SITE_URL>/setup.html` → **Edit** the project → paste the new PAT into the PAT field → Save.

**Direct to Key Vault (for automation):**
```bash
az keyvault secret set \
  --vault-name <SITE>-kv \
  --name ado-pat-<PROJECT_ID> \
  --value "<NEW-PAT>"
```

Then bust the cache (see [Force a cache refresh](#force-a-cache-refresh)) so the Function picks it up on the next request without waiting for a cold start.

---

## Enable or disable the admin API per project

**Enable:** in `/setup.html`, **Edit** the project → set the **Admin secret** field to any strong string → Save.

**Disable:** in `/setup.html`, **Edit** the project → the admin-secret field shows "Currently set — leave blank to keep, empty string to disable". Enter a single space then delete it (empty string) → Save.

Direct via CLI:
```bash
# Set
az keyvault secret set --vault-name <SITE>-kv \
  --name admin-secret-<PROJECT_ID> --value "<STRONG-SECRET>"
# Delete
az keyvault secret delete --vault-name <SITE>-kv \
  --name admin-secret-<PROJECT_ID>
```

When enabled, every admin call must include header `X-Admin-Secret: <value>`. Otherwise → 401. If the secret is unset → 404.

---

## Force a cache refresh

The API caches ADO responses for 5 min per project. To force a fresh pull:

**From a browser:** append `?refresh=1` to the URL:
```
<SITE_URL>/api/projects/<PROJECT_ID>/tasks?refresh=1
<SITE_URL>/api/projects/<PROJECT_ID>/sprint/4?refresh=1
```

**From terminal:**
```bash
# Sign in first via the SWA login flow, then run in the browser DevTools console
# (the fetch there is authenticated via the SWA session cookie):
fetch('/api/projects/<PROJECT_ID>/tasks?refresh=1');
```

After forcing a server refresh, **hard-refresh the browser (Ctrl+Shift+R)** to bypass Chrome's response cache too.

---

## Bulk-move items between sprints

Say you want to move all unfinished items in Sprint 3 to Sprint 4.

**1. Get the list of IDs from the API's own data:**
```bash
# Run in browser DevTools console (authenticated via session cookie)
const tasks = await (await fetch('/api/projects/<PROJECT_ID>/tasks')).json();
const unfinished = tasks.filter(t => t.sprint === 3 && t.status !== 'completed').map(t => t.id);
console.log(JSON.stringify({ ids: unfinished, sprint: 4 }));
```

**2. Send to the admin endpoint (from a signed-in DevTools console):**
```javascript
await fetch('/api/projects/<PROJECT_ID>/admin/move-iteration', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-Admin-Secret': '<ADMIN_SECRET>',
    },
    body: JSON.stringify({ ids: unfinished, sprint: 4 }),
}).then(r => r.json());
```

Response:
```json
{"ok": 18, "failed": 0, "total": 18, "targetSprint": "MyProject\\Sprint 4", "results": [...]}
```

The endpoint automatically busts the cache, so the dashboard reflects the change immediately.

---

## Bulk-mark items Done

Same shape as move, different endpoint. E.g. after a code review pass:

```javascript
await fetch('/api/projects/<PROJECT_ID>/admin/set-state', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-Admin-Secret': '<ADMIN_SECRET>',
    },
    body: JSON.stringify({ ids: [375, 376, 377], state: 'Done' }),
}).then(r => r.json());
```

The `state` value must be valid for your process template — usually `Done`, `Closed`, `In Progress`, `To Do`, or `New`.

---

## Bulk-create items from CSV

For "import 26 new items from a CSV" scenarios (e.g. gap analysis from a stakeholder).

**1. Convert your CSV to a JSON payload.** Format each row as:
```json
{
    "workItemType": "Task",
    "title": "Deploy backend to STAGE",
    "assignedTo": "someone@yourdomain.com",
    "state": "To Do",
    "tags": "CRITICAL; FUTURE",
    "description": "Full multi-line description here",
    "sprint": 7
}
```

**2. Send from DevTools console:**
```javascript
await fetch('/api/projects/<PROJECT_ID>/admin/create-items', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-Admin-Secret': '<ADMIN_SECRET>',
    },
    body: JSON.stringify({ items: [ /* ... */ ] }),
}).then(r => r.json());
```

Returns `{ok, failed, total, results: [{id, title}, ...]}` with the new work item IDs.

The endpoint uses `bypassRules=true` so it works even if your ADO process template has required fields on create (like the Force Account project's Completed Work rule).

---

## Invite another user

**View-only:**
- Azure Portal → your Static Web App → **Role management** → **Invite**
- Provider: **Azure Active Directory**
- Invitee: their email
- Role: **authenticated**
- Expiration: 7-30 days
- Copy the invitation URL and send it

**Admin (can add/edit/delete projects, use migration endpoints):**
Same flow, role: **admin**.

The invitee clicks the link, signs in with Entra, and is now authenticated on the site with the role you granted. To revoke, remove them from the Users tab in Role management.

**Alternative:** anyone in your Entra tenant can already sign in (if you didn't lock to a tenant during setup — they still need a role assignment before they can see anything).

---

## Add a custom domain

**1.** Azure Portal → your Static Web App → **Custom domains** → **+ Add**.
**2.** Enter your subdomain (e.g. `gantt.yourcompany.com`). Azure shows the CNAME to create.
**3.** In your DNS provider: add the CNAME pointing to your `*.azurestaticapps.net` hostname.
**4.** Back in Azure: click **Validate**. Once green, the site is live at your custom URL with a free auto-renewing TLS cert.

**Don't forget:** update the Entra app registration's redirect URI (`az ad app update --id <appId> --web-redirect-uris "https://gantt.yourcompany.com/.auth/login/aad/callback" "https://<SITE>.azurestaticapps.net/.auth/login/aad/callback"`) so sign-in works from both the custom and default hostnames.

---

## Customize branding or colors

**Colors:** `public/index.html` has all styling inline in the `<style>` block near the top. Search for:
- `--primary` — dominant color (top nav, active tabs)
- `.gantt-legend-swatch` — status colors (done/in-progress/pending)
- `.header` — top bar styling

Push → GitHub Actions redeploys.

**Per-project name:** managed through `/setup.html` — no code changes needed.

**Logo:** replace the inline `<svg>` in the header of `public/index.html`. Everything else scales around it.

---

## Add a new custom tag category

Say you want ADO items tagged `blocker` to render red. In `public/index.html`:

**1.** Add a CSS class:
```css
.task-bar.blocker {
    background: #ef4444 !important;
    color: white;
}
```

**2.** Apply the class in the recursive renderer (search for `codeReviewClass`):
```js
const blockerClass = item.tags && item.tags.includes('blocker') ? 'blocker' : '';
taskBar.className = `task-bar ${task.phaseClass} ${statusClass} ${codeReviewClass} ${blockerClass}`;
```

**3.** Add a legend entry (search for `gantt-legend`):
```html
<span class="gantt-legend-item"><span class="gantt-legend-swatch" style="background:#ef4444"></span>Blocker</span>
```

Push → redeploy → any item with the `blocker` tag shows red.

---

## Troubleshooting: stale cache

**Symptom:** you moved an item in ADO but the dashboard still shows the old sprint.

**Diagnosis path:**
1. Add `?refresh=1` to the URL and reload
2. Check the returned JSON for that item's `sprint` field
3. If the API is correct, the browser cached — hard refresh (Ctrl+Shift+R)
4. If the API is still stale, check the Function logs in Azure Portal → your SWA → **Functions** → **Logs**

---

## Troubleshooting: auth errors

**Symptom A:** `/api/projects/*/tasks` returns 500 with "ADO API returned 401 or 403".
**Fix:** PAT expired or was regenerated. [Rotate the PAT](#rotate-a-pat).

**Symptom B:** Signing in redirects in a loop.
**Fix:** the Entra app registration's redirect URI probably doesn't match your site URL. Update it:
```bash
az ad app update --id <APP_ID> \
  --web-redirect-uris "https://<SITE>.azurestaticapps.net/.auth/login/aad/callback"
```

**Symptom C:** You can sign in but everything returns 403.
**Fix:** you don't have a role assignment. Portal → Static Web App → Role management → Invite → your email → role `admin` (or `authenticated`).

**Verify a PAT directly:**
```bash
PAT=$(az keyvault secret show --vault-name <SITE>-kv --name ado-pat-<PROJECT_ID> --query value -o tsv)
curl -u ":$PAT" \
  "https://dev.azure.com/<ORG>/<PROJECT>/_apis/wit/wiql?api-version=7.1" \
  -H "Content-Type: application/json" \
  -d '{"query":"SELECT [System.Id] FROM WorkItems"}'
```

---

## Troubleshooting: missing items

**Symptom:** an item you know exists in ADO doesn't appear on the Gantt.

**Checklist:**
1. Is its `System.State` = `Removed`? The WIQL query filters those out by design.
2. Is its work item type outside our list? See `api/shared/mapping.js` → `WIQL_WORK_ITEM_TYPES`. Add your custom type and redeploy.
3. Is the cache stale? Force refresh.
4. Is the PAT's account entitled to see it? Check ADO's permission settings.

---

## Uninstall / clean up Azure resources

To fully remove:
```bash
# Deletes the SWA, Key Vault, Storage Account, and every secret. No undo.
az group delete --name <RG> --yes --no-wait
```

Individual resources:
```bash
az staticwebapp delete --name <SITE> --resource-group <RG> --yes
az storage account delete --name <SITE>sa --resource-group <RG> --yes
az keyvault delete --name <SITE>-kv
az keyvault purge --name <SITE>-kv  # Key Vault has soft-delete; purge for real deletion
```

Also delete the Entra app registration:
```bash
az ad app delete --id <APP_ID>
```
