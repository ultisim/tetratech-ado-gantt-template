// Central config resolved from Function App environment variables.
// Locally, values come from api/local.settings.json.
// In Azure, values come from the Static Web App application settings
// (which are surfaced as env vars to the Managed Functions).

export function getConfig() {
    const cfg = {
        adoOrg: process.env.ADO_ORG,
        adoProject: process.env.ADO_PROJECT,
        adoPat: process.env.ADO_PAT,
        cacheTtlSeconds: parseInt(process.env.CACHE_TTL_S || '300', 10),
        adminSecret: process.env.ADMIN_SECRET || null,
    };
    if (!cfg.adoOrg || !cfg.adoProject) {
        throw new Error('ADO_ORG and ADO_PROJECT must be set');
    }
    if (!cfg.adoPat) {
        throw new Error('ADO_PAT must be set (create at https://dev.azure.com/<org>/_usersSettings/tokens)');
    }
    cfg.orgUrl = `https://dev.azure.com/${encodeURIComponent(cfg.adoOrg)}`;
    cfg.projectUrl = `${cfg.orgUrl}/${encodeURIComponent(cfg.adoProject)}`;
    cfg.authHeader = 'Basic ' + Buffer.from(':' + cfg.adoPat).toString('base64');
    return cfg;
}

/** Check X-Admin-Secret header against ADMIN_SECRET env var. Returns 404 if secret unset. */
export function checkAdminAuth(request, cfg) {
    if (!cfg.adminSecret) {
        return { ok: false, status: 404, body: { error: 'Not found' } };
    }
    const provided = request.headers.get('x-admin-secret');
    if (!provided || provided !== cfg.adminSecret) {
        return { ok: false, status: 401, body: { error: 'Invalid or missing X-Admin-Secret header' } };
    }
    return { ok: true };
}

/** Standard JSON response with permissive CORS + no-store cache. */
export function jsonResponse(body, status = 200, extraHeaders = {}) {
    return {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
            ...extraHeaders,
        },
        jsonBody: body,
    };
}
