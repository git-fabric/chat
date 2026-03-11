/**
 * Redis cache adapter
 *
 * Thin wrapper around Redis for caching MCP tool responses.
 * Uses REDIS_URL env var. Falls back to a no-op cache when Redis
 * is unavailable — chat keeps working, just uncached.
 *
 * Keys:  mcp:<tool>:<hash(args)>
 * TTL:   Configurable per-tool, defaults to 60s
 */

import { createHash } from "crypto";

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

// ── Redis client (raw TCP via Node built-in, no external dependency) ────────
// Uses the Redis RESP protocol directly to avoid adding ioredis/redis packages.

interface RedisConnection {
  command(cmd: string, ...args: string[]): Promise<string | null>;
  close(): Promise<void>;
  connected: boolean;
}

async function createRedisConnection(url: string): Promise<RedisConnection> {
  const { createConnection } = await import("net");
  const parsed = new URL(url);
  const host = parsed.hostname || "127.0.0.1";
  const port = parseInt(parsed.port || "6379", 10);
  const password = parsed.password || undefined;

  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port }, async () => {
      const conn: RedisConnection = {
        connected: true,

        async command(cmd: string, ...args: string[]): Promise<string | null> {
          if (!conn.connected) return null;
          return new Promise((res, rej) => {
            // Build RESP array
            const parts = [cmd, ...args];
            let resp = `*${parts.length}\r\n`;
            for (const p of parts) {
              resp += `$${Buffer.byteLength(p)}\r\n${p}\r\n`;
            }

            let data = "";
            const onData = (chunk: Buffer) => {
              data += chunk.toString();
              // Simple RESP parser — handles bulk strings, simple strings, integers, nulls, errors
              if (data.startsWith("$-1\r\n")) {
                socket.removeListener("data", onData);
                res(null);
              } else if (data.startsWith("$")) {
                const nlIdx = data.indexOf("\r\n");
                if (nlIdx === -1) return; // wait for more data
                const len = parseInt(data.slice(1, nlIdx), 10);
                const expectedTotal = nlIdx + 2 + len + 2;
                if (data.length >= expectedTotal) {
                  socket.removeListener("data", onData);
                  res(data.slice(nlIdx + 2, nlIdx + 2 + len));
                }
              } else if (data.startsWith("+")) {
                const nlIdx = data.indexOf("\r\n");
                if (nlIdx !== -1) {
                  socket.removeListener("data", onData);
                  res(data.slice(1, nlIdx));
                }
              } else if (data.startsWith(":")) {
                const nlIdx = data.indexOf("\r\n");
                if (nlIdx !== -1) {
                  socket.removeListener("data", onData);
                  res(data.slice(1, nlIdx));
                }
              } else if (data.startsWith("-")) {
                const nlIdx = data.indexOf("\r\n");
                if (nlIdx !== -1) {
                  socket.removeListener("data", onData);
                  rej(new Error(data.slice(1, nlIdx)));
                }
              }
            };

            socket.on("data", onData);
            socket.write(resp);
          });
        },

        async close() {
          conn.connected = false;
          socket.destroy();
        },
      };

      // Authenticate if password is set
      if (password) {
        try {
          await conn.command("AUTH", password);
        } catch {
          conn.connected = false;
          socket.destroy();
          reject(new Error("Redis AUTH failed"));
          return;
        }
      }

      resolve(conn);
    });

    socket.on("error", () => {
      reject(new Error(`Redis connection failed: ${host}:${port}`));
    });

    // 5s connection timeout
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("Redis connection timeout"));
    });
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Create a Redis-backed MCP response cache */
export async function createRedisCache(url: string): Promise<RedisCache> {
  const conn = await createRedisConnection(url);

  return {
    async get(tool, args) {
      try {
        const key = cacheKey(tool, args);
        const raw = await conn.command("GET", key);
        if (!raw) return null;
        return JSON.parse(raw) as CacheEntry;
      } catch {
        return null;
      }
    },

    async set(tool, args, data, ttlSeconds) {
      try {
        const key = cacheKey(tool, args);
        const entry: CacheEntry = {
          data,
          cachedAt: new Date().toISOString(),
          tool,
        };
        const ttl = ttlSeconds ?? getTtl(tool);
        await conn.command("SET", key, JSON.stringify(entry), "EX", String(ttl));
      } catch {
        // Cache write failure is non-fatal
      }
    },

    async ping() {
      try {
        const res = await conn.command("PING");
        return res === "PONG";
      } catch {
        return false;
      }
    },

    async quit() {
      await conn.close();
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

/** Singleton — only one connection per process */
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
      const cache = await createRedisCache(redisUrl);
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
