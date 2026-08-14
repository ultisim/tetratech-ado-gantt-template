# Runbook — Operational Tasks

Task-oriented reference. Each section is a "how do I…" for something you'll actually need to do. Skim the headings; jump to the one you need.

**Variables used below** — replace with your values:
- `<SITE>` — your site name (e.g. `gantt-my-project`)
- `<RG>` — your Azure resource group name
- `<SITE_URL>` — e.g. `https://gantt-my-project.azurestaticapps.net`
- `<ADMIN_SECRET>` — the secret you set during `npm run setup` (only needed for bulk migrations)

---

## Contents

- [Force a cache refresh](#force-a-cache-refresh)
- [Bulk-move items between sprints](#bulk-move-items-between-sprints)
- [Bulk-mark items Done](#bulk-mark-items-done)
- [Bulk-create items from CSV](#bulk-create-items-from-csv)
- [Enable or disable the admin API](#enable-or-disable-the-admin-api)
- [Rotate the ADO PAT](#rotate-the-ado-pat)
- [Add a custom domain](#add-a-custom-domain)
- [Customize branding](#customize-branding)
- [Add a new custom tag category](#add-a-new-custom-tag-category)
- [Troubleshooting: stale cache](#troubleshooting-stale-cache)
- [Troubleshooting: auth errors](#troubleshooting-auth-errors)
- [Troubleshooting: missing items](#troubleshooting-missing-items)
- [Uninstall / clean up Azure resources](#uninstall--clean-up-azure-resources)

---

## Force a cache refresh

The API caches ADO responses for 5 min. To force a fresh pull:

**From a browser:**
Add `?refresh=1` to any endpoint URL:
```
<SITE_URL>/api/tasks?refresh=1
<SITE_URL>/api/sprint/4?refresh=1
```

**From the terminal:**
```bash
curl "<SITE_URL>/api/tasks?refresh=1" > /dev/null
for i in 0 1 2 3 4 5 6 7 8 9 10; do
  curl -s "<SITE_URL>/api/sprint/$i?refresh=1" > /dev/null
done
```

After that, hard-refresh the browser (Ctrl+Shift+R) to bypass Chrome's response cache too.

---

## Bulk-move items between sprints

Say you want to move all unfinished items in Sprint 3 to Sprint 4.

**1. Get the list of IDs from the dashboard's own data:**
```bash
curl -s "<SITE_URL>/api/tasks" | \
  python3 -c "
import json, sys
d = json.load(sys.stdin)
unfinished = [t['id'] for t in d if t.get('sprint') == 3 and t['status'] != 'completed']
print(json.dumps({'ids': unfinished, 'sprint': 4}))
" > payload.json
```

**2. Send to the admin endpoint:**
```bash
curl -X POST "<SITE_URL>/api/admin/move-iteration" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: <ADMIN_SECRET>" \
  -d @payload.json
```

Response:
```json
{"ok": 18, "failed": 0, "total": 18, "targetSprint": "MyProject\\Sprint 4", "results": [...]}
```

The endpoint automatically busts the cache, so the dashboard reflects the change immediately.

---

## Bulk-mark items Done

Same shape as move, but a different endpoint. E.g. after a code review pass:

```bash
curl -X POST "<SITE_URL>/api/admin/set-state" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: <ADMIN_SECRET>" \
  -d '{"ids": [375, 376, 377], "state": "Done"}'
```

The `state` value must be a valid ADO state name for those work item types — usually `Done`, `Closed`, `In Progress`, `To Do`, or `New`.

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

**2. Send:**
```bash
curl -X POST "<SITE_URL>/api/admin/create-items" \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: <ADMIN_SECRET>" \
  -d '{"items": [ ... ]}'
```

Returns `{ok, failed, total, results: [{id, title}, ...]}` with the new work item IDs.

The endpoint uses `bypassRules=true` so it works even if your ADO process template has required fields on create.

---

## Enable or disable the admin API

The `/api/admin/*` endpoints are **disabled by default** — any call returns 404 as if they don't exist. To enable, set an `ADMIN_SECRET` in the Static Web App configuration:

**Enable:**
```bash
# Store the secret in Key Vault (recommended)
az keyvault secret set \
  --vault-name <SITE>-kv \
  --name ADMIN-SECRET \
  --value "<PICK-A-STRONG-SECRET>"

# Then update the SWA app setting to reference it
az staticwebapp appsettings set \
  --name <SITE> \
  --setting-names ADMIN_SECRET="@Microsoft.KeyVault(VaultName=<SITE>-kv;SecretName=ADMIN-SECRET)"
```

**Disable:**
```bash
az staticwebapp appsettings delete \
  --name <SITE> \
  --setting-names ADMIN_SECRET
```

Every admin call must include `X-Admin-Secret: <value>` header. Anything else → 401. If the env var is unset → 404.

---

## Rotate the ADO PAT

PATs expire (max 1 year). To rotate:

**1. Create a new PAT in ADO:**
- Visit `https://dev.azure.com/<YOUR-ORG>/_usersSettings/tokens`
- Click "+ New Token", scope: **Work Items → Read, write, & manage**
- Copy the token value (you can only see it once)

**2. Update the secret in Key Vault:**
```bash
az keyvault secret set \
  --vault-name <SITE>-kv \
  --name ADO-PAT \
  --value "<NEW-PAT>"
```

**3. Restart the Functions runtime** so it picks up the new value:
```bash
az staticwebapp restart --name <SITE>
```

(Or wait ~10 min — SWA re-reads Key Vault references on cold start.)

---

## Add a custom domain

**1. In the Azure Portal:** navigate to your Static Web App → **Custom domains** → **+ Add**.

**2. Enter your subdomain** (e.g. `gantt.yourcompany.com`). Azure will show you the CNAME record to create.

**3. In your DNS provider:** add the CNAME pointing to your `*.azurestaticapps.net` hostname.

**4. Back in Azure:** click **Validate**. Once green, the site is live at your custom URL with a free auto-renewing TLS cert.

---

## Customize branding

The site's title and DevOps link are driven by `public/config.js` — written by the setup wizard, but you can edit and redeploy:

```js
window.__CONFIG__ = {
    projectDisplayName: 'My Project',           // shown in header + tab title
    adoProjectUrl: 'https://dev.azure.com/...', // "Open in Azure DevOps" link
};
```

For deeper visual customization (colors, logo), edit `public/index.html` — everything is inline CSS in the `<style>` block near the top. Search for these variables:
- `--primary` (dominant color)
- `.gantt-legend-swatch` blocks (status colors)
- `.header` (top bar styling)

Push changes → GitHub Actions redeploys.

---

## Add a new custom tag category

Say you want ADO items tagged `blocker` to render red. In `public/index.html`:

**1. Add a CSS class:**
```css
.task-bar.blocker {
    background: #ef4444 !important;
    color: white;
}
```

**2. Apply the class in the recursive renderer** (search for `codeReviewClass`):
```js
const blockerClass = item.tags && item.tags.includes('blocker') ? 'blocker' : '';
taskBar.className = `task-bar ${task.phaseClass} ${statusClass} ${codeReviewClass} ${blockerClass}`;
```

**3. Add a legend entry** (search for `gantt-legend`):
```html
<span class="gantt-legend-item"><span class="gantt-legend-swatch" style="background:#ef4444"></span>Blocker</span>
```

Push → redeploy → any item with the `blocker` tag in ADO shows red.

---

## Troubleshooting: stale cache

**Symptom:** you moved an item in ADO but the dashboard still shows the old sprint.

**Diagnosis path:**
1. `curl "<SITE_URL>/api/tasks?refresh=1"` → forces a fresh ADO pull
2. Check the returned JSON for that item's `sprint` field
3. If the API is correct, the browser is caching — hard refresh (Ctrl+Shift+R)
4. If the API is stale too, check the Function logs:
   ```bash
   az staticwebapp logs show --name <SITE>
   ```

---

## Troubleshooting: auth errors

**Symptom:** `/api/tasks` returns 500 with "ADO API returned 401 or 403".

**Possible causes:**
- PAT expired → [Rotate the ADO PAT](#rotate-the-ado-pat)
- PAT was regenerated in ADO but Key Vault wasn't updated → same fix
- PAT scope changed and no longer includes Work Items → recreate with correct scope

**Verify the PAT directly:**
```bash
# Get the PAT out of Key Vault (only works if you have Key Vault Secrets User role)
PAT=$(az keyvault secret show --vault-name <SITE>-kv --name ADO-PAT --query value -o tsv)
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
2. Is its work item type outside our list? See `api/shared/mapping.js` → `WIQL_WORK_ITEM_TYPES`. Add your custom type there and redeploy.
3. Is the cache stale? Force refresh (see above).

To spot-check what ADO says vs what the API returns:
```bash
# ADO directly
curl -u ":$PAT" \
  "https://dev.azure.com/<ORG>/_apis/wit/workitems/<ID>?api-version=7.1"

# Our API
curl -s "<SITE_URL>/api/tasks?refresh=1" | python3 -c "
import json, sys
d = json.load(sys.stdin)
t = next((x for x in d if x['id'] == <ID>), None)
print(json.dumps(t, indent=2))
"
```

---

## Uninstall / clean up Azure resources

To fully remove:
```bash
# Deletes the SWA, Key Vault, and every secret. There is NO undo.
az group delete --name <RG> --yes --no-wait
```

Or just delete individual resources:
```bash
az staticwebapp delete --name <SITE> --resource-group <RG> --yes
az keyvault delete --name <SITE>-kv
az keyvault purge --name <SITE>-kv  # for real deletion (Key Vault has soft-delete by default)
```
