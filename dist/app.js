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
 *   Intel    : chat_briefing
 */
import { createAdapterFromEnv } from "./adapters/env.js";
import * as layers from "./layers/index.js";
// ── createApp ────────────────────────────────────────────────────────────────
export function createApp(adapterOverride) {
    const adapter = adapterOverride ?? createAdapterFromEnv();
    const tools = [
        // ── Session management ────────────────────────────────────────────────────
        {
            name: "chat_session_create",
            description: "Create a new chat session with Claude. Optionally set a system prompt, project tag, model, and title. Returns the sessionId to use in subsequent calls.",
            annotations: { readOnlyHint: false, destructiveHint: false },
            inputSchema: {
                type: "object",
                properties: {
                    systemPrompt: {
                        type: "string",
                        description: "System prompt to set the assistant's behaviour and context.",
                    },
                    project: {
                        type: "string",
                        description: "Project tag for grouping sessions (e.g. cortex-gitops, cortex-school).",
                    },
                    model: {
                        type: "string",
                        enum: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
                        description: "Claude model to use. Default: claude-sonnet-4-6.",
                    },
                    title: {
                        type: "string",
                        description: "Human-readable title for the session.",
                    },
                },
            },
            execute: async (args) => layers.sessions.createSession(adapter, {
                systemPrompt: args.systemPrompt,
                project: args.project,
                model: args.model,
                title: args.title,
            }),
        },
        {
            name: "chat_session_list",
            description: "List recent chat sessions. Filter by project, state, and limit. Sessions are sorted by most recently updated first.",
            annotations: { readOnlyHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    project: {
                        type: "string",
                        description: "Filter to sessions with this project tag.",
                    },
                    limit: {
                        type: "number",
                        description: "Maximum number of sessions to return. Default: 20.",
                    },
                    state: {
                        type: "string",
                        enum: ["active", "archived", "all"],
                        description: "Filter by session state. Default: active.",
                    },
                },
            },
            execute: async (args) => layers.sessions.listSessions(adapter, {
                project: args.project,
                limit: args.limit,
                state: args.state,
            }),
        },
        {
            name: "chat_session_get",
            description: "Get full session details including message history. Use this to inspect or resume a prior conversation.",
            annotations: { readOnlyHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    sessionId: {
                        type: "string",
                        description: "UUID of the session to retrieve.",
                    },
                },
                required: ["sessionId"],
            },
            execute: async (args) => layers.sessions.getSession(adapter, args.sessionId),
        },
        {
            name: "chat_session_archive",
            description: "Archive a session. Archived sessions are hidden from the default list but remain searchable and resumable.",
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    sessionId: {
                        type: "string",
                        description: "UUID of the session to archive.",
                    },
                },
                required: ["sessionId"],
            },
            execute: async (args) => layers.sessions.archiveSession(adapter, args.sessionId),
        },
        {
            name: "chat_session_delete",
            description: "Permanently delete a session and all its messages. This also removes vectors from Qdrant. Irreversible.",
            annotations: { readOnlyHint: false, destructiveHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    sessionId: {
                        type: "string",
                        description: "UUID of the session to delete.",
                    },
                },
                required: ["sessionId"],
            },
            execute: async (args) => layers.sessions.deleteSession(adapter, args.sessionId),
        },
        // ── Messaging ─────────────────────────────────────────────────────────────
        {
            name: "chat_message_send",
            description: "Send a message in an existing session and get a Claude response. Reconstructs full conversation history for the API call. Stores both user message and assistant response. Returns the assistant reply with token usage.",
            annotations: { readOnlyHint: false, destructiveHint: false },
            inputSchema: {
                type: "object",
                properties: {
                    sessionId: {
                        type: "string",
                        description: "UUID of the session to send the message in.",
                    },
                    content: {
                        type: "string",
                        description: "Message content from the user.",
                    },
                    maxTokens: {
                        type: "number",
                        description: "Maximum tokens in the response. Default: 8192.",
                    },
                },
                required: ["sessionId", "content"],
            },
            execute: async (args) => layers.messages.sendMessage(adapter, args.sessionId, args.content, args.maxTokens),
        },
        {
            name: "chat_message_list",
            description: "List messages in a session with pagination. Returns messages in chronological order.",
            annotations: { readOnlyHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    sessionId: {
                        type: "string",
                        description: "UUID of the session.",
                    },
                    limit: {
                        type: "number",
                        description: "Maximum number of messages to return. Default: 50.",
                    },
                    offset: {
                        type: "number",
                        description: "Number of messages to skip (for pagination). Default: 0.",
                    },
                },
                required: ["sessionId"],
            },
            execute: async (args) => layers.messages.listMessages(adapter, args.sessionId, args.limit, args.offset),
        },
        // ── Semantic search ───────────────────────────────────────────────────────
        {
            name: "chat_search",
            description: "Semantic search over all stored conversation content using vector similarity. Finds messages relevant to the query even if exact words don't match. Optionally scope to a project or specific session.",
            annotations: { readOnlyHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Natural language search query.",
                    },
                    project: {
                        type: "string",
                        description: "Scope search to sessions with this project tag.",
                    },
                    limit: {
                        type: "number",
                        description: "Maximum number of results. Default: 10.",
                    },
                    sessionId: {
                        type: "string",
                        description: "Scope search to a single session UUID.",
                    },
                },
                required: ["query"],
            },
            execute: async (args) => layers.search.search(adapter, args.query, {
                project: args.project,
                sessionId: args.sessionId,
                limit: args.limit,
            }),
        },
        // ── Context injection ─────────────────────────────────────────────────────
        {
            name: "chat_context_inject",
            description: "Inject external context into a session before the next message send. Use this to pipe in Aiana memory recall, documentation snippets, or runtime state. The injected content is stored as a message and included in the next completion call.",
            annotations: { readOnlyHint: false, destructiveHint: false },
            inputSchema: {
                type: "object",
                properties: {
                    sessionId: {
                        type: "string",
                        description: "UUID of the session to inject context into.",
                    },
                    context: {
                        type: "string",
                        description: "Context content to inject (markdown, JSON, plain text).",
                    },
                    role: {
                        type: "string",
                        enum: ["system", "user"],
                        description: "Role for the injected context message. Default: system.",
                    },
                },
                required: ["sessionId", "context"],
            },
            execute: async (args) => layers.messages.injectContext(adapter, args.sessionId, args.context, args.role),
        },
        // ── Status / quota ────────────────────────────────────────────────────────
        {
            name: "chat_status",
            description: "Return aggregate stats: total sessions, total messages, and tokens consumed today. Useful for quota monitoring and observability.",
            annotations: { readOnlyHint: true },
            inputSchema: {
                type: "object",
                properties: {},
            },
            execute: async () => adapter.getStats(),
        },
        {
            name: "chat_health",
            description: "Ping Anthropic and Qdrant services. Returns latency for each. Use to verify the app is operational before sending messages.",
            annotations: { readOnlyHint: true },
            inputSchema: {
                type: "object",
                properties: {},
            },
            execute: async () => {
                const start = Date.now();
                const h = await adapter.health();
                return {
                    ...h,
                    totalLatencyMs: Date.now() - start,
                    status: h.anthropic.latencyMs < 10000 && h.qdrant.latencyMs < 10000
                        ? "healthy"
                        : "degraded",
                };
            },
        },
        // ── Threading ─────────────────────────────────────────────────────────────
        {
            name: "chat_thread_fork",
            description: "Fork a session at a specific message to explore an alternative branch of conversation. Creates a new session with all history up to and including the fork point. The original session is unchanged.",
            annotations: { readOnlyHint: false, destructiveHint: false },
            inputSchema: {
                type: "object",
                properties: {
                    sessionId: {
                        type: "string",
                        description: "UUID of the session to fork.",
                    },
                    forkFromMessageId: {
                        type: "string",
                        description: "UUID of the message at which to fork. The new session will include this message and all prior messages.",
                    },
                    title: {
                        type: "string",
                        description: "Title for the new forked session. Defaults to 'Fork of <original title>'.",
                    },
                },
                required: ["sessionId", "forkFromMessageId"],
            },
            execute: async (args) => layers.sessions.forkSession(adapter, args.sessionId, args.forkFromMessageId, args.title),
        },
        // ── Service Intelligence ──────────────────────────────────────────────────
        {
            name: "chat_briefing",
            description: "Generate a structured service briefing for any fabric service. " +
                "Modes: overview (default) — 11-section briefing with live telemetry; " +
                "inspect — deep pull all available tools; map — ASCII dependency tree. " +
                "Trigger: 'service <name>', 'inspect <name>', or 'map <name>'.",
            annotations: { readOnlyHint: true },
            inputSchema: {
                type: "object",
                properties: {
                    service: {
                        type: "string",
                        description: "Service name: unifi, proxmox, k8s, cloudflare, tailscale, " +
                            "sandfly, cve, git, aiana, chat. Aliases: pve→proxmox, " +
                            "argocd→k8s, vpn→tailscale, memory→aiana, etc.",
                    },
                    mode: {
                        type: "string",
                        enum: ["overview", "inspect", "map"],
                        description: "Briefing depth. Default: overview.",
                    },
                    query: {
                        type: "string",
                        description: "Optional: pass the raw user message to auto-detect service and mode.",
                    },
                },
            },
            execute: async (args) => {
                const { parseServiceQuery, resolveAppName, formatBriefing, formatMap } = await import("./layers/service-intel.js");
                // Auto-detect from raw query if provided
                if (args.query) {
                    const parsed = parseServiceQuery(args.query);
                    if (parsed) {
                        return parsed.mode === "map"
                            ? formatMap(parsed.app)
                            : formatBriefing(parsed.app, null, null);
                    }
                }
                const app = resolveAppName(args.service);
                if (!app) {
                    return `Unknown service: "${args.service}". ` +
                        "Available: unifi, proxmox, k8s, cloudflare, tailscale, sandfly, cve, git, aiana, chat";
                }
                const mode = args.mode ?? "overview";
                return mode === "map"
                    ? formatMap(app)
                    : formatBriefing(app, null, null);
            },
        },
    ];
    return {
        name: "@git-fabric/chat",
        version: "0.1.0",
        description: "Chat fabric app — AI conversation sessions, semantic history search, and context threading",
        tools,
        async health() {
            const start = Date.now();
            try {
                const h = await adapter.health();
                const latencyMs = Date.now() - start;
                const status = h.anthropic.latencyMs < 10000 && h.qdrant.latencyMs < 10000
                    ? "healthy"
                    : "degraded";
                return {
                    app: "@git-fabric/chat",
                    status,
                    latencyMs,
                    details: {
                        anthropicLatencyMs: h.anthropic.latencyMs,
                        qdrantLatencyMs: h.qdrant.latencyMs,
                    },
                };
            }
            catch (e) {
                return {
                    app: "@git-fabric/chat",
                    status: "unavailable",
                    latencyMs: Date.now() - start,
                    details: { error: String(e) },
                };
            }
        },
    };
}
//# sourceMappingURL=app.js.map