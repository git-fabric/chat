/**
 * Redis cache adapter
 *
 * Cache layer for MCP tool responses. Uses ioredis.
 * Falls back to a no-op cache when Redis is unavailable.
 *
 * Keys:  mcp:<tool>:<hash(args)>
 * TTL:   Configurable per-tool, defaults to 60s
 */
export interface CacheEntry {
    data: unknown;
    cachedAt: string;
    tool: string;
}
export interface RedisCache {
    get(tool: string, args: Record<string, unknown>): Promise<CacheEntry | null>;
    set(tool: string, args: Record<string, unknown>, data: unknown, ttlSeconds?: number): Promise<void>;
    ping(): Promise<boolean>;
    quit(): Promise<void>;
}
/** Create a Redis-backed MCP response cache */
export declare function createRedisCache(url: string): RedisCache;
/** Create a no-op cache (used when REDIS_URL is not configured) */
export declare function createNoopCache(): RedisCache;
/** Get or create the cache singleton based on REDIS_URL env var */
export declare function createCacheFromEnv(): Promise<RedisCache>;
//# sourceMappingURL=redis.d.ts.map