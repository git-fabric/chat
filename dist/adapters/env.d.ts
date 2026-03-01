/**
 * Environment adapter
 *
 * Creates a ChatAdapter from environment variables.
 * State backend: Qdrant only (sessions + messages stored as points).
 * No GitHub dependency for chat state.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY  — Claude completions + Voyage AI embeddings
 *   QDRANT_URL         — Qdrant instance URL (cloud or in-cluster)
 *
 * Optional:
 *   QDRANT_API_KEY      — Qdrant API key (omit for in-cluster no-auth)
 *   FABRIC_GATEWAY_URL  — fabric-gateway MCP endpoint; enables agentic tool loop
 */
import { selectRelevantTools } from "./gateway.js";
import type { ChatAdapter, FabricTool } from "../types.js";
export declare function createAdapterFromEnv(): ChatAdapter;
export { selectRelevantTools };
export type { FabricTool };
//# sourceMappingURL=env.d.ts.map