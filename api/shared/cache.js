// Simple in-memory cache. Azure Functions Consumption plan cold-starts frequently,
// so this is a "warm request" optimization only. If you outgrow it, swap in
// Azure Cache for Redis. For 300s TTL and ~1 req/user/5min, in-memory is fine.

const store = new Map(); // key -> { value, expiresAt }

export function cacheGet(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
        store.delete(key);
        return null;
    }
    return { value: entry.value, ageSeconds: Math.floor((Date.now() - entry.storedAt) / 1000) };
}

export function cacheSet(key, value, ttlSeconds) {
    const now = Date.now();
    store.set(key, { value, storedAt: now, expiresAt: now + ttlSeconds * 1000 });
}

export function cacheDelete(key) {
    store.delete(key);
}

export function cacheClear() {
    store.clear();
}
