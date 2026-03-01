/**
 * Fabric gateway MCP client
 *
 * Thin HTTP client for the fabric-gateway MCP endpoint.
 * Handles JSON-RPC over SSE (StreamableHTTP transport).
 *
 * Two public functions:
 *   listTools(url)            — fetch all available tools
 *   callTool(url, name, args) — invoke a tool, unwrap content blocks
 *
 * Tool category pre-filter:
 *   selectRelevantTools(allTools, message, anthropic) — returns the subset of
 *   tools relevant to the user's message using a lightweight Haiku call.
 *   Caps tool list at MAX_TOOLS to keep context overhead manageable.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { FabricTool } from "../types.js";
export declare function listTools(gatewayUrl: string): Promise<FabricTool[]>;
export declare function callTool(gatewayUrl: string, name: string, args: Record<string, unknown>): Promise<unknown>;
export declare function selectRelevantTools(allTools: FabricTool[], userMessage: string, anthropic: Anthropic): Promise<FabricTool[]>;
//# sourceMappingURL=gateway.d.ts.map