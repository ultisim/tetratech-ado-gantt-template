// Local setup wizard. Serves a small web UI at http://localhost:4321/setup
// that walks the user through:
//   1. Prerequisites check (node, az CLI, gh CLI optional)
//   2. Azure login → subscription pick
//   3. Resource group + region pick/create
//   4. ADO org + project entry (validates against ADO REST)
//   5. ADO PAT entry (validates)
//   6. Optional admin secret
//   7. Provisions Static Web App + Key Vault via Bicep
//   8. Stores PAT in Key Vault
//   9. Deploys frontend + Functions via SWA CLI
//  10. Shows the URL

import express from 'express';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import open from 'open';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PORT = 4321;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(resolve(__dirname, 'ui')));

// ---- Helpers ----
async function run(cmd, args) {
    try {
        const { stdout } = await execFileAsync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
        return { ok: true, stdout: stdout.trim() };
    } catch (err) {
        return { ok: false, error: err.stderr || err.message };
    }
}

async function runAz(args) {
    return run('az', args);
}

function jsonSafe(s) {
    try { return JSON.parse(s); } catch { return null; }
}

// ---- Endpoints called by the UI ----

// Prerequisites
app.get('/api/setup/check', async (_req, res) => {
    const node = await run('node', ['--version']);
    const az = await runAz(['--version']);
    const gh = await run('gh', ['--version']);
    res.json({
        node: node.ok ? node.stdout.split('\n')[0] : null,
        az: az.ok ? az.stdout.split('\n')[0] : null,
        gh: gh.ok ? gh.stdout.split('\n')[0] : null,
    });
});

// Login and list subscriptions
app.post('/api/setup/az-login', async (_req, res) => {
    const login = await runAz(['login', '--only-show-errors', '-o', 'json']);
    if (!login.ok) return res.status(500).json({ error: login.error });
    const subs = jsonSafe(login.stdout) || [];
    res.json({ subscriptions: subs.map(s => ({ id: s.id, name: s.name, tenantId: s.tenantId })) });
});

app.get('/api/setup/subscriptions', async (_req, res) => {
    const r = await runAz(['account', 'list', '-o', 'json']);
    if (!r.ok) return res.status(500).json({ error: r.error });
    const subs = jsonSafe(r.stdout) || [];
    res.json({ subscriptions: subs.map(s => ({ id: s.id, name: s.name })) });
});

app.post('/api/setup/set-subscription', async (req, res) => {
    const { subscriptionId } = req.body;
    const r = await runAz(['account', 'set', '--subscription', subscriptionId]);
    if (!r.ok) return res.status(500).json({ error: r.error });
    res.json({ ok: true });
});

// Resource groups
app.get('/api/setup/resource-groups', async (_req, res) => {
    const r = await runAz(['group', 'list', '-o', 'json']);
    if (!r.ok) return res.status(500).json({ error: r.error });
    res.json({ groups: (jsonSafe(r.stdout) || []).map(g => ({ name: g.name, location: g.location })) });
});

app.post('/api/setup/create-resource-group', async (req, res) => {
    const { name, location } = req.body;
    const r = await runAz(['group', 'create', '--name', name, '--location', location, '-o', 'json']);
    if (!r.ok) return res.status(500).json({ error: r.error });
    res.json({ ok: true });
});

// Regions where Static Web Apps is available
app.get('/api/setup/regions', (_req, res) => {
    // SWA is available in a fixed list (as of 2026). Not worth an API call.
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

// Validate ADO org + project + PAT with a lightweight WIQL call
app.post('/api/setup/validate-ado', async (req, res) => {
    const { adoOrg, adoProject, adoPat } = req.body;
    if (!adoOrg || !adoProject || !adoPat) {
        return res.status(400).json({ error: 'adoOrg, adoProject, and adoPat all required' });
    }
    try {
        const auth = 'Basic ' + Buffer.from(':' + adoPat).toString('base64');
        const url = `https://dev.azure.com/${encodeURIComponent(adoOrg)}/${encodeURIComponent(adoProject)}/_apis/wit/wiql?api-version=7.1`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': auth,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({
                query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${adoProject.replace(/'/g, "''")}'`,
            }),
        });
        if (!resp.ok) {
            const body = await resp.text();
            return res.status(400).json({ error: `ADO API returned ${resp.status}: ${body.slice(0, 300)}` });
        }
        const data = await resp.json();
        res.json({ ok: true, itemCount: (data.workItems || []).length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Provision — the big one. Deploys Bicep + does initial site upload.
// Streams progress back via SSE so the UI shows what's happening.
app.post('/api/setup/provision', async (req, res) => {
    const { subscriptionId, resourceGroup, location, siteName, adoOrg, adoProject, adoPat, adminSecret } = req.body;

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

        send('log', { msg: `Deploying Bicep template to resource group ${resourceGroup}…` });
        const bicepPath = resolve(REPO_ROOT, 'infra', 'main.bicep');
        const args = [
            'deployment', 'group', 'create',
            '--resource-group', resourceGroup,
            '--template-file', bicepPath,
            '--parameters',
            `siteName=${siteName}`,
            `location=${location}`,
            `adoOrg=${adoOrg}`,
            `adoProject=${adoProject}`,
            `adoPat=${adoPat}`,
            `adminSecret=${adminSecret || ''}`,
            '--output', 'json',
        ];
        const bicep = await execFileAsync('az', args, { maxBuffer: 32 * 1024 * 1024 });
        const bicepOut = JSON.parse(bicep.stdout);
        const siteUrl = bicepOut.properties?.outputs?.siteUrl?.value;
        send('log', { msg: `Provisioned. Site URL: ${siteUrl}` });

        send('log', { msg: 'Fetching deployment token…' });
        const tokenResp = await execFileAsync('az', [
            'staticwebapp', 'secrets', 'list',
            '--name', siteName,
            '--query', 'properties.apiKey',
            '-o', 'tsv',
        ]);
        const deploymentToken = tokenResp.stdout.trim();

        send('log', { msg: 'Writing public/config.js…' });
        const configJs = `window.__CONFIG__ = {\n` +
            `    projectDisplayName: ${JSON.stringify(adoProject)},\n` +
            `    adoProjectUrl: ${JSON.stringify(`https://dev.azure.com/${adoOrg}/${adoProject}`)},\n` +
            `};\n`;
        await writeFile(resolve(REPO_ROOT, 'public', 'config.js'), configJs);

        send('log', { msg: 'Installing API dependencies…' });
        await execFileAsync('npm', ['install', '--production'], {
            cwd: resolve(REPO_ROOT, 'api'),
            shell: true,
        });

        send('log', { msg: 'Deploying frontend + Functions via SWA CLI (this takes 2-3 min)…' });
        await execFileAsync('npx', [
            '@azure/static-web-apps-cli', 'deploy', 'public',
            '--api-location', 'api',
            '--deployment-token', deploymentToken,
            '--env', 'production',
        ], {
            cwd: REPO_ROOT,
            shell: true,
            maxBuffer: 64 * 1024 * 1024,
        });

        send('log', { msg: 'Verifying deployment…' });
        // Wait a few seconds, then hit /api/health
        await new Promise(r => setTimeout(r, 5000));
        try {
            const health = await fetch(`${siteUrl}/api/health`);
            if (health.ok) {
                const h = await health.json();
                send('log', { msg: `Health check OK — ${JSON.stringify(h)}` });
            } else {
                send('log', { msg: `Health check returned ${health.status} — may still be warming up` });
            }
        } catch (err) {
            send('log', { msg: `Health check pending (site may still be initializing): ${err.message}` });
        }

        send('done', { siteUrl, siteName, resourceGroup });
        res.end();
    } catch (err) {
        send('error', { message: err.message || String(err) });
        res.end();
    }
});

// Serve the wizard UI as the root
app.get('/', (_req, res) => res.redirect('/setup/'));
app.get('/setup', (_req, res) => res.redirect('/setup/'));

app.listen(PORT, () => {
    const url = `http://localhost:${PORT}/setup/`;
    console.log(`\n  ADO Gantt setup wizard\n  ─────────────────────────────────────\n  Open in browser: ${url}\n`);
    open(url).catch(() => {});
});
