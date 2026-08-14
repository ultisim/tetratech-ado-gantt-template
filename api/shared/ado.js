// ADO REST client — WIQL queries and Work Items batch fetch.
// All calls use PAT via Basic auth (base64 of ":<pat>").

export async function wiqlQueryIds(cfg, query) {
    const resp = await fetch(`${cfg.projectUrl}/_apis/wit/wiql?api-version=7.1`, {
        method: 'POST',
        headers: {
            'Authorization': cfg.authHeader,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({ query }),
    });
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`WIQL query failed (${resp.status}): ${body.slice(0, 300)}`);
    }
    const data = await resp.json();
    return (data.workItems || []).map(w => w.id);
}

export async function wiqlWorkItemLinks(cfg, query) {
    const resp = await fetch(`${cfg.projectUrl}/_apis/wit/wiql?api-version=7.1`, {
        method: 'POST',
        headers: {
            'Authorization': cfg.authHeader,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({ query }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.workItemRelations || [];
}

/** Fetch up to 200 items per batch. Returns array of work item objects. */
export async function batchFetchWorkItems(cfg, ids, fields) {
    if (ids.length === 0) return [];
    const CHUNK = 200;
    const chunks = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    const results = await Promise.all(chunks.map(async chunk => {
        const resp = await fetch(`${cfg.orgUrl}/_apis/wit/workitemsbatch?api-version=7.1`, {
            method: 'POST',
            headers: {
                'Authorization': cfg.authHeader,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({ ids: chunk, fields }),
        });
        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Work item batch fetch failed (${resp.status}): ${body.slice(0, 300)}`);
        }
        const data = await resp.json();
        return data.value || [];
    }));
    return results.flat();
}

/** Fetch iteration definitions for the default team. Returns { path -> {start, end} }. */
export async function fetchIterationMap(cfg) {
    try {
        const resp = await fetch(`${cfg.projectUrl}/_apis/work/teamsettings/iterations?api-version=7.1`, {
            headers: { 'Authorization': cfg.authHeader, 'Accept': 'application/json' },
        });
        if (!resp.ok) return {};
        const data = await resp.json();
        const map = {};
        for (const it of (data.value || [])) {
            if (it.path && it.attributes) {
                map[it.path] = {
                    start: it.attributes.startDate || null,
                    end: it.attributes.finishDate || null,
                };
            }
        }
        return map;
    } catch { return {}; }
}

/** Fetch the parent-child relation map via WIQL WorkItemLinks. */
export async function fetchParentMap(cfg) {
    const relations = await wiqlWorkItemLinks(cfg, `
        SELECT [System.Id]
        FROM WorkItemLinks
        WHERE ([Source].[System.TeamProject] = '${cfg.adoProject.replace(/'/g, "''")}')
          AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward')
        MODE (Recursive)
    `);
    const map = {};
    for (const rel of relations) {
        if (rel.rel === 'System.LinkTypes.Hierarchy-Forward' && rel.source && rel.target) {
            map[rel.target.id] = rel.source.id;
        }
    }
    return map;
}

/** Fetch dependency links (Predecessor/Successor). */
export async function fetchDependencyLinks(cfg) {
    const relations = await wiqlWorkItemLinks(cfg, `
        SELECT [System.Id]
        FROM WorkItemLinks
        WHERE ([Source].[System.TeamProject] = '${cfg.adoProject.replace(/'/g, "''")}')
          AND ([System.Links.LinkType] = 'System.LinkTypes.Dependency-Forward')
        MODE (MustContain)
    `);
    return relations
        .filter(r => r.rel === 'System.LinkTypes.Dependency-Forward' && r.source && r.target)
        .map(r => ({ from: r.source.id, to: r.target.id }));
}

/** PATCH a single work item's fields. */
export async function patchWorkItem(cfg, id, ops, { bypassRules = false } = {}) {
    const url = `${cfg.orgUrl}/_apis/wit/workitems/${id}?api-version=7.1${bypassRules ? '&bypassRules=true' : ''}`;
    const resp = await fetch(url, {
        method: 'PATCH',
        headers: {
            'Authorization': cfg.authHeader,
            'Content-Type': 'application/json-patch+json',
            'Accept': 'application/json',
        },
        body: JSON.stringify(ops),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`PATCH failed (${resp.status}): ${text.slice(0, 300)}`);
    }
    return await resp.json();
}

/** Create a new work item of a given type. */
export async function createWorkItem(cfg, workItemType, ops, { bypassRules = true } = {}) {
    const url = `${cfg.projectUrl}/_apis/wit/workitems/$${encodeURIComponent(workItemType)}?api-version=7.1${bypassRules ? '&bypassRules=true' : ''}`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': cfg.authHeader,
            'Content-Type': 'application/json-patch+json',
            'Accept': 'application/json',
        },
        body: JSON.stringify(ops),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Create failed (${resp.status}): ${text.slice(0, 300)}`);
    }
    return await resp.json();
}
