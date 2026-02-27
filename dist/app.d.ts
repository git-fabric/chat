/**
 * @git-fabric/chat — FabricApp factory
 *
 * Implements the FabricApp interface from @git-fabric/gateway.
 * Exposes all chat and conversation management operations as a
 * single composable MCP layer.
 *
 * Tools:
 *   Sessions : chat_session_create, chat_session_list, chat_session_get,
 *              chat_session_archive, chat_session_delete
 *   Messaging: chat_message_send, chat_message_list
 *   Search   : chat_search
 *   Context  : chat_context_inject
 *   Status   : chat_status, chat_health
 *   Threading: chat_thread_fork
 */
import type { ChatAdapter } from "./types.js";
interface FabricTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
}
interface FabricApp {
    name: string;
    version: string;
    description: string;
    tools: FabricTool[];
    health: () => Promise<{
        app: string;
        status: "healthy" | "degraded" | "unavailable";
        latencyMs?: number;
        details?: Record<string, unknown>;
    }>;
}
export declare function createApp(adapterOverride?: ChatAdapter): FabricApp;
export {};
//# sourceMappingURL=app.d.ts.map