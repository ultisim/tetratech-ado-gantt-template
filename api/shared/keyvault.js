// Key Vault client — stores per-project PATs and admin secrets.
//
// Secret naming:
//   ado-pat-{projectId}        the ADO PAT for reading + writing work items
//   admin-secret-{projectId}   optional; if set, gates that project's admin API
//
// Auth: Managed Identity on the Static Web App. The Bicep template grants the
// SWA's system-assigned identity the "Key Vault Secrets Officer" role on the
// vault, which allows get + set + delete on secrets.

import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';
import { getEnv } from './config.js';

let cachedClient = null;

function getClient() {
    if (cachedClient) return cachedClient;
    const env = getEnv();
    cachedClient = new SecretClient(env.keyVaultUri, new DefaultAzureCredential());
    return cachedClient;
}

/** Read a secret by name. Returns the string value, or null if not found. */
export async function getSecret(name) {
    const client = getClient();
    try {
        const secret = await client.getSecret(name);
        return secret.value ?? null;
    } catch (err) {
        if (err.statusCode === 404 || err.code === 'SecretNotFound') return null;
        throw err;
    }
}

/** Set (create or update) a secret. */
export async function setSecret(name, value) {
    const client = getClient();
    await client.setSecret(name, value);
}

/**
 * Soft-delete a secret. Key Vault has a mandatory retention period after
 * delete; this schedules the deletion but the secret name stays reserved
 * for the retention window. That's fine for us — if the same project id
 * is re-added, we just setSecret with the new value.
 */
export async function deleteSecret(name) {
    const client = getClient();
    try {
        await client.beginDeleteSecret(name);
        return true;
    } catch (err) {
        if (err.statusCode === 404) return false;
        throw err;
    }
}

// ---- Convenience wrappers keyed by project id ----

export function patSecretName(projectId) {
    return `ado-pat-${projectId}`;
}

export function adminSecretName(projectId) {
    return `admin-secret-${projectId}`;
}

export async function getPat(projectId) {
    return getSecret(patSecretName(projectId));
}

export async function setPat(projectId, pat) {
    return setSecret(patSecretName(projectId), pat);
}

export async function getAdminSecret(projectId) {
    return getSecret(adminSecretName(projectId));
}

export async function setAdminSecret(projectId, secret) {
    return setSecret(adminSecretName(projectId), secret);
}

/** Delete just the admin secret (leaves PAT alone). Used to disable admin API. */
export async function deleteAdminSecret(projectId) {
    return deleteSecret(adminSecretName(projectId));
}

/** Delete both project secrets. Called during project deletion cleanup. */
export async function deleteProjectSecrets(projectId) {
    await Promise.all([
        deleteSecret(patSecretName(projectId)).catch(() => {}),
        deleteSecret(adminSecretName(projectId)).catch(() => {}),
    ]);
}
