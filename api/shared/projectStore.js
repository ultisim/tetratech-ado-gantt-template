// Azure Table Storage CRUD for project configs.
//
// Table shape (single table, single partition):
//   PartitionKey: 'project'   (fixed — single-tenant install, one PM's dashboard)
//   RowKey:       <projectId> (kebab-case slug, url-safe)
//   Fields:
//     displayName:            human label, shown in dropdown + header
//     adoOrg:                 e.g. "TetraTech"
//     adoProject:             e.g. "Force Account Automation" (case sensitive)
//     patSecretName:          "ado-pat-<projectId>" (Key Vault secret name)
//     adminSecretName:        "admin-secret-<projectId>" or empty
//     createdBy:              principal.name of the admin who added it
//     createdAt:              ISO timestamp
//     updatedAt:              ISO timestamp
//
// The PartitionKey is fixed because each SWA install serves one PM/team.
// If you ever multi-tenant this, change PartitionKey to the tenant id.

import { TableClient } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';
import { getEnv } from './config.js';

const PARTITION_KEY = 'project';

let cachedClient = null;

function getClient() {
    if (cachedClient) return cachedClient;
    const env = getEnv();
    const url = `https://${env.storageAccountName}.table.core.windows.net`;
    cachedClient = new TableClient(url, env.projectsTableName, new DefaultAzureCredential());
    return cachedClient;
}

/** Ensure the table exists. Idempotent — safe to call every request. */
export async function ensureTable() {
    const client = getClient();
    try {
        await client.createTable();
    } catch (err) {
        // TableAlreadyExists is expected on all calls after the first
        if (err.statusCode !== 409) throw err;
    }
}

/** List every project. Sorted by displayName. */
export async function listProjects() {
    await ensureTable();
    const client = getClient();
    const results = [];
    const filter = `PartitionKey eq '${PARTITION_KEY}'`;
    for await (const entity of client.listEntities({ queryOptions: { filter } })) {
        results.push(entityToProject(entity));
    }
    results.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return results;
}

/** Get a single project by id, or null if not found. */
export async function getProject(id) {
    if (!id) return null;
    const client = getClient();
    try {
        const entity = await client.getEntity(PARTITION_KEY, id);
        return entityToProject(entity);
    } catch (err) {
        if (err.statusCode === 404) return null;
        throw err;
    }
}

/**
 * Create or update a project. Returns the resulting project record.
 * `data` must include: id, displayName, adoOrg, adoProject.
 * Optionally: adminSecretName (if the admin secret is set).
 */
export async function upsertProject(data, principal) {
    if (!data.id || !/^[a-z0-9-]+$/.test(data.id)) {
        throw new Error('Project id must be kebab-case (a-z, 0-9, hyphens only)');
    }
    if (!data.adoOrg || !data.adoProject) {
        throw new Error('adoOrg and adoProject are required');
    }
    await ensureTable();
    const client = getClient();
    const existing = await getProject(data.id);
    const nowIso = new Date().toISOString();
    const entity = {
        partitionKey: PARTITION_KEY,
        rowKey: data.id,
        displayName: data.displayName || data.adoProject,
        adoOrg: data.adoOrg,
        adoProject: data.adoProject,
        patSecretName: `ado-pat-${data.id}`,
        adminSecretName: data.hasAdminSecret ? `admin-secret-${data.id}` : '',
        createdBy: existing?.createdBy || principal?.name || 'system',
        createdAt: existing?.createdAt || nowIso,
        updatedAt: nowIso,
    };
    await client.upsertEntity(entity, 'Replace');
    return entityToProject(entity);
}

/** Delete a project record. Does NOT touch Key Vault — caller handles secret cleanup. */
export async function deleteProject(id) {
    const client = getClient();
    try {
        await client.deleteEntity(PARTITION_KEY, id);
        return true;
    } catch (err) {
        if (err.statusCode === 404) return false;
        throw err;
    }
}

function entityToProject(entity) {
    return {
        id: entity.rowKey,
        displayName: entity.displayName,
        adoOrg: entity.adoOrg,
        adoProject: entity.adoProject,
        patSecretName: entity.patSecretName || `ado-pat-${entity.rowKey}`,
        adminSecretName: entity.adminSecretName || null,
        hasAdminSecret: !!entity.adminSecretName,
        createdBy: entity.createdBy,
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
    };
}
