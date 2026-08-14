// Azure Functions v4 Node programming model.
// Route structure:
//   /api/health                                     — anonymous
//   /api/me                                         — authed; returns principal + isAdmin
//   /api/projects                                   — authed; list  (admin: POST creates)
//   /api/projects/{id}                              — admin PUT/DELETE
//   /api/projects/{id}/tasks                        — authed
//   /api/projects/{id}/sprint/{n}                   — authed
//   /api/projects/{id}/admin/move-iteration         — admin, gated by X-Admin-Secret
//   /api/projects/{id}/admin/set-state              — admin, gated by X-Admin-Secret
//   /api/projects/{id}/admin/create-items           — admin, gated by X-Admin-Secret

import { app } from '@azure/functions';
import {
    getEnv, buildProjectContext, jsonResponse,
    getPrincipal, requireAuthenticated, requireAdmin,
} from '../shared/config.js';
import { cacheGet, cacheSet, cacheDelete } from '../shared/cache.js';
import {
    listProjects, getProject, upsertProject, deleteProject,
} from '../shared/projectStore.js';
import {
    getPat, setPat, getAdminSecret, setAdminSecret,
    deleteAdminSecret, deleteProjectSecrets,
} from '../shared/keyvault.js';
import { fetchAllTasks } from '../shared/pipeline.js';
import {
    wiqlQueryIds, batchFetchWorkItems, patchWorkItem, createWorkItem,
} from '../shared/ado.js';
import { isCompletedState } from '../shared/mapping.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ADMIN_CACHE_KEYS_PER_PROJECT = 20; // for sprint:0..19 in bustCaches

/** Resolve the per-request project context from a projectId. */
async function loadProjectContext(projectId) {
    const project = await getProject(projectId);
    if (!project) return { ok: false, status: 404, body: { error: `Project '${projectId}' not found` } };
    const pat = await getPat(projectId);
    if (!pat) {
        return {
            ok: false, status: 500,
            body: { error: `PAT missing in Key Vault for project '${projectId}'. Re-add the project or rotate the PAT.` },
        };
    }
    return { ok: true, cfg: buildProjectContext(project, pat), project };
}

/** Check the X-Admin-Secret header against the project's stored secret. */
async function checkProjectAdminHeader(request, projectId) {
    const stored = await getAdminSecret(projectId);
    if (!stored) return { ok: false, status: 404, body: { error: 'Admin API disabled for this project' } };
    const provided = request.headers.get('x-admin-secret');
    if (!provided || provided !== stored) {
        return { ok: false, status: 401, body: { error: 'Invalid or missing X-Admin-Secret header' } };
    }
    return { ok: true };
}

async function runInBatches(items, concurrency, fn) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        results.push(...await Promise.all(batch.map(fn)));
    }
    return results;
}

function bustProjectCaches(projectId) {
    cacheDelete(`tasks:${projectId}`);
    for (let s = 0; s <= ADMIN_CACHE_KEYS_PER_PROJECT; s++) {
        cacheDelete(`sprint:${projectId}:${s}`);
    }
}

// ---------------------------------------------------------------------------
// Health + identity
// ---------------------------------------------------------------------------

app.http('health', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'health',
    handler: async () => {
        try {
            const env = getEnv();
            return jsonResponse({
                ok: true,
                keyVault: env.keyVaultUri,
                storageAccount: env.storageAccountName,
                cacheTtlSeconds: env.cacheTtlSeconds,
                tenantLocked: !!env.allowedTenantId,
            });
        } catch (err) {
            return jsonResponse({ ok: false, error: err.message }, 500);
        }
    },
});

app.http('me', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'me',
    handler: async (request) => {
        const principal = getPrincipal(request);
        if (!principal) return jsonResponse({ authenticated: false }, 200);
        return jsonResponse({
            authenticated: true,
            id: principal.id,
            name: principal.name,
            provider: principal.provider,
            roles: principal.roles,
            isAdmin: principal.roles.includes('admin'),
        });
    },
});

// ---------------------------------------------------------------------------
// Project CRUD
// ---------------------------------------------------------------------------

app.http('projects-list', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'projects',
    handler: async (request) => {
        const auth = requireAuthenticated(request);
        if (!auth.ok) return jsonResponse(auth.body, auth.status);
        try {
            const projects = await listProjects();
            // Strip nothing — no secrets stored in the record, only Key Vault names
            return jsonResponse(projects);
        } catch (err) {
            return jsonResponse({ error: err.message }, 500);
        }
    },
});

app.http('projects-create', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'projects',
    handler: async (request) => {
        const auth = requireAdmin(request);
        if (!auth.ok) return jsonResponse(auth.body, auth.status);
        const body = await request.json().catch(() => null);
        if (!body || !body.id || !body.adoOrg || !body.adoProject || !body.pat) {
            return jsonResponse({
                error: 'Required: { id, adoOrg, adoProject, pat }. Optional: displayName, adminSecret.',
            }, 400);
        }
        try {
            // Validate the PAT works before storing anything
            const orgUrl = `https://dev.azure.com/${encodeURIComponent(body.adoOrg)}`;
            const authHeader = 'Basic ' + Buffer.from(':' + body.pat).toString('base64');
            const testResp = await fetch(`${orgUrl}/${encodeURIComponent(body.adoProject)}/_apis/wit/wiql?api-version=7.1`, {
                method: 'POST',
                headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${body.adoProject.replace(/'/g, "''")}'`,
                }),
            });
            if (!testResp.ok) {
                const errBody = await testResp.text();
                return jsonResponse({
                    error: `ADO validation failed (${testResp.status}): ${errBody.slice(0, 300)}`,
                }, 400);
            }

            // Store PAT + optional admin secret in Key Vault first, then project record
            await setPat(body.id, body.pat);
            if (body.adminSecret) await setAdminSecret(body.id, body.adminSecret);

            const project = await upsertProject({
                id: body.id,
                displayName: body.displayName || body.adoProject,
                adoOrg: body.adoOrg,
                adoProject: body.adoProject,
                hasAdminSecret: !!body.adminSecret,
            }, auth.principal);

            return jsonResponse(project, 201);
        } catch (err) {
            return jsonResponse({ error: err.message }, 500);
        }
    },
});

app.http('projects-update', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'projects/{id}',
    handler: async (request) => {
        const auth = requireAdmin(request);
        if (!auth.ok) return jsonResponse(auth.body, auth.status);
        const id = request.params.id;
        const body = await request.json().catch(() => null);
        if (!body) return jsonResponse({ error: 'Body required' }, 400);
        const existing = await getProject(id);
        if (!existing) return jsonResponse({ error: 'Project not found' }, 404);

        try {
            // Optional: update PAT (only if user provided a new one)
            if (body.pat) await setPat(id, body.pat);
            // Optional: update admin secret. Empty string DELETES it (disables admin API).
            let hasAdminSecret = existing.hasAdminSecret;
            if (body.adminSecret !== undefined) {
                if (body.adminSecret === '') {
                    await deleteAdminSecret(id).catch(() => {});
                    hasAdminSecret = false;
                } else {
                    await setAdminSecret(id, body.adminSecret);
                    hasAdminSecret = true;
                }
            }
            const project = await upsertProject({
                id,
                displayName: body.displayName ?? existing.displayName,
                adoOrg: body.adoOrg ?? existing.adoOrg,
                adoProject: body.adoProject ?? existing.adoProject,
                hasAdminSecret,
            }, auth.principal);
            bustProjectCaches(id);
            return jsonResponse(project);
        } catch (err) {
            return jsonResponse({ error: err.message }, 500);
        }
    },
});

app.http('projects-delete', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'projects/{id}',
    handler: async (request) => {
        const auth = requireAdmin(request);
        if (!auth.ok) return jsonResponse(auth.body, auth.status);
        const id = request.params.id;
        try {
            const deleted = await deleteProject(id);
            if (!deleted) return jsonResponse({ error: 'Project not found' }, 404);
            await deleteProjectSecrets(id);
            bustProjectCaches(id);
            return jsonResponse({ ok: true, id });
        } catch (err) {
            return jsonResponse({ error: err.message }, 500);
        }
    },
});

// ---------------------------------------------------------------------------
// Tasks per project
// ---------------------------------------------------------------------------

app.http('project-tasks', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'projects/{id}/tasks',
    handler: async (request, context) => {
        const auth = requireAuthenticated(request);
        if (!auth.ok) return jsonResponse(auth.body, auth.status);
        const projectId = request.params.id;
        const env = getEnv();
        const url = new URL(request.url);
        const force = url.searchParams.get('refresh') === '1';
        const cacheKey = `tasks:${projectId}`;
        if (!force) {
            const cached = cacheGet(cacheKey);
            if (cached) return jsonResponse(cached.value, 200, {
                'X-Cache': 'HIT', 'X-Cache-Age': String(cached.ageSeconds),
            });
        }
        const ctx = await loadProjectContext(projectId);
        if (!ctx.ok) return jsonResponse(ctx.body, ctx.status);
        try {
            const tasks = await fetchAllTasks(ctx.cfg);
            cacheSet(cacheKey, tasks, env.cacheTtlSeconds);
            return jsonResponse(tasks, 200, { 'X-Cache': 'MISS' });
        } catch (err) {
            context.error('project-tasks failed', err);
            return jsonResponse({ error: err.message }, 500);
        }
    },
});

// ---------------------------------------------------------------------------
// Sprint checklist per project
// ---------------------------------------------------------------------------

app.http('project-sprint', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'projects/{id}/sprint/{num}',
    handler: async (request, context) => {
        const auth = requireAuthenticated(request);
        if (!auth.ok) return jsonResponse(auth.body, auth.status);
        const projectId = request.params.id;
        const num = request.params.num;
        const env = getEnv();
        const url = new URL(request.url);
        const force = url.searchParams.get('refresh') === '1';
        const cacheKey = `sprint:${projectId}:${num}`;
        if (!force) {
            const cached = cacheGet(cacheKey);
            if (cached) return jsonResponse(cached.value, 200, {
                'X-Cache': 'HIT', 'X-Cache-Age': String(cached.ageSeconds),
            });
        }
        const ctx = await loadProjectContext(projectId);
        if (!ctx.ok) return jsonResponse(ctx.body, ctx.status);
        try {
            const data = await fetchSprintChecklist(ctx.cfg, num);
            cacheSet(cacheKey, data, env.cacheTtlSeconds);
            return jsonResponse(data, 200, { 'X-Cache': 'MISS' });
        } catch (err) {
            context.error('project-sprint failed', err);
            return jsonResponse({ error: err.message }, 500);
        }
    },
});

async function fetchSprintChecklist(cfg, sprintNum) {
    const sprintPath = `${cfg.adoProject}\\Sprint ${sprintNum}`;
    const pbiIds = await wiqlQueryIds(cfg, `
        SELECT [System.Id] FROM WorkItems
        WHERE [System.TeamProject] = '${cfg.adoProject.replace(/'/g, "''")}'
          AND [System.IterationPath] = '${sprintPath.replace(/'/g, "''")}'
          AND [System.WorkItemType] IN ('Product Backlog Item', 'User Story', 'Bug')
          AND [System.State] <> 'Removed'
        ORDER BY [Microsoft.VSTS.Common.Priority], [System.Id]
    `);
    if (pbiIds.length === 0) return [];
    const taskIds = await wiqlQueryIds(cfg, `
        SELECT [System.Id] FROM WorkItems
        WHERE [System.TeamProject] = '${cfg.adoProject.replace(/'/g, "''")}'
          AND [System.IterationPath] = '${sprintPath.replace(/'/g, "''")}'
          AND [System.WorkItemType] = 'Task'
          AND [System.State] <> 'Removed'
        ORDER BY [System.Id]
    `);
    const sprintFields = [
        'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
        'System.AssignedTo', 'System.Parent', 'System.Tags',
        'Microsoft.VSTS.Common.Priority',
    ];
    const items = await batchFetchWorkItems(cfg, [...pbiIds, ...taskIds], sprintFields);
    const tasksByParent = {};
    const pbiSet = new Set(pbiIds);
    for (const wi of items) {
        if (!pbiSet.has(wi.id)) {
            const parentId = wi.fields['System.Parent'];
            if (parentId) (tasksByParent[parentId] ||= []).push(wi);
        }
    }
    return items.filter(wi => pbiSet.has(wi.id)).map(wi => {
        const f = wi.fields;
        const state = f['System.State'];
        const stateCompleted = isCompletedState(state);
        const childTasks = (tasksByParent[wi.id] || []).map(t => {
            const ts = t.fields['System.State'];
            return {
                id: t.id,
                title: t.fields['System.Title'],
                state: ts,
                completed: isCompletedState(ts),
                assignedTo: t.fields['System.AssignedTo']?.displayName || 'Unassigned',
                ado_url: `https://dev.azure.com/${encodeURIComponent(cfg.adoOrg)}/` +
                         `${encodeURIComponent(cfg.adoProject)}/_workitems/edit/${t.id}`,
            };
        });
        const total = childTasks.length;
        const done = childTasks.filter(t => t.completed).length;
        const allDone = total > 0 && done === total;
        const completed = stateCompleted || allDone;
        return {
            id: wi.id,
            title: f['System.Title'],
            type: f['System.WorkItemType'],
            state: completed ? 'Done' : state,
            completed,
            priority: f['Microsoft.VSTS.Common.Priority'] || 99,
            assignedTo: f['System.AssignedTo']?.displayName || 'Unassigned',
            ado_url: `https://dev.azure.com/${encodeURIComponent(cfg.adoOrg)}/` +
                     `${encodeURIComponent(cfg.adoProject)}/_workitems/edit/${wi.id}`,
            evidence_links: [],
            tasks: childTasks,
            taskProgress: total > 0 ? `${done}/${total}` : null,
        };
    });
}

// ---------------------------------------------------------------------------
// Per-project admin endpoints — gated by X-Admin-Secret
// ---------------------------------------------------------------------------

app.http('project-admin-move-iteration', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'projects/{id}/admin/move-iteration',
    handler: async (request) => {
        if (request.method === 'OPTIONS') return jsonResponse({}, 204);
        const projectId = request.params.id;
        const adminCheck = await checkProjectAdminHeader(request, projectId);
        if (!adminCheck.ok) return jsonResponse(adminCheck.body, adminCheck.status);
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.ids) || body.ids.length === 0 || typeof body.sprint !== 'number') {
            return jsonResponse({ error: 'Body must be { ids: number[], sprint: number }' }, 400);
        }
        const ctx = await loadProjectContext(projectId);
        if (!ctx.ok) return jsonResponse(ctx.body, ctx.status);
        const newIterationPath = `${ctx.cfg.adoProject}\\Sprint ${body.sprint}`;
        const results = await runInBatches(body.ids, 8, async id => {
            try {
                const data = await patchWorkItem(ctx.cfg, id, [
                    { op: 'add', path: '/fields/System.IterationPath', value: newIterationPath },
                ]);
                return { id, ok: true, newIteration: data.fields?.['System.IterationPath'] };
            } catch (err) {
                return { id, ok: false, error: err.message };
            }
        });
        bustProjectCaches(projectId);
        const ok = results.filter(r => r.ok).length;
        return jsonResponse({ ok, failed: results.length - ok, total: results.length, targetSprint: newIterationPath, results });
    },
});

app.http('project-admin-set-state', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'projects/{id}/admin/set-state',
    handler: async (request) => {
        if (request.method === 'OPTIONS') return jsonResponse({}, 204);
        const projectId = request.params.id;
        const adminCheck = await checkProjectAdminHeader(request, projectId);
        if (!adminCheck.ok) return jsonResponse(adminCheck.body, adminCheck.status);
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.ids) || body.ids.length === 0 || typeof body.state !== 'string') {
            return jsonResponse({ error: 'Body must be { ids: number[], state: string }' }, 400);
        }
        const ctx = await loadProjectContext(projectId);
        if (!ctx.ok) return jsonResponse(ctx.body, ctx.status);
        const results = await runInBatches(body.ids, 8, async id => {
            try {
                const data = await patchWorkItem(ctx.cfg, id, [
                    { op: 'add', path: '/fields/System.State', value: body.state },
                ]);
                return { id, ok: true, newState: data.fields?.['System.State'] };
            } catch (err) {
                return { id, ok: false, error: err.message };
            }
        });
        bustProjectCaches(projectId);
        const ok = results.filter(r => r.ok).length;
        return jsonResponse({ ok, failed: results.length - ok, total: results.length, state: body.state, results });
    },
});

app.http('project-admin-create-items', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'projects/{id}/admin/create-items',
    handler: async (request) => {
        if (request.method === 'OPTIONS') return jsonResponse({}, 204);
        const projectId = request.params.id;
        const adminCheck = await checkProjectAdminHeader(request, projectId);
        if (!adminCheck.ok) return jsonResponse(adminCheck.body, adminCheck.status);
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.items) || body.items.length === 0) {
            return jsonResponse({ error: 'Body must be { items: [...] }' }, 400);
        }
        const ctx = await loadProjectContext(projectId);
        if (!ctx.ok) return jsonResponse(ctx.body, ctx.status);
        const results = await runInBatches(body.items, 6, async item => {
            try {
                const workItemType = item.workItemType || 'Task';
                const iterationPath = item.sprint !== undefined
                    ? `${ctx.cfg.adoProject}\\Sprint ${item.sprint}`
                    : ctx.cfg.adoProject;
                const createOps = [
                    { op: 'add', path: '/fields/System.Title', value: item.title },
                    { op: 'add', path: '/fields/System.IterationPath', value: iterationPath },
                    // bypassRules=true covers required-field rules like Completed Work
                    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: 0 },
                    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: 0 },
                ];
                if (item.assignedTo) createOps.push({ op: 'add', path: '/fields/System.AssignedTo', value: item.assignedTo });
                if (item.tags)       createOps.push({ op: 'add', path: '/fields/System.Tags', value: item.tags });
                if (item.description) createOps.push({ op: 'add', path: '/fields/System.Description', value: item.description });
                const created = await createWorkItem(ctx.cfg, workItemType, createOps, { bypassRules: true });
                if (item.state && item.state !== created.fields?.['System.State']) {
                    await patchWorkItem(ctx.cfg, created.id, [
                        { op: 'add', path: '/fields/System.State', value: item.state },
                    ]).catch(() => {});
                }
                return { ok: true, id: created.id, title: item.title.slice(0, 60) };
            } catch (err) {
                return { ok: false, error: err.message, title: (item.title || '').slice(0, 60) };
            }
        });
        bustProjectCaches(projectId);
        const ok = results.filter(r => r.ok).length;
        return jsonResponse({ ok, failed: results.length - ok, total: results.length, results });
    },
});
