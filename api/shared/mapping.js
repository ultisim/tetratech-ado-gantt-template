// Data shape and derivation logic.
// Mirrors the Cloudflare Worker version so the frontend stays identical.

export const WIQL_WORK_ITEM_TYPES = [
    // Agile
    'Epic', 'Feature', 'User Story', 'Task', 'Bug',
    // Scrum
    'Product Backlog Item',
    // Basic
    'Issue',
];

export const FIELDS = [
    'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
    'System.AssignedTo', 'System.Parent', 'System.Tags', 'System.IterationPath',
    'System.Description', 'System.CreatedDate',
    'Microsoft.VSTS.Scheduling.StartDate',
    'Microsoft.VSTS.Scheduling.TargetDate',
    'Microsoft.VSTS.Scheduling.FinishDate',
    'Microsoft.VSTS.Scheduling.CompletedWork',
    'Microsoft.VSTS.Scheduling.RemainingWork',
    'Microsoft.VSTS.Common.Priority',
];

const LEVEL_MAP = {
    'Epic': 0, 'Feature': 1,
    'User Story': 2, 'Product Backlog Item': 2, 'Issue': 2,
    'Task': 3, 'Bug': 3,
};

const STATE_MAP = {
    'Done': 'completed', 'Closed': 'completed', 'Resolved': 'completed', 'Completed': 'completed',
    'Active': 'in_progress', 'Committed': 'in_progress', 'In Progress': 'in_progress', 'Doing': 'in_progress',
    'Blocked': 'blocked',
    'New': 'pending', 'To Do': 'pending', 'Proposed': 'pending', 'Approved': 'pending',
};

/** Extract sprint number from iteration path like "Project\Sprint 4". */
export function extractSprintNumber(iterPath) {
    if (!iterPath) return null;
    const m = iterPath.match(/Sprint\s+(\d+)/i);
    return m ? parseInt(m[1], 10) : null;
}

/** Custom state names may include "Done - Waiting Client Feedback" etc. */
export function inferStatusFromName(state) {
    if (!state) return 'pending';
    const s = state.toLowerCase();
    if (/done|complet|closed|resolved|shipped|deployed/.test(s)) return 'completed';
    if (/progress|review|active|doing|wip|committed/.test(s)) return 'in_progress';
    if (/block|halt|stuck|wait.*on/.test(s)) return 'blocked';
    return 'pending';
}

export function isCompletedState(state) {
    if (!state) return false;
    if (['Done', 'Closed', 'Resolved', 'Completed'].includes(state)) return true;
    return /^done\b|complete|^closed\b|resolved|shipped|deployed/i.test(state);
}

/** Detect code-review tasks by title keyword. */
export function detectCodeReview(fields) {
    const title = (fields['System.Title'] || '').toLowerCase();
    if (/code\s*review/i.test(title)) return 1;
    return 0;
}

/** Resolve dates: explicit → iteration → created+14d. Returns { start, end, dateSource }. */
export function resolveDates(f, iterationMap) {
    const explicitStart = f['Microsoft.VSTS.Scheduling.StartDate'];
    const explicitEnd = f['Microsoft.VSTS.Scheduling.TargetDate']
                     || f['Microsoft.VSTS.Scheduling.FinishDate'];
    let start = explicitStart || null;
    let end = explicitEnd || null;
    let dateSource = 'explicit';
    if ((!start || !end) && f['System.IterationPath']) {
        const it = iterationMap[f['System.IterationPath']];
        if (it) {
            if (!start && it.start) { start = it.start; dateSource = 'iteration'; }
            if (!end && it.end)     { end = it.end;     dateSource = 'iteration'; }
        }
    }
    let isFallback = false;
    if (!start && f['System.CreatedDate']) { start = f['System.CreatedDate']; isFallback = true; }
    if (!end && start) {
        const d = new Date(start);
        d.setDate(d.getDate() + 14);
        end = d.toISOString();
        isFallback = true;
    }
    return {
        start: start ? toIsoDate(start) : null,
        end: end ? toIsoDate(end) : null,
        dateSource: isFallback ? 'fallback' : dateSource,
    };
}

function toIsoDate(v) {
    const d = new Date(v);
    if (isNaN(d)) return null;
    return d.toISOString().split('T')[0];
}

function stripHtml(html) {
    return String(html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ').trim();
}

function computePct(f, status) {
    if (status === 'completed') return 100;
    const completed = Number(f['Microsoft.VSTS.Scheduling.CompletedWork'] || 0);
    const remaining = Number(f['Microsoft.VSTS.Scheduling.RemainingWork'] || 0);
    const total = completed + remaining;
    if (total > 0) return Math.round((completed / total) * 100);
    if (status === 'in_progress') return 50;
    return 0;
}

export function mapWorkItem(wi, iterationMap, parentMap, cfg) {
    const f = wi.fields || {};
    const type = f['System.WorkItemType'];
    const state = f['System.State'];
    const { start, end, dateSource } = resolveDates(f, iterationMap);
    const tags = (f['System.Tags'] || '').split(';').map(t => t.trim()).filter(Boolean);
    const status = state === 'Blocked' || tags.includes('Blocked')
        ? 'blocked'
        : (STATE_MAP[state] || inferStatusFromName(state));
    const pct = computePct(f, status);
    const parentId = f['System.Parent'] || parentMap[wi.id] || null;
    return {
        id: wi.id,
        parent_id: parentId,
        level: LEVEL_MAP[type] ?? 3,
        task_name: f['System.Title'] || `Work item ${wi.id}`,
        team: f['System.AssignedTo']?.displayName || 'Unassigned',
        assigned_to: f['System.AssignedTo']?.uniqueName || null,
        start_date: start,
        end_date: end,
        _dateSource: dateSource,
        task_category: type || 'Task',
        phase: type || 'Task',
        description: stripHtml(f['System.Description'] || ''),
        status,
        completion_percentage: pct,
        is_critical_path: tags.some(t => /critical[-_ ]?path/i.test(t)) ? 1 : 0,
        critical_path_threshold: null,
        iteration_path: f['System.IterationPath'] || null,
        sprint: extractSprintNumber(f['System.IterationPath']),
        is_code_review: detectCodeReview(f),
        tags,
        ado_url: `https://dev.azure.com/${encodeURIComponent(cfg.adoOrg)}/` +
                 `${encodeURIComponent(cfg.adoProject)}/_workitems/edit/${wi.id}`,
    };
}

/** Roll up dates for parents whose own dates fell back to created+14. */
export function rollUpDates(tasks) {
    const childrenOf = {};
    for (const t of tasks) {
        if (t.parent_id) (childrenOf[t.parent_id] ||= []).push(t);
    }
    for (const t of tasks) {
        const kids = childrenOf[t.id];
        if (!kids || kids.length === 0) continue;
        if (t._dateSource !== 'fallback') continue;
        const kidStarts = kids.map(k => k.start_date).filter(Boolean).sort();
        const kidEnds = kids.map(k => k.end_date).filter(Boolean).sort();
        if (kidStarts.length > 0 && kidEnds.length > 0) {
            t.start_date = kidStarts[0];
            t.end_date = kidEnds[kidEnds.length - 1];
            t._dateSource = 'rolled-up';
        }
    }
}

/** Roll up completion status: all-children-Done → parent Done; any-child-active → parent In Progress. */
export function rollUpStatus(tasks) {
    const childrenOf = {};
    for (const t of tasks) {
        if (t.parent_id) (childrenOf[t.parent_id] ||= []).push(t);
    }
    // Three passes for Epic → Feature → PBI → Task hierarchy
    for (let pass = 0; pass < 3; pass++) {
        for (const t of tasks) {
            const kids = childrenOf[t.id];
            if (!kids || kids.length === 0) continue;
            if (t.status === 'completed') continue;
            const allDone = kids.every(k => k.status === 'completed');
            const anyActive = kids.some(k => k.status === 'completed' || k.status === 'in_progress');
            if (allDone) {
                t.status = 'completed';
                t.completion_percentage = 100;
            } else if (anyActive) {
                if (t.status === 'pending') t.status = 'in_progress';
                const avgPct = Math.round(
                    kids.reduce((sum, k) => sum + (k.completion_percentage || 0), 0) / kids.length
                );
                t.completion_percentage = avgPct;
            }
        }
    }
}

/**
 * Compute the critical path from a list of dependency edges.
 * Longest path via topological sort + dynamic programming.
 * Returns { criticalIds: Set, allDeps: [{from, to}] }.
 */
export function computeCriticalPath(deps, tasks) {
    if (deps.length === 0) return { criticalIds: new Set(), allDeps: deps };
    const taskMap = {};
    for (const t of tasks) {
        let dur = 0;
        if (t.start_date && t.end_date) {
            dur = Math.ceil((new Date(t.end_date) - new Date(t.start_date)) / (1000 * 60 * 60 * 24));
        }
        taskMap[t.id] = dur;
    }
    const graph = {}, inDegree = {}, allNodes = new Set();
    for (const d of deps) {
        (graph[d.from] ||= []).push(d.to);
        inDegree[d.to] = (inDegree[d.to] || 0) + 1;
        allNodes.add(d.from);
        allNodes.add(d.to);
        if (!(d.from in inDegree)) inDegree[d.from] = 0;
    }
    const dist = {}, predecessor = {};
    for (const n of allNodes) {
        dist[n] = taskMap[n] || 0;
        predecessor[n] = null;
    }
    const queue = [...allNodes].filter(n => (inDegree[n] || 0) === 0);
    while (queue.length > 0) {
        const u = queue.shift();
        for (const v of (graph[u] || [])) {
            const newDist = dist[u] + (taskMap[v] || 0);
            if (newDist > dist[v]) { dist[v] = newDist; predecessor[v] = u; }
            inDegree[v]--;
            if (inDegree[v] === 0) queue.push(v);
        }
    }
    let endNode = null, maxDist = -1;
    for (const n of allNodes) {
        if (dist[n] > maxDist) { maxDist = dist[n]; endNode = n; }
    }
    const path = new Set();
    let cur = endNode;
    while (cur !== null) { path.add(cur); cur = predecessor[cur]; }
    return { criticalIds: path, allDeps: deps };
}

/** Attach depends_on and blocks arrays for critical path items. Propagate flag up to parents. */
export function annotateCriticalPath(tasks, criticalIds, allDeps) {
    const taskById = {};
    for (const t of tasks) taskById[t.id] = t;
    const predecessors = {}, successors = {};
    for (const d of allDeps) {
        (predecessors[d.to] ||= []).push(d.from);
        (successors[d.from] ||= []).push(d.to);
    }
    for (const t of tasks) {
        if (criticalIds.has(t.id)) {
            t.is_critical_path = 1;
            const preds = (predecessors[t.id] || [])
                .map(id => taskById[id] ? { id, name: taskById[id].task_name } : null)
                .filter(Boolean);
            const succs = (successors[t.id] || [])
                .map(id => taskById[id] ? { id, name: taskById[id].task_name } : null)
                .filter(Boolean);
            if (preds.length > 0) t.depends_on = preds;
            if (succs.length > 0) t.blocks = succs;
        }
    }
    // Propagate up to parents
    for (const t of tasks) {
        if (t.is_critical_path === 1 && t.parent_id) {
            let cur = t.parent_id;
            while (cur && taskById[cur]) {
                taskById[cur].is_critical_path = 1;
                cur = taskById[cur].parent_id;
            }
        }
    }
}
