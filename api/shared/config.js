// Runtime config.
//
// In the multi-project model, per-project config (ADO org / project name / PAT)
// lives in Azure Table Storage + Key Vault — NOT in env vars. Env vars only
// carry infra locators (which Key Vault, which Storage account) and the auth
// tenant restriction.
//
// Per-request flow:
//   1. Handler receives a projectId from the route
//   2. projectStore.get(projectId) reads the project row from Table Storage
//   3. keyvault.getPat(projectId) reads the PAT
//   4. buildProjectContext() bundles it into what the ADO client needs
//
// Locally, env vars come from api/local.settings.json.
// In Azure, they come from the Static Web App's application settings.

const REQUIRED_ENV = ['KEYVAULT_URI', 'STORAGE_ACCOUNT_NAME'];

let cachedEnv = null;

/** Read the infra locators from env. Throws with a helpful message if missing. */
export function getEnv() {
    if (cachedEnv) return cachedEnv;
    const env = {
        keyVaultUri: process.env.KEYVAULT_URI,
        storageAccountName: process.env.STORAGE_ACCOUNT_NAME,
        projectsTableName: process.env.PROJECTS_TABLE_NAME || 'projects',
        cacheTtlSeconds: parseInt(process.env.CACHE_TTL_S || '300', 10),
        // Optional Entra tenant restriction. If unset, any Microsoft account works.
        // When set, only accounts in this tenant can sign in — see staticwebapp.config.json.
        allowedTenantId: process.env.ALLOWED_TENANT_ID || null,
    };
    const missing = REQUIRED_ENV.filter(k => !env[camelize(k)]);
    if (missing.length > 0) {
        throw new Error(
            `Missing required env vars: ${missing.join(', ')}. ` +
            `These are set automatically by the Bicep template during install. ` +
            `Locally, populate api/local.settings.json.`
        );
    }
    cachedEnv = env;
    return env;
}

function camelize(SNAKE_CASE) {
    return SNAKE_CASE.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Build the per-request context passed to the ADO client, from a project record.
 * `project` is the row read from Table Storage.
 * `pat` is the PAT string read from Key Vault.
 */
export function buildProjectContext(project, pat) {
    if (!project) throw new Error('project record required');
    if (!pat) throw new Error('PAT required (check Key Vault access)');
    const orgUrl = `https://dev.azure.com/${encodeURIComponent(project.adoOrg)}`;
    return {
        projectId: project.id,
        adoOrg: project.adoOrg,
        adoProject: project.adoProject,
        displayName: project.displayName || project.adoProject,
        orgUrl,
        projectUrl: `${orgUrl}/${encodeURIComponent(project.adoProject)}`,
        authHeader: 'Basic ' + Buffer.from(':' + pat).toString('base64'),
    };
}

// ---------------------------------------------------------------------------
// Auth helpers — SWA Entra ID
// ---------------------------------------------------------------------------

/**
 * Parse the SWA-provided principal header. Returns null for anonymous.
 *
 * When SWA authenticates a user, it forwards the identity as a base64-encoded
 * JSON blob in `x-ms-client-principal`. Managed Functions receive this on
 * every request. If missing, the caller is anonymous.
 */
export function getPrincipal(request) {
    const header = request.headers.get('x-ms-client-principal');
    if (!header) return null;
    try {
        const decoded = Buffer.from(header, 'base64').toString('utf8');
        const p = JSON.parse(decoded);
        return {
            id: p.userId,
            name: p.userDetails,
            provider: p.identityProvider,
            roles: p.userRoles || [],
            claims: p.claims || [],
        };
    } catch {
        return null;
    }
}

/**
 * Guard: require an authenticated user. Returns { ok: true } or an error response object.
 * SWA typically catches this at the platform level via staticwebapp.config.json,
 * but we double-check inside the Function for defense in depth (and for the
 * case where the caller uses `authenticated` role vs `anonymous`).
 */
export function requireAuthenticated(request) {
    const p = getPrincipal(request);
    if (!p) {
        return { ok: false, status: 401, body: { error: 'Authentication required' } };
    }
    return { ok: true, principal: p };
}

/** Guard: require the `admin` role. */
export function requireAdmin(request) {
    const p = getPrincipal(request);
    if (!p) {
        return { ok: false, status: 401, body: { error: 'Authentication required' } };
    }
    if (!(p.roles || []).includes('admin')) {
        return { ok: false, status: 403, body: { error: 'Admin role required' } };
    }
    return { ok: true, principal: p };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/**
 * Standard JSON response. `no-store` on the JSON so browsers never serve
 * a stale API response — the in-Function cache handles freshness policy.
 */
export function jsonResponse(body, status = 200, extraHeaders = {}) {
    return {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...extraHeaders,
        },
        jsonBody: body,
    };
}
