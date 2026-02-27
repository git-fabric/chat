/**
 * Environment adapter
 *
 * Creates a ChatAdapter from environment variables.
 * Used by the CLI, the gateway loader, and direct programmatic use.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY   — Claude completions + voyage-3-lite embeddings
 *   QDRANT_URL          — Qdrant instance URL (cloud or in-cluster)
 *   QDRANT_API_KEY      — Qdrant API key (omit for in-cluster no-auth)
 *   GITHUB_TOKEN        — state repo read/write access
 *
 * Optional:
 *   GITHUB_STATE_REPO   — defaults to "ry-ops/git-steer-state"
 */
import type { ChatAdapter } from "../types.js";
export declare function createAdapterFromEnv(): ChatAdapter;
//# sourceMappingURL=env.d.ts.map