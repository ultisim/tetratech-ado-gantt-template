// End-to-end task fetch: WIQL → batch → map → roll up → critical path → strip internals.

import {
    wiqlQueryIds, batchFetchWorkItems, fetchIterationMap, fetchParentMap,
    fetchDependencyLinks,
} from './ado.js';
import {
    WIQL_WORK_ITEM_TYPES, FIELDS, mapWorkItem, rollUpDates, rollUpStatus,
    computeCriticalPath, annotateCriticalPath,
} from './mapping.js';

export async function fetchAllTasks(cfg) {
    // 1. WIQL for all IDs
    const typesList = WIQL_WORK_ITEM_TYPES.map(t => `'${t}'`).join(', ');
    const ids = await wiqlQueryIds(cfg, `
        SELECT [System.Id] FROM WorkItems
        WHERE [System.TeamProject] = '${cfg.adoProject.replace(/'/g, "''")}'
          AND [System.WorkItemType] IN (${typesList})
          AND [System.State] <> 'Removed'
        ORDER BY [System.Id]
    `);
    if (ids.length === 0) return [];

    // 2. Batch fetch with the fields we care about
    const items = await batchFetchWorkItems(cfg, ids, FIELDS);

    // 3. Iteration map (for date fallback) and parent map (for hierarchy)
    const [iterationMap, parentMap] = await Promise.all([
        fetchIterationMap(cfg),
        fetchParentMap(cfg),
    ]);

    // 4. Map each to task shape
    const tasks = items.map(wi => mapWorkItem(wi, iterationMap, parentMap, cfg));

    // 5. Roll up dates (2 passes cover Epic → Feature → PBI)
    rollUpDates(tasks);
    rollUpDates(tasks);

    // 6. Critical path from dependency links
    const deps = await fetchDependencyLinks(cfg);
    const { criticalIds, allDeps } = computeCriticalPath(deps, tasks);
    annotateCriticalPath(tasks, criticalIds, allDeps);

    // 7. Roll up status (Done/In Progress from children)
    rollUpStatus(tasks);

    // Strip internal fields before returning
    for (const t of tasks) delete t._dateSource;
    return tasks;
}
