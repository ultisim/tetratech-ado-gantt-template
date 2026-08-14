// Local setup wizard.
//
// Serves a step-by-step UI at http://localhost:3000/setup that provisions the
// PM's own Azure instance of the dashboard. Flow:
//   1. Prerequisites check (node, az CLI, gh CLI optional)
//   2. Azure login → subscription pick
//   3. Resource group + region
//   4. Site name + optional tenant lock
//   5. Entra ID app registration (creates via `az ad app create` — the PM's own tenant)
//   6. Provisions SWA + Storage + Key Vault via Bicep
//   7. Deploys frontend + Functions
//   8. Assigns the current user as the admin role via SWA role invitation
//   9. Shows the URL and next steps
//
// After first install, PMs add projects through /setup.html inside the deployed app.
// The local wizard is only run once per install.

import express from 'express';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import open from 'open';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PORT = 3000;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(resolve(__dirname, 'ui')));

// ---- Helpers ----
async function run(cmd, args, opts = {}) {
    try {
        const { stdout } = await execFileAsync(cmd, args, {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            ...opts,
        });
        return { ok: true, stdout: stdout.trim() };
    } catch (err) {
        return { ok: false, error: err.stderr || err.message };
    }
}
const az = args => run('az', args);
const jsonSafe = s => { try { return JSON.parse(s); } catch { return null; } };

// ---- Endpoints called by the UI ----

app.get('/api/setup/check', async (_req, res) => {
    const [node, azCli, gh] = await Promise.all([
        run('node', ['--version']),
        az(['--version']),
        run('gh', ['--version']),
    ]);
    res.json({
        node: node.ok ? node.stdout.split('\n')[0] : null,
        az: azCli.ok ? azCli.stdout.split('\n')[0] : null,
        gh: gh.ok ? gh.stdout.split('\n')[0] : null,
    });
});

app.post('/api/setup/az-login', async (_req, res) => {
    const login = await az(['login', '--only-show-errors', '-o', 'json']);
    if (!login.ok) return res.status(500).json({ error: login.error });
    const subs = jsonSafe(login.stdout) || [];
    res.json({ subscriptions: subs.map(s => ({ id: s.id, name: s.name, tenantId: s.tenantId })) });
});

app.post('/api/setup/set-subscription', async (req, res) => {
    const r = await az(['account', 'set', '--subscription', req.body.subscriptionId]);
    if (!r.ok) return res.status(500).json({ error: r.error });
    // Also grab tenant id so the UI can offer a "restrict to this tenant" toggle
    const acct = await az(['account', 'show', '-o', 'json']);
    const info = jsonSafe(acct.stdout || '{}');
    res.json({ ok: true, tenantId: info?.tenantId || null, userName: info?.user?.name || null });
});

app.get('/api/setup/resource-groups', async (_req, res) => {
    const r = await az(['group', 'list', '-o', 'json']);
    if (!r.ok) return res.status(500).json({ error: r.error });
    res.json({ groups: (jsonSafe(r.stdout) || []).map(g => ({ name: g.name, location: g.location })) });
});

app.post('/api/setup/create-resource-group', async (req, res) => {
    const { name, location } = req.body;
    const r = await az(['group', 'create', '--name', name, '--location', location, '-o', 'json']);
    if (!r.ok) return res.status(500).json({ error: r.error });
    res.json({ ok: true });
});

app.get('/api/setup/regions', (_req, res) => {
    res.json({
        regions: [
            { name: 'eastus2', display: 'East US 2' },
            { name: 'centralus', display: 'Central US' },
            { name: 'westus2', display: 'West US 2' },
            { name: 'westeurope', display: 'West Europe' },
            { name: 'eastasia', display: 'East Asia' },
        ],
    });
});

// The big one: provision + deploy. Streams progress via SSE.
app.post('/api/setup/provision', async (req, res) => {
    const {
        subscriptionId, resourceGroup, location, siteName,
        aadClientId, aadClientSecret, allowedTenantId,
    } = req.body;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        send('log', { msg: `Setting subscription ${subscriptionId}…` });
        await execFileAsync('az', ['account', 'set', '--subscription', subscriptionId]);

        send('log', { msg: `Deploying Bicep to ${resourceGroup}… (this takes 2–4 min)` });
        const bicepPath = resolve(REPO_ROOT, 'infra', 'main.bicep');
        const bicep = await execFileAsync('az', [
            'deployment', 'group', 'create',
            '--resource-group', resourceGroup,
            '--template-file', bicepPath,
            '--parameters',
            `siteName=${siteName}`,
            `location=${location}`,
            `aadClientId=${aadClientId}`,
            `aadClientSecret=${aadClientSecret}`,
            `allowedTenantId=${allowedTenantId || ''}`,
            '--output', 'json',
        ], { maxBuffer: 64 * 1024 * 1024 });
        const bicepOut = JSON.parse(bicep.stdout);
        const outputs = bicepOut.properties?.outputs || {};
        const siteUrl = outputs.siteUrl?.value;
        const kvName = outputs.keyVaultName?.value;
        const storageName = outputs.storageAccountName?.value;
        send('log', { msg: `Provisioned. Site: ${siteUrl}, KV: ${kvName}, Storage: ${storageName}` });

        send('log', { msg: 'Fetching deployment token…' });
        const tokenResp = await execFileAsync('az', [
            'staticwebapp', 'secrets', 'list',
            '--name', siteName, '--query', 'properties.apiKey', '-o', 'tsv',
        ]);
        const deploymentToken = tokenResp.stdout.trim();

        send('log', { msg: 'Installing API deps…' });
        await execFileAsync('npm', ['install', '--production'], {
            cwd: resolve(REPO_ROOT, 'api'),
            shell: true,
        });

        send('log', { msg: 'Deploying frontend + Functions via SWA CLI…' });
        await execFileAsync('npx', [
            '@azure/static-web-apps-cli', 'deploy', 'public',
            '--api-location', 'api',
            '--deployment-token', deploymentToken,
            '--env', 'production',
        ], { cwd: REPO_ROOT, shell: true, maxBuffer: 128 * 1024 * 1024 });

        send('log', { msg: 'Inviting current user as admin…' });
        // Get the current signed-in az user
        const acct = await execFileAsync('az', ['account', 'show', '-o', 'json']);
        const userEmail = jsonSafe(acct.stdout)?.user?.name;
        if (userEmail) {
            // SWA role invitation via the REST API (there's no first-class CLI verb).
            // The user will need to accept the invite by visiting the URL. On acceptance,
            // they get the 'admin' role and can log into /setup.html.
            const inviteUrl = await execFileAsync('az', [
                'rest',
                '--method', 'post',
                '--uri',
                `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/staticSites/${siteName}/createUserInvitation?api-version=2022-03-01`,
                '--body', JSON.stringify({
                    domain: new URL(siteUrl).hostname,
                    provider: 'aad',
                    userDetails: userEmail,
                    roles: 'admin',
                    numHoursToExpiration: 48,
                }),
                '--headers', 'Content-Type=application/json',
            ]).catch(err => ({ stdout: JSON.stringify({ error: err.message }) }));
            const inviteObj = jsonSafe(inviteUrl.stdout);
            if (inviteObj?.invitationUrl) {
                send('log', { msg: `Admin invite ready — see final step for the accept URL.` });
                send('done', { siteUrl, siteName, resourceGroup, userEmail, inviteUrl: inviteObj.invitationUrl });
                res.end();
                return;
            }
            send('log', { msg: `Admin invite couldn't be created automatically — you'll need to invite yourself via Azure Portal (Static Web App → Role management).` });
        }

        send('done', { siteUrl, siteName, resourceGroup, userEmail, inviteUrl: null });
        res.end();
    } catch (err) {
        send('error', { message: err.message || String(err) });
        res.end();
    }
});

app.get('/', (_req, res) => res.redirect('/setup/'));
app.get('/setup', (_req, res) => res.redirect('/setup/'));

app.listen(PORT, () => {
    const url = `http://localhost:${PORT}/setup/`;
    console.log(`\n  ADO Gantt setup wizard\n  ─────────────────────────────────────\n  Open in browser: ${url}\n`);
    open(url).catch(() => {});
});
