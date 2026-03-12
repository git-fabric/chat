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

// ── Types ────────────────────────────────────────────────────────────────────

export interface CacheEntry {
  data: unknown;
  cachedAt: string; // ISO-8601
  tool: string;
}

export interface RedisCache {
  get(tool: string, args: Record<string, unknown>): Promise<CacheEntry | null>;
  set(tool: string, args: Record<string, unknown>, data: unknown, ttlSeconds?: number): Promise<void>;
  ping(): Promise<boolean>;
  quit(): Promise<void>;
}

// ── TTL configuration per tool category ──────────────────────────────────────

const TOOL_TTLS: Record<string, number> = {
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

function getTtl(tool: string): number {
  return TOOL_TTLS[tool] ?? DEFAULT_TTL;
}

// ── Cache key generation ─────────────────────────────────────────────────────

function cacheKey(tool: string, args: Record<string, unknown>): string {
  const argsHash = createHash("sha256")
    .update(JSON.stringify(args, Object.keys(args).sort()))
    .digest("hex")
    .slice(0, 12);
  return `mcp:${tool}:${argsHash}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Create a Redis-backed MCP response cache */
export function createRedisCache(url: string): RedisCache {
  const client: RedisClient = new RedisClient(url, {
    maxRetriesPerRequest: 1,
    retryStrategy: function (times: number): number | void {
      if (times > 3) return undefined;
      return Math.min(times * 200, 2000);
    },
    lazyConnect: true,
  });

  // ioredis emits 'error' on connection loss — log and continue
  client.on("error", function redisError(err: Error) {
    console.error(`[redis] ${err.message}`);
  });

  let connected = false;

  return {
    async get(tool: string, args: Record<string, unknown>): Promise<CacheEntry | null> {
      try {
        const raw: string | null = await client.get(cacheKey(tool, args));
        if (!raw) return null;
        return JSON.parse(raw) as CacheEntry;
      } catch {
        return null;
      }
    },

    async set(tool: string, args: Record<string, unknown>, data: unknown, ttlSeconds?: number): Promise<void> {
      try {
        const key = cacheKey(tool, args);
        const entry: CacheEntry = {
          data: data,
          cachedAt: new Date().toISOString(),
          tool: tool,
        };
        const ttl = ttlSeconds ?? getTtl(tool);
        await client.set(key, JSON.stringify(entry), "EX", ttl);
      } catch {
        // Cache write failure is non-fatal
      }
    },

    async ping(): Promise<boolean> {
      try {
        if (!connected) {
          await client.connect();
          connected = true;
        }
        const res = await client.ping();
        return res === "PONG";
      } catch {
        return false;
      }
    },

    async quit(): Promise<void> {
      try {
        await client.quit();
      } catch {
        // already closed
      }
    },
  };
}

/** Create a no-op cache (used when REDIS_URL is not configured) */
export function createNoopCache(): RedisCache {
  return {
    async get() { return null; },
    async set() {},
    async ping() { return false; },
    async quit() {},
  };
}

/** Singleton — one cache per process */
let _singleton: Promise<RedisCache> | null = null;

/** Get or create the cache singleton based on REDIS_URL env var */
export function createCacheFromEnv(): Promise<RedisCache> {
  if (_singleton) return _singleton;

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
    } catch (err) {
      console.error(`[redis] connection failed: ${err}, falling back to no-op cache`);
      return createNoopCache();
    }
  })();

  return _singleton;
}
