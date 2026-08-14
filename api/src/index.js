// Azure Functions v4 Node programming model.
// Each function registers here with a route pattern.

import { app } from '@azure/functions';
import { getConfig, checkAdminAuth, jsonResponse } from '../shared/config.js';
import { cacheGet, cacheSet, cacheDelete } from '../shared/cache.js';
import { fetchAllTasks } from '../shared/pipeline.js';
import {
    wiqlQueryIds, batchFetchWorkItems, patchWorkItem, createWorkItem,
} from '../shared/ado.js';
import { isCompletedState } from '../shared/mapping.js';

// ---- GET /api/health ----
app.http('health', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'health',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') return jsonResponse({}, 204);
        try {
            const cfg = getConfig();
            const cached = cacheGet(`tasks:${cfg.adoProject}`);
            return jsonResponse({
                ok: true,
                org: cfg.adoOrg,
                project: cfg.adoProject,
                cached: !!cached,
                cache_age_s: cached ? cached.ageSeconds : null,
                admin_endpoints: !!cfg.adminSecret,
            });
        } catch (err) {
            return jsonResponse({ ok: false, error: err.message }, 500);
        }
    },
});

// ---- GET /api/tasks ----
app.http('tasks', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'tasks',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') return jsonResponse({}, 204);
        try {
            const cfg = getConfig();
            const url = new URL(request.url);
            const force = url.searchParams.get('refresh') === '1';
            const cacheKey = `tasks:${cfg.adoProject}`;
            if (!force) {
                const cached = cacheGet(cacheKey);
                if (cached) return jsonResponse(cached.value, 200, {
                    'X-Cache': 'HIT',
                    'X-Cache-Age': String(cached.ageSeconds),
                });
            }
            const tasks = await fetchAllTasks(cfg);
            cacheSet(cacheKey, tasks, cfg.cacheTtlSeconds);
            return jsonResponse(tasks, 200, { 'X-Cache': 'MISS' });
        } catch (err) {
            context.error('tasks endpoint failed', err);
            return jsonResponse({ error: err.message }, 500);
        }
    },
});

// ---- GET /api/sprint/{num} ----
app.http('sprint', {
    methods: ['GET', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'sprint/{num}',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') return jsonResponse({}, 204);
        try {
            const cfg = getConfig();
            const num = request.params.num;
            const url = new URL(request.url);
            const force = url.searchParams.get('refresh') === '1';
            const cacheKey = `sprint:${num}`;
            if (!force) {
                const cached = cacheGet(cacheKey);
                if (cached) return jsonResponse(cached.value, 200, {
                    'X-Cache': 'HIT', 'X-Cache-Age': String(cached.ageSeconds),
                });
            }
            const data = await fetchSprintChecklist(cfg, num);
            cacheSet(cacheKey, data, cfg.cacheTtlSeconds);
            return jsonResponse(data, 200, { 'X-Cache': 'MISS' });
        } catch (err) {
            context.error('sprint endpoint failed', err);
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
// Admin endpoints — disabled unless ADMIN_SECRET env var is set.
// Callers must send `X-Admin-Secret: <value>` header.
// See docs/RUNBOOK.md for one-time migration patterns.
// ---------------------------------------------------------------------------

// ---- POST /api/admin/move-iteration ----
app.http('admin-move-iteration', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'admin/move-iteration',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') return jsonResponse({}, 204);
        const cfg = getConfig();
        const auth = checkAdminAuth(request, cfg);
        if (!auth.ok) return jsonResponse(auth.body, auth.status);

        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.ids) || body.ids.length === 0 || typeof body.sprint !== 'number') {
            return jsonResponse({ error: 'Body must be { ids: number[], sprint: number }' }, 400);
        }
        const newIterationPath = `${cfg.adoProject}\\Sprint ${body.sprint}`;
        const results = await runInBatches(body.ids, 8, async id => {
            try {
                const data = await patchWorkItem(cfg, id, [
                    { op: 'add', path: '/fields/System.IterationPath', value: newIterationPath },
                ]);
                return { id, ok: true, newIteration: data.fields?.['System.IterationPath'] };
            } catch (err) {
                return { id, ok: false, error: err.message };
            }
        });
        bustAllCaches(cfg);
        const ok = results.filter(r => r.ok).length;
        return jsonResponse({ ok, failed: results.length - ok, total: results.length, targetSprint: newIterationPath, results });
    },
});

// ---- POST /api/admin/set-state ----
app.http('admin-set-state', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'admin/set-state',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') return jsonResponse({}, 204);
        const cfg = getConfig();
        const auth = checkAdminAuth(request, cfg);
        if (!auth.ok) return jsonResponse(auth.body, auth.status);

        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.ids) || body.ids.length === 0 || typeof body.state !== 'string') {
            return jsonResponse({ error: 'Body must be { ids: number[], state: string }' }, 400);
        }
        const results = await runInBatches(body.ids, 8, async id => {
            try {
                const data = await patchWorkItem(cfg, id, [
                    { op: 'add', path: '/fields/System.State', value: body.state },
                ]);
                return { id, ok: true, newState: data.fields?.['System.State'] };
            } catch (err) {
                return { id, ok: false, error: err.message };
            }
        });
        bustAllCaches(cfg);
        const ok = results.filter(r => r.ok).length;
        return jsonResponse({ ok, failed: results.length - ok, total: results.length, state: body.state, results });
    },
});

// ---- POST /api/admin/create-items ----
app.http('admin-create-items', {
    methods: ['POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'admin/create-items',
    handler: async (request, context) => {
        if (request.method === 'OPTIONS') return jsonResponse({}, 204);
        const cfg = getConfig();
        const auth = checkAdminAuth(request, cfg);
        if (!auth.ok) return jsonResponse(auth.body, auth.status);

        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.items) || body.items.length === 0) {
            return jsonResponse({ error: 'Body must be { items: [...] }' }, 400);
        }
        const results = await runInBatches(body.items, 6, async item => {
            try {
                const workItemType = item.workItemType || 'Task';
                const iterationPath = item.sprint !== undefined
                    ? `${cfg.adoProject}\\Sprint ${item.sprint}`
                    : cfg.adoProject;
                const createOps = [
                    { op: 'add', path: '/fields/System.Title', value: item.title },
                    { op: 'add', path: '/fields/System.IterationPath', value: iterationPath },
                    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: 0 },
                    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: 0 },
                ];
                if (item.assignedTo) createOps.push({ op: 'add', path: '/fields/System.AssignedTo', value: item.assignedTo });
                if (item.tags)       createOps.push({ op: 'add', path: '/fields/System.Tags', value: item.tags });
                if (item.description) createOps.push({ op: 'add', path: '/fields/System.Description', value: item.description });
                const created = await createWorkItem(cfg, workItemType, createOps, { bypassRules: true });
                if (item.state && item.state !== created.fields?.['System.State']) {
                    await patchWorkItem(cfg, created.id, [
                        { op: 'add', path: '/fields/System.State', value: item.state },
                    ]).catch(err => { /* non-fatal, item is created */ });
                }
                return { ok: true, id: created.id, title: item.title.slice(0, 60) };
            } catch (err) {
                return { ok: false, error: err.message, title: (item.title || '').slice(0, 60) };
            }
        });
        bustAllCaches(cfg);
        const ok = results.filter(r => r.ok).length;
        return jsonResponse({ ok, failed: results.length - ok, total: results.length, results });
    },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runInBatches(items, concurrency, fn) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(fn));
        results.push(...batchResults);
    }
    return results;
}

function bustAllCaches(cfg) {
    cacheDelete(`tasks:${cfg.adoProject}`);
    for (let s = 0; s <= 20; s++) cacheDelete(`sprint:${s}`);
}
