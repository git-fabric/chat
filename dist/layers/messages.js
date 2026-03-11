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
import { createOllamaConfig, ollamaCompleteStream } from "../adapters/ollama.js";
import { createCacheFromEnv } from "../adapters/redis.js";
import { parseServiceQuery, formatBriefing, formatMap, INSPECT_TOOLS, } from "./service-intel.js";
// ── MoE keyword router (inline, mirrors gateway moe.js) ─────────────────────
// Used to detect which fabric app a user message is about, so we can pre-fetch
// live data before sending to Ollama (which can't do tool_use).
const MOE_ROUTES = [
    { app: "unifi", service: "fabric-unifi", port: 8200, priority: 100, keywords: ["unifi", "wifi", "wireless", "ssid", "access point", "ubiquiti", "vlan", "ap "] },
    { app: "proxmox", service: "fabric-proxmox", port: 8200, priority: 100, keywords: ["proxmox", "pve", "vm", "virtual machine", "lxc", "hypervisor", "qemu"] },
    { app: "k8s", service: "fabric-k8s", port: 8200, priority: 100, keywords: ["kubernetes", "k8s", "k3s", "pod", "deployment", "namespace", "kubectl", "ingress", "helm", "statefulset"] },
    { app: "cloudflare", service: "fabric-cloudflare", port: 8200, priority: 90, keywords: ["cloudflare", "dns record", "zone", "cname", "cache purge", "worker", "tunnel"] },
    { app: "tailscale", service: "fabric-tailscale", port: 8200, priority: 90, keywords: ["tailscale", "vpn", "tailnet", "exit node", "subnet router", "magic dns"] },
    { app: "cve", service: "fabric-cve", port: 8200, priority: 90, keywords: ["cve", "vulnerability", "vuln", "patch", "security scan", "advisory", "exploit"] },
    { app: "sandfly", service: "fabric-sandfly", port: 8200, priority: 90, keywords: ["sandfly", "intrusion", "threat", "malware", "rootkit", "ioc"] },
    { app: "git", service: "fabric-git", port: 8200, priority: 80, keywords: ["git repo", "commit", "branch", "pull request", "pr ", "merge", "release"] },
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
/** Does the message need LLM reasoning, or is a pre-formatted report sufficient? */
function needsLlmReasoning(message) {
    const lower = message.toLowerCase().trim();
    // If the question matches a specific query pattern, the data answers the question — no LLM needed
    for (const q of SPECIFIC_QUERIES) {
        if (q.pattern.test(lower))
            return false;
    }
    // Questions need reasoning
    if (/\?$/.test(lower))
        return true;
    if (/^(how|what|why|when|where|which|who|can|could|should|is|are|do|does|will|would|explain|compare|tell me|help|describe)[\s,]/.test(lower))
        return true;
    // Multi-word analysis requests
    if (/\b(wrong|issue|problem|fix|diagnose|troubleshoot|analyze|recommend|suggest)\b/.test(lower))
        return true;
    // Short keyword-style messages → report is enough
    return false;
}
/** Default summary tools for each fabric app (used for bare app name queries) */
/** Multiple tools are fetched in parallel and merged for richer reports */
const SUMMARY_TOOLS = {
    unifi: [{ tool: "unifi_network_status", key: "status" }],
    proxmox: [
        { tool: "pve_cluster_status", key: "cluster" },
        { tool: "pve_list_vms", args: { node: "pve01" }, key: "vms" },
        { tool: "pve_list_storage", key: "storage" },
    ],
    k8s: [
        { tool: "k8s_cluster_info", key: "cluster" },
        { tool: "k8s_list_nodes", key: "nodes" },
    ],
    cloudflare: [{ tool: "cf_list_zones", key: "zones" }],
    tailscale: [{ tool: "ts_health", key: "health" }],
    cve: [{ tool: "cve_queue_stats", key: "stats" }],
    sandfly: [{ tool: "sandfly_get_alerts", key: "alerts" }],
    git: [{ tool: "git_repo_list", key: "repos" }],
};
/** Specific query patterns → tool mappings for targeted questions */
const SPECIFIC_QUERIES = [
    // K8s
    { pattern: /how many pods|list pods|pod count|pods running|pods status/i, app: "k8s", tool: "k8s_list_pods", args: {} },
    { pattern: /pod (problem|fail|crash|error|not ready)/i, app: "k8s", tool: "k8s_pod_problems" },
    { pattern: /deployment|deployments/i, app: "k8s", tool: "k8s_list_deployments" },
    { pattern: /node status|nodes|cluster nodes/i, app: "k8s", tool: "k8s_list_nodes" },
    { pattern: /event|warning|cluster event/i, app: "k8s", tool: "k8s_list_events" },
    { pattern: /argocd|argo app|sync status/i, app: "k8s", tool: "k8s_list_argocd_apps" },
    { pattern: /pvc|volume|storage claim/i, app: "k8s", tool: "k8s_list_pvcs" },
    { pattern: /longhorn/i, app: "k8s", tool: "k8s_list_longhorn_volumes" },
    { pattern: /ingress|route|traefik/i, app: "k8s", tool: "k8s_list_ingress_routes" },
    // UniFi
    { pattern: /device|ap |access point|switch/i, app: "unifi", tool: "unifi_list_devices" },
    { pattern: /client|connected|bandwidth/i, app: "unifi", tool: "unifi_network_status" },
    { pattern: /site/i, app: "unifi", tool: "unifi_list_sites" },
    // Proxmox
    { pattern: /vm|virtual machine/i, app: "proxmox", tool: "pve_list_vms", args: { node: "pve01" } },
    { pattern: /container|lxc/i, app: "proxmox", tool: "pve_list_containers", args: { node: "pve01" } },
    { pattern: /storage|disk/i, app: "proxmox", tool: "pve_list_storage" },
    { pattern: /task|job/i, app: "proxmox", tool: "pve_list_tasks" },
    // Tailscale
    { pattern: /device|machine|node/i, app: "tailscale", tool: "ts_list_devices" },
    { pattern: /acl|access control|policy/i, app: "tailscale", tool: "ts_get_acl" },
    { pattern: /dns|nameserver/i, app: "tailscale", tool: "ts_get_dns" },
    // Cloudflare
    { pattern: /dns record|record/i, app: "cloudflare", tool: "cf_list_dns_records" },
    { pattern: /analytic|traffic|bandwidth/i, app: "cloudflare", tool: "cf_zone_analytics" },
    // Git
    { pattern: /pull request|pr /i, app: "git", tool: "git_pr_list" },
    { pattern: /commit/i, app: "git", tool: "git_commit_list" },
    // Sandfly
    { pattern: /alert|threat|finding/i, app: "sandfly", tool: "sandfly_get_alerts" },
    { pattern: /host|server|machine/i, app: "sandfly", tool: "sandfly_list_hosts" },
    { pattern: /scan|result/i, app: "sandfly", tool: "sandfly_get_results" },
];
/** Determine which tool(s) to call based on the user message */
function selectTools(app, message) {
    // Check for specific query patterns first — single tool
    for (const q of SPECIFIC_QUERIES) {
        if (q.app === app && q.pattern.test(message)) {
            return [{ tool: q.tool, args: q.args ?? {}, key: "result" }];
        }
    }
    // Fall back to default summary tools (may be multiple)
    return SUMMARY_TOOLS[app] ?? [{ tool: `${app}_health`, args: {}, key: "result" }];
}
function formatUnifi(data) {
    // Handle both direct result and keyed {status: ...} wrapper
    const inner = (data.status ?? data);
    const summary = inner.summary;
    const devices = inner.devices;
    if (!summary || !devices)
        return JSON.stringify(data, null, 2);
    const devSummary = summary.devices;
    const lines = [
        `## UniFi Network Report`,
        ``,
        `**${devSummary?.total ?? "?"} devices** — ${devSummary?.online ?? "?"} online, ${devSummary?.offline ?? "?"} offline`,
        `**${summary.hosts ?? "?"} host(s)**, **${summary.sites ?? "?"} site(s)**`,
        ``,
        `### Devices`,
    ];
    for (const d of devices) {
        const status = d.status === "online" ? "✅" : "🔴";
        const fw = d.firmwareStatus === "upToDate" ? "" : ` ⚠️ ${d.firmwareStatus}`;
        lines.push(`${status} **${d.name}** (${d.model}) — ${d.ip}${d.version ? ` v${d.version}` : ""}${fw}`);
    }
    const offline = devices.filter((d) => d.status !== "online");
    if (offline.length > 0) {
        lines.push("", "### Issues");
        for (const d of offline)
            lines.push(`- **${d.name}** (${d.model}) is offline — MAC: ${d.mac}`);
    }
    return lines.join("\n");
}
function formatProxmox(data) {
    const cluster = data.cluster;
    const vms = data.vms;
    const storage = data.storage;
    const lines = ["## Proxmox Cluster Report", ""];
    // Nodes from cluster status
    if (Array.isArray(cluster)) {
        const nodes = cluster.filter((r) => r.type === "node");
        const qemuFromCluster = cluster.filter((r) => r.type === "qemu");
        const lxcFromCluster = cluster.filter((r) => r.type === "lxc");
        lines.push("### Nodes");
        for (const n of nodes) {
            const status = n.status === "online" ? "✅" : "🔴";
            const cpu = n.cpu != null ? ` — CPU: ${(Number(n.cpu) * 100).toFixed(0)}%` : "";
            const mem = n.maxmem ? ` — RAM: ${fmtBytes(Number(n.mem))}/${fmtBytes(Number(n.maxmem))}` : "";
            lines.push(`${status} **${n.node}**${cpu}${mem}`);
        }
        if (nodes.length === 0)
            lines.push("- No node data available");
        // VMs from cluster/resources (has CPU/mem)
        const allVms = qemuFromCluster.length > 0 ? qemuFromCluster : (Array.isArray(vms) ? vms : []);
        if (allVms.length > 0) {
            lines.push("", "### Virtual Machines");
            for (const vm of allVms) {
                const status = vm.status === "running" ? "✅" : vm.status === "stopped" ? "⏹️" : "⚠️";
                const cpu = vm.cpu != null ? ` CPU: ${(Number(vm.cpu) * 100).toFixed(0)}%` : "";
                const mem = vm.maxmem ? ` RAM: ${fmtBytes(Number(vm.mem))}/${fmtBytes(Number(vm.maxmem))}` : "";
                const name = vm.name ?? `VM ${vm.vmid}`;
                lines.push(`${status} **${name}** (${vm.status})${cpu}${mem}`);
            }
        }
        if (lxcFromCluster.length > 0) {
            lines.push("", "### Containers (LXC)");
            for (const ct of lxcFromCluster) {
                const status = ct.status === "running" ? "✅" : "⏹️";
                const name = ct.name ?? `CT ${ct.vmid}`;
                lines.push(`${status} **${name}** (${ct.status})`);
            }
        }
    }
    else {
        lines.push("No cluster data available.");
    }
    if (Array.isArray(storage) && storage.length > 0) {
        lines.push("", "### Storage");
        for (const s of storage) {
            const used = s.disk != null && s.maxdisk ? `${fmtBytes(Number(s.disk))}/${fmtBytes(Number(s.maxdisk))}` : "?";
            const pct = s.disk != null && s.maxdisk ? ` (${((Number(s.disk) / Number(s.maxdisk)) * 100).toFixed(0)}%)` : "";
            lines.push(`- **${s.storage ?? s.name}** on ${s.node ?? "?"}: ${used}${pct}`);
        }
    }
    return lines.join("\n");
}
function fmtBytes(bytes) {
    if (bytes >= 1073741824)
        return `${(bytes / 1073741824).toFixed(1)}Gi`;
    if (bytes >= 1048576)
        return `${(bytes / 1048576).toFixed(0)}Mi`;
    return `${(bytes / 1024).toFixed(0)}Ki`;
}
function formatK8s(data) {
    const cluster = data.cluster;
    // list_nodes returns a flat array, not {nodes: [...]}
    const rawNodes = data.nodes;
    const nodes = (Array.isArray(rawNodes) ? rawNodes : rawNodes?.nodes ?? []);
    const lines = [
        "## Kubernetes Cluster Report",
        "",
        `- **Server version:** ${cluster?.serverVersion ?? "?"} (${cluster?.platform ?? "?"})`,
        `- **Nodes:** ${cluster?.nodeCount ?? nodes.length}`,
        `- **Namespaces:** ${cluster?.namespaceCount ?? "?"}`,
        `- **Pods:** ${cluster?.podCount ?? "?"}`,
    ];
    if (nodes.length > 0) {
        lines.push("", "### Nodes");
        for (const n of nodes) {
            const status = n.status === "Ready" ? "✅" : "🔴";
            const roles = String(n.roles ?? "worker");
            const age = n.age ? ` — age: ${n.age}` : "";
            const os = n.os ? ` — ${n.os}` : "";
            lines.push(`${status} **${n.name}** (${roles}) ${n.version ?? ""}${age}${os}`);
        }
    }
    return lines.join("\n");
}
function formatTailscale(data) {
    const health = (data.health ?? data);
    const summary = health.summary;
    const devicesByOs = health.devices_by_os;
    const exitNodes = health.exit_nodes;
    const lines = [
        "## Tailscale Network Report",
        "",
        `- **Status:** ${health.healthy ? "✅ Healthy" : "⚠️ Degraded"}`,
        `- **Total devices:** ${summary?.total_devices ?? "?"}`,
        `- **Authorized:** ${summary?.authorized ?? "?"}`,
        `- **Exit nodes:** ${summary?.exit_nodes ?? exitNodes?.length ?? 0}`,
    ];
    if (devicesByOs && Object.keys(devicesByOs).length > 0) {
        lines.push("", "### Devices by OS");
        for (const [os, count] of Object.entries(devicesByOs)) {
            lines.push(`- **${os}:** ${count}`);
        }
    }
    return lines.join("\n");
}
function formatCloudflare(data) {
    const zones = (data.zones ?? data);
    if (!Array.isArray(zones))
        return JSON.stringify(data, null, 2);
    const lines = [
        "## Cloudflare Report",
        "",
        `**${zones.length} zone(s)**`,
        "",
    ];
    for (const z of zones) {
        const status = z.status === "active" ? "✅" : "⚠️";
        const plan = z.plan?.name ?? "?";
        lines.push(`${status} **${z.name}** — ${z.status}, plan: ${plan}`);
    }
    return lines.join("\n");
}
function formatGeneric(app, data) {
    const title = app.charAt(0).toUpperCase() + app.slice(1);
    if (Array.isArray(data)) {
        const lines = [`## ${title} Report`, "", `**${data.length} items**`, ""];
        for (const item of data.slice(0, 20)) {
            const i = item;
            const name = i.name ?? i.full_name ?? i.id ?? "?";
            const desc = i.description ?? i.status ?? "";
            lines.push(`- **${name}**${desc ? ` — ${desc}` : ""}`);
        }
        if (data.length > 20)
            lines.push(`- ... and ${data.length - 20} more`);
        return lines.join("\n");
    }
    return `## ${title} Report\n\n${JSON.stringify(data, null, 2)}`;
}
const FORMATTERS = {
    unifi: formatUnifi,
    proxmox: formatProxmox,
    k8s: formatK8s,
    tailscale: formatTailscale,
    cloudflare: formatCloudflare,
};
// ── Redis cache (lazy singleton) ─────────────────────────────────────────────
let _cache = null;
let _cacheInitPromise = null;
function getCache() {
    if (!_cacheInitPromise) {
        _cacheInitPromise = createCacheFromEnv().then((c) => { _cache = c; return c; });
    }
    return _cacheInitPromise;
}
/** Fetch one tool from a fabric app (with Redis cache) */
async function callFabricTool(baseUrl, tool, args) {
    const cache = await getCache();
    // Check cache first
    const cached = await cache.get(tool, args);
    if (cached)
        return cached.data;
    const res = await fetch(`${baseUrl}/tools/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tool, arguments: args }),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok)
        return null;
    const data = await res.json();
    // Cache the response (fire-and-forget)
    cache.set(tool, args, data).catch(() => { });
    return data;
}
/** Fetch live data from a fabric app, pre-format into a readable report */
async function fetchFabricSummary(service, port, app, message) {
    const baseUrl = `http://${service}.fabric-sdk:${port}`;
    const toolSpecs = selectTools(app, message);
    try {
        // Fetch all tools in parallel
        const results = await Promise.all(toolSpecs.map(async (spec) => {
            const result = await callFabricTool(baseUrl, spec.tool, spec.args ?? {});
            return { key: spec.key, result };
        }));
        // If single tool, pass result directly; if multi, merge into keyed object
        let data;
        if (results.length === 1) {
            data = results[0].result;
        }
        else {
            const merged = {};
            for (const r of results) {
                if (r.result != null)
                    merged[r.key] = r.result;
            }
            data = merged;
        }
        const formatter = FORMATTERS[app];
        if (formatter)
            return formatter(data);
        return formatGeneric(app, data);
    }
    catch {
        return null;
    }
}
// ── Service Intelligence handler ──────────────────────────────────────────────
/** Fetch tool list from a fabric app's /tools endpoint */
async function fetchToolList(service, port) {
    try {
        const res = await fetch(`http://${service}.fabric-sdk:${port}/tools/list`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok)
            return [];
        const data = (await res.json());
        return (data.tools ?? []).map((t) => t.name);
    }
    catch {
        return [];
    }
}
/** Call multiple tools from INSPECT_TOOLS in parallel, return merged keyed data */
async function fetchInspectData(service, port, app) {
    const toolSpecs = INSPECT_TOOLS[app] ?? [];
    const baseUrl = `http://${service}.fabric-sdk:${port}`;
    const results = await Promise.all(toolSpecs.map(async (spec) => {
        const result = await callFabricTool(baseUrl, spec.tool, spec.args ?? {});
        return { key: spec.key, result };
    }));
    const merged = {};
    for (const r of results) {
        if (r.result != null)
            merged[r.key] = r.result;
    }
    return merged;
}
/** Format inspect data into a readable block for the CURRENT STATUS section */
function formatInspectStatus(app, data) {
    // Use the existing formatter if available, otherwise generic
    const formatter = FORMATTERS[app];
    if (formatter)
        return formatter(data);
    return formatGeneric(app, data);
}
/** Resolve a fabric app key to its MOE_ROUTES entry for service/port info */
function getRouteForApp(app) {
    const route = MOE_ROUTES.find((r) => r.app === app);
    if (route)
        return { service: route.service, port: route.port };
    // Aiana and chat aren't in MOE_ROUTES but are in profiles
    const fallbacks = {
        aiana: { service: "fabric-aiana", port: 8200 },
        chat: { service: "fabric-chat", port: 8300 },
    };
    return fallbacks[app] ?? null;
}
/**
 * Handle a service intelligence query.
 * Returns the formatted response string, or null if not a service query.
 */
async function handleServiceIntel(content) {
    const query = parseServiceQuery(content);
    if (!query)
        return null;
    const { app, mode } = query;
    // ── Map mode: static dependency tree, no MCP calls ──────────────────────
    if (mode === "map") {
        return formatMap(app);
    }
    const route = getRouteForApp(app);
    // ── Overview mode: summary MCP data + tool list → structured briefing ───
    if (mode === "overview") {
        let liveData = null;
        let toolList = [];
        if (route) {
            [liveData, toolList] = await Promise.all([
                fetchFabricSummary(route.service, route.port, app, content),
                fetchToolList(route.service, route.port),
            ]);
        }
        return formatBriefing(app, liveData, toolList);
    }
    // ── Inspect mode: deep pull all tools → extended briefing ───────────────
    if (mode === "inspect") {
        let liveData = null;
        let toolList = [];
        if (route) {
            const [inspectData, tools] = await Promise.all([
                fetchInspectData(route.service, route.port, app),
                fetchToolList(route.service, route.port),
            ]);
            liveData = formatInspectStatus(app, inspectData);
            toolList = tools;
        }
        return formatBriefing(app, liveData, toolList);
    }
    return null;
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
// Fire-and-forget helper — runs async work without blocking the caller
function fireAndForget(fn) {
    fn().catch(() => { });
}
export async function sendMessage(adapter, sessionId, content, maxTokens = 8192) {
    const isOllama = !!process.env.OLLAMA_ENDPOINT;
    const hasFabricGateway = typeof adapter.listFabricTools === "function" &&
        typeof adapter.callFabricTool === "function";
    // ── Parallel: fetch session + pre-fetch fabric data simultaneously ────────
    // Only fetch last 20 messages for LLM context — no need to load entire history
    const sessionPromise = adapter.getSession(sessionId, 20);
    const prefetchPromise = isOllama
        ? (async () => {
            const detected = detectFabricApp(content);
            if (!detected)
                return null;
            try {
                return await fetchFabricSummary(detected.service, detected.port, detected.app, content);
            }
            catch {
                return null;
            }
        })()
        : Promise.resolve(null);
    const [session, fabricContext] = await Promise.all([sessionPromise, prefetchPromise]);
    if (session.state === "archived") {
        throw new Error(`Session ${sessionId} is archived. Resume it or create a new session.`);
    }
    // ── Service Intelligence short-circuit ─────────────────────────────────────
    const serviceIntelResponse = await handleServiceIntel(content);
    if (serviceIntelResponse) {
        fireAndForget(async () => {
            const userMsg = await adapter.addMessage({ sessionId, role: "user", content });
            await adapter.embedAndStore(userMsg);
            const assistantMsg = await adapter.addMessage({
                sessionId, role: "assistant", content: serviceIntelResponse,
                model: "deterministic", inputTokens: 0, outputTokens: 0,
            });
            await adapter.embedAndStore(assistantMsg);
        });
        return {
            messageId: sessionId,
            role: "assistant",
            content: serviceIntelResponse,
            inputTokens: 0,
            outputTokens: 0,
            model: session.model,
            routingLane: "deterministic",
        };
    }
    // ── Deterministic short-circuit: report without LLM ───────────────────────
    if (fabricContext && !needsLlmReasoning(content)) {
        fireAndForget(async () => {
            const userMsg = await adapter.addMessage({ sessionId, role: "user", content });
            await adapter.embedAndStore(userMsg);
            const assistantMsg = await adapter.addMessage({
                sessionId, role: "assistant", content: fabricContext,
                model: "deterministic", inputTokens: 0, outputTokens: 0,
            });
            await adapter.embedAndStore(assistantMsg);
        });
        return {
            messageId: sessionId,
            role: "assistant",
            content: fabricContext,
            inputTokens: 0,
            outputTokens: 0,
            model: session.model,
            routingLane: "deterministic",
        };
    }
    // ── Build history from session (already in memory) ────────────────────────
    const history = [
        ...session.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
            role: m.role,
            content: m.content,
        })),
    ];
    // Inject fabric context before the user message if we have it (question path)
    if (fabricContext) {
        history.push({
            role: "user",
            content: `Use this live data to answer the user's question. Only reference what's in the data — do not invent information.\n\n${fabricContext}`,
        });
    }
    history.push({ role: "user", content });
    // ── Store user message — fire and forget ──────────────────────────────────
    fireAndForget(async () => {
        const userMsg = await adapter.addMessage({ sessionId, role: "user", content });
        await adapter.embedAndStore(userMsg);
    });
    // ── LLM completion (the only blocking step the user waits for) ────────────
    let result;
    if (hasFabricGateway && !isOllama) {
        let fabricTools = [];
        try {
            const allTools = await adapter.listFabricTools();
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
    // ── Store assistant response — fire and forget ────────────────────────────
    fireAndForget(async () => {
        const assistantMsg = await adapter.addMessage({
            sessionId,
            role: "assistant",
            content: result.content,
            model: session.model,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
        });
        await adapter.embedAndStore(assistantMsg);
    });
    return {
        messageId: sessionId, // real ID is being stored async
        role: "assistant",
        content: result.content,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: session.model,
        routingLane: result.routingLane,
    };
}
// ── sendMessageStream (SSE streaming for Ollama) ─────────────────────────────
export async function* sendMessageStream(adapter, sessionId, content) {
    const ollamaConfig = createOllamaConfig();
    if (!ollamaConfig) {
        // Fall back to non-streaming — yield complete response at once
        const result = await sendMessage(adapter, sessionId, content);
        yield { token: result.content };
        yield { done: true, inputTokens: result.inputTokens, outputTokens: result.outputTokens, model: result.model };
        return;
    }
    // ── Parallel: fetch session + pre-fetch fabric data ────────────────────────
    const sessionPromise = adapter.getSession(sessionId, 20);
    const prefetchPromise = (async () => {
        const detected = detectFabricApp(content);
        if (!detected)
            return null;
        try {
            return await fetchFabricSummary(detected.service, detected.port, detected.app, content);
        }
        catch {
            return null;
        }
    })();
    const [session, fabricContext] = await Promise.all([sessionPromise, prefetchPromise]);
    if (session.state === "archived") {
        yield { error: `Session ${sessionId} is archived.` };
        return;
    }
    // ── Service Intelligence short-circuit ─────────────────────────────────────
    const serviceIntelResponse = await handleServiceIntel(content);
    if (serviceIntelResponse) {
        yield { token: serviceIntelResponse };
        yield { done: true, inputTokens: 0, outputTokens: 0, model: "deterministic" };
        fireAndForget(async () => {
            const userMsg = await adapter.addMessage({ sessionId, role: "user", content });
            await adapter.embedAndStore(userMsg);
            const assistantMsg = await adapter.addMessage({
                sessionId, role: "assistant", content: serviceIntelResponse,
                model: "deterministic", inputTokens: 0, outputTokens: 0,
            });
            await adapter.embedAndStore(assistantMsg);
        });
        return;
    }
    // ── Deterministic short-circuit: report without LLM ───────────────────────
    if (fabricContext && !needsLlmReasoning(content)) {
        // Yield the entire report as one token — instant response
        yield { token: fabricContext };
        yield { done: true, inputTokens: 0, outputTokens: 0, model: "deterministic" };
        fireAndForget(async () => {
            const userMsg = await adapter.addMessage({ sessionId, role: "user", content });
            await adapter.embedAndStore(userMsg);
            const assistantMsg = await adapter.addMessage({
                sessionId, role: "assistant", content: fabricContext,
                model: "deterministic", inputTokens: 0, outputTokens: 0,
            });
            await adapter.embedAndStore(assistantMsg);
        });
        return;
    }
    // ── Build history ──────────────────────────────────────────────────────────
    const history = [
        ...session.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role, content: m.content })),
    ];
    if (fabricContext) {
        history.push({
            role: "user",
            content: `Use this live data to answer the user's question. Only reference what's in the data — do not invent information.\n\n${fabricContext}`,
        });
    }
    history.push({ role: "user", content });
    // ── Store user message — fire and forget ──────────────────────────────────
    fireAndForget(async () => {
        const userMsg = await adapter.addMessage({ sessionId, role: "user", content });
        await adapter.embedAndStore(userMsg);
    });
    // ── Stream from Ollama ────────────────────────────────────────────────────
    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const chunk of ollamaCompleteStream(ollamaConfig, session.systemPrompt, history)) {
        if (chunk.token) {
            fullContent += chunk.token;
            yield { token: chunk.token };
        }
        if (chunk.done) {
            inputTokens = chunk.inputTokens ?? 0;
            outputTokens = chunk.outputTokens ?? 0;
        }
    }
    yield { done: true, inputTokens, outputTokens, model: ollamaConfig.model };
    // ── Store assistant response — fire and forget ────────────────────────────
    fireAndForget(async () => {
        const assistantMsg = await adapter.addMessage({
            sessionId,
            role: "assistant",
            content: fullContent,
            model: session.model,
            inputTokens,
            outputTokens,
        });
        await adapter.embedAndStore(assistantMsg);
    });
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