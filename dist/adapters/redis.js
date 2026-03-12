/**
 * Redis cache adapter
 *
 * Cache layer for MCP tool responses. Uses ioredis.
 * Falls back to a no-op cache when Redis is unavailable.
 *
 * Keys:  mcp:<tool>:<hash(args)>
 * TTL:   Configurable per-tool, defaults to 60s
 */
import { createHash } from "crypto";
import { Redis as RedisClient } from "ioredis";
// ── TTL configuration per tool category ──────────────────────────────────────
const TOOL_TTLS = {
    // Status/health endpoints — refresh frequently
    unifi_network_status: 30,
    pve_cluster_status: 30,
    k8s_cluster_info: 30,
    k8s_list_nodes: 30,
    k8s_pod_problems: 30,
    ts_health: 60,
    sandfly_get_alerts: 60,
    // List endpoints — slightly longer cache
    k8s_list_pods: 45,
    k8s_list_deployments: 60,
    k8s_list_events: 30,
    k8s_list_argocd_apps: 60,
    k8s_list_longhorn_volumes: 120,
    k8s_list_pvcs: 120,
    k8s_list_ingress_routes: 120,
    pve_list_vms: 60,
    pve_list_storage: 120,
    pve_list_containers: 60,
    pve_list_nodes: 60,
    pve_list_tasks: 30,
    unifi_list_devices: 60,
    unifi_list_sites: 300,
    unifi_list_hosts: 60,
    ts_list_devices: 120,
    ts_get_dns: 300,
    ts_get_acl: 300,
    cf_list_zones: 300,
    cf_list_dns_records: 120,
    cf_zone_analytics: 60,
    sandfly_list_hosts: 120,
    sandfly_get_results: 60,
    // Git/CVE — longer cache, data changes less often
    git_repo_list: 300,
    git_pr_list: 60,
    git_commit_list: 60,
    cve_queue_stats: 120,
};
const DEFAULT_TTL = 60;
function getTtl(tool) {
    return TOOL_TTLS[tool] ?? DEFAULT_TTL;
}
// ── Cache key generation ─────────────────────────────────────────────────────
function cacheKey(tool, args) {
    const argsHash = createHash("sha256")
        .update(JSON.stringify(args, Object.keys(args).sort()))
        .digest("hex")
        .slice(0, 12);
    return `mcp:${tool}:${argsHash}`;
}
// ── Public API ───────────────────────────────────────────────────────────────
/** Create a Redis-backed MCP response cache */
export function createRedisCache(url) {
    const client = new RedisClient(url, {
        maxRetriesPerRequest: 1,
        retryStrategy(times) {
            if (times > 3)
                return null; // stop retrying
            return Math.min(times * 200, 2000);
        },
        lazyConnect: true,
    });
    // Suppress unhandled error events (ioredis emits on connection loss)
    client.on("error", () => { });
    let connected = false;
    return {
        async get(tool, args) {
            try {
                const raw = await client.get(cacheKey(tool, args));
                if (!raw)
                    return null;
                return JSON.parse(raw);
            }
            catch {
                return null;
            }
        },
        async set(tool, args, data, ttlSeconds) {
            try {
                const key = cacheKey(tool, args);
                const entry = { data, cachedAt: new Date().toISOString(), tool };
                const ttl = ttlSeconds ?? getTtl(tool);
                await client.set(key, JSON.stringify(entry), "EX", ttl);
            }
            catch {
                // Cache write failure is non-fatal
            }
        },
        async ping() {
            try {
                if (!connected) {
                    await client.connect();
                    connected = true;
                }
                const res = await client.ping();
                return res === "PONG";
            }
            catch {
                return false;
            }
        },
        async quit() {
            try {
                await client.quit();
            }
            catch { /* already closed */ }
        },
    };
}
/** Create a no-op cache (used when REDIS_URL is not configured) */
export function createNoopCache() {
    return {
        async get() { return null; },
        async set() { },
        async ping() { return false; },
        async quit() { },
    };
}
/** Singleton — one cache per process */
let _singleton = null;
/** Get or create the cache singleton based on REDIS_URL env var */
export function createCacheFromEnv() {
    if (_singleton)
        return _singleton;
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
        _singleton = Promise.resolve(createNoopCache());
        return _singleton;
    }
    _singleton = (async () => {
        try {
            const cache = createRedisCache(redisUrl);
            const ok = await cache.ping();
            if (!ok) {
                console.error("[redis] ping failed, falling back to no-op cache");
                return createNoopCache();
            }
            console.log("[redis] connected, MCP response caching enabled");
            return cache;
        }
        catch (err) {
            console.error(`[redis] connection failed: ${err}, falling back to no-op cache`);
            return createNoopCache();
        }
    })();
    return _singleton;
}
//# sourceMappingURL=redis.js.map