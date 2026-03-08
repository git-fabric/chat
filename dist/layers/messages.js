/**
 * Messages layer
 *
 * Message send/receive: complete a turn, list messages, inject context.
 * Handles full Anthropic API round-trip with session history reconstruction.
 * When a fabric gateway is configured, uses Claude tool_use to query live
 * infrastructure data (k8s, unifi, proxmox, sandfly, cve, cloudflare, tailscale).
 *
 * Inputs:  ChatAdapter + message params
 * Outputs: ChatMessage objects / send results
 */
import Anthropic from "@anthropic-ai/sdk";
import { selectRelevantTools } from "../adapters/gateway.js";
// ── MoE keyword router (inline, mirrors gateway moe.js) ─────────────────────
// Used to detect which fabric app a user message is about, so we can pre-fetch
// live data before sending to Ollama (which can't do tool_use).
const MOE_ROUTES = [
    { app: "unifi", service: "fabric-unifi", port: 8200, priority: 100, keywords: ["unifi", "network", "wifi", "wireless", "ssid", "access point", "ap", "client", "bandwidth", "switch", "vlan", "ubiquiti"] },
    { app: "proxmox", service: "fabric-proxmox", port: 8200, priority: 100, keywords: ["proxmox", "pve", "vm", "virtual machine", "lxc", "hypervisor", "qemu", "snapshot"] },
    { app: "k8s", service: "fabric-k8s", port: 8200, priority: 100, keywords: ["kubernetes", "k8s", "k3s", "pod", "deployment", "namespace", "kubectl", "ingress", "helm", "statefulset"] },
    { app: "cloudflare", service: "fabric-cloudflare", port: 8200, priority: 90, keywords: ["cloudflare", "dns", "zone", "record", "cname", "cache", "worker", "tunnel"] },
    { app: "tailscale", service: "fabric-tailscale", port: 8200, priority: 90, keywords: ["tailscale", "vpn", "mesh", "acl", "exit node", "tailnet", "subnet"] },
    { app: "cve", service: "fabric-cve", port: 8200, priority: 90, keywords: ["cve", "vulnerability", "vuln", "patch", "security scan", "advisory", "exploit"] },
    { app: "sandfly", service: "fabric-sandfly", port: 8200, priority: 90, keywords: ["sandfly", "intrusion", "threat", "malware", "rootkit", "ioc"] },
    { app: "git", service: "fabric-git", port: 8200, priority: 80, keywords: ["git", "commit", "branch", "pull request", "pr", "repo", "merge", "release"] },
];
function detectFabricApp(message) {
    const lower = message.toLowerCase();
    let best = null;
    for (const route of MOE_ROUTES) {
        let score = 0;
        for (const kw of route.keywords) {
            if (lower.includes(kw))
                score += route.priority;
        }
        if (score > 0 && (!best || score > best.score)) {
            best = { route, score };
        }
    }
    return best ? best.route : null;
}
/** Call a fabric app's aiana_query endpoint directly via in-cluster service */
async function queryFabricApp(service, port, queryText) {
    const url = `http://${service}.fabric-sdk:${port}/mcp/tools/call`;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "aiana_query", arguments: { query_text: queryText } }),
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok)
            return null;
        const data = await res.json();
        if (data.context && data.context.length > 0)
            return data.context;
        return null;
    }
    catch {
        return null;
    }
}
/** Call a fabric app's tools/list endpoint to discover available tools, then call the first summary-like tool */
async function fetchFabricSummary(service, port, queryText) {
    const baseUrl = `http://${service}.fabric-sdk:${port}`;
    // First try aiana_query
    const aianaResult = await queryFabricApp(service, port, queryText);
    if (aianaResult)
        return aianaResult;
    // Fallback: list tools and call the first one that looks like a summary/list/health tool
    try {
        const toolsRes = await fetch(`${baseUrl}/tools`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!toolsRes.ok)
            return null;
        const tools = await toolsRes.json();
        // Find a summary/health/status/list tool
        const summaryTool = tools.find((t) => /health|status|summary|overview|list.*site|site.*health|cluster.*status|list.*device/i.test(t.name + " " + (t.description ?? ""))) ?? tools[0];
        if (!summaryTool)
            return null;
        const callRes = await fetch(`${baseUrl}/tools/call`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: summaryTool.name, arguments: {} }),
            signal: AbortSignal.timeout(15000),
        });
        if (!callRes.ok)
            return null;
        const result = await callRes.json();
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return text.length > 0 ? `[${summaryTool.name}]\n${text}` : null;
    }
    catch {
        return null;
    }
}
// ── Anthropic tool conversion ─────────────────────────────────────────────────
function fabricToolToAnthropic(tool) {
    return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
    };
}
// ── Agentic loop with fabric tool_use ─────────────────────────────────────────
async function completeWithTools(anthropic, model, systemPrompt, history, tools, callTool, maxTokens) {
    let totalInput = 0;
    let totalOutput = 0;
    let messages = [...history];
    // Up to 10 tool-call rounds to prevent infinite loops
    for (let round = 0; round < 10; round++) {
        const response = await anthropic.messages.create({
            model,
            max_tokens: maxTokens,
            system: systemPrompt,
            tools,
            messages,
        });
        totalInput += response.usage.input_tokens;
        totalOutput += response.usage.output_tokens;
        if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
            const textBlock = response.content.find((b) => b.type === "text");
            const content = textBlock && textBlock.type === "text" ? textBlock.text : "";
            return { content, inputTokens: totalInput, outputTokens: totalOutput };
        }
        if (response.stop_reason === "tool_use") {
            messages.push({ role: "assistant", content: response.content });
            const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
            // Max chars per tool result (~50k chars ≈ 12k tokens) to stay inside context limit
            const MAX_RESULT_CHARS = 50_000;
            const toolResults = await Promise.all(toolUseBlocks.map(async (block) => {
                try {
                    const result = await callTool(block.name, block.input);
                    let content = JSON.stringify(result);
                    if (content.length > MAX_RESULT_CHARS) {
                        content = content.slice(0, MAX_RESULT_CHARS) + `\n...[truncated — ${content.length - MAX_RESULT_CHARS} chars omitted]`;
                    }
                    return {
                        type: "tool_result",
                        tool_use_id: block.id,
                        content,
                    };
                }
                catch (err) {
                    return {
                        type: "tool_result",
                        tool_use_id: block.id,
                        is_error: true,
                        content: `Tool error: ${String(err)}`,
                    };
                }
            }));
            messages.push({ role: "user", content: toolResults });
            continue;
        }
        // Unknown stop_reason — return whatever text we have
        const textBlock = response.content.find((b) => b.type === "text");
        const content = textBlock && textBlock.type === "text" ? textBlock.text : "";
        return { content, inputTokens: totalInput, outputTokens: totalOutput };
    }
    throw new Error("Agentic loop exceeded 10 rounds without finishing");
}
// ── sendMessage ───────────────────────────────────────────────────────────────
export async function sendMessage(adapter, sessionId, content, maxTokens = 8192) {
    const session = await adapter.getSession(sessionId);
    if (session.state === "archived") {
        throw new Error(`Session ${sessionId} is archived. Resume it or create a new session.`);
    }
    // Store the user message
    const userMsg = await adapter.addMessage({ sessionId, role: "user", content });
    // Embed user message (best-effort)
    try {
        await adapter.embedAndStore(userMsg);
    }
    catch {
        // Non-fatal
    }
    // Build Anthropic message history
    const history = [
        ...session.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
            role: m.role,
            content: m.content,
        })),
        { role: "user", content },
    ];
    const isOllama = !!process.env.OLLAMA_ENDPOINT;
    const hasFabricGateway = typeof adapter.listFabricTools === "function" &&
        typeof adapter.callFabricTool === "function";
    // ── Ollama pre-fetch: detect fabric app from message & inject live data ────
    if (isOllama) {
        const detected = detectFabricApp(content);
        if (detected) {
            try {
                const context = await fetchFabricSummary(detected.service, detected.port, content);
                if (context) {
                    history.splice(history.length - 1, 0, {
                        role: "user",
                        content: `[System context — live ${detected.app} data]\n\n${context}\n\nSummarize this data in a clear, concise report for the user.`,
                    });
                }
            }
            catch {
                // Pre-fetch failed — continue without context
            }
        }
    }
    let result;
    if (hasFabricGateway && !isOllama) {
        let fabricTools = [];
        try {
            const allTools = await adapter.listFabricTools();
            // Change A: pre-filter tools to only those relevant to this message
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            fabricTools = await selectRelevantTools(allTools, content, anthropic);
        }
        catch {
            // Gateway unreachable or filter failed — proceed without tools
        }
        if (fabricTools.length > 0) {
            const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            result = await completeWithTools(anthropic, session.model, session.systemPrompt, history, fabricTools.map(fabricToolToAnthropic), (name, args) => adapter.callFabricTool(name, args), maxTokens);
        }
        else {
            result = await adapter.complete(history.map((m) => ({
                role: m.role,
                content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
            })), { model: session.model, systemPrompt: session.systemPrompt, maxTokens });
        }
    }
    else {
        result = await adapter.complete(history.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        })), { model: session.model, systemPrompt: session.systemPrompt, maxTokens });
    }
    // Store assistant response
    const assistantMsg = await adapter.addMessage({
        sessionId,
        role: "assistant",
        content: result.content,
        model: session.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
    });
    // Embed assistant message (best-effort)
    try {
        await adapter.embedAndStore(assistantMsg);
    }
    catch {
        // Non-fatal
    }
    return {
        messageId: assistantMsg.id,
        role: "assistant",
        content: result.content,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: session.model,
        routingLane: result.routingLane,
    };
}
export async function listMessages(adapter, sessionId, limit = 50, offset = 0) {
    return adapter.getMessages(sessionId, limit, offset);
}
export async function injectContext(adapter, sessionId, context, role = "system") {
    const msg = await adapter.addMessage({
        sessionId,
        role,
        content: context,
        metadata: { injected: true, injectedAt: new Date().toISOString() },
    });
    return { messageId: msg.id, sessionId, role };
}
//# sourceMappingURL=messages.js.map