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
import type {
  ChatAdapter,
  ChatMessage,
  ChatModel,
  CompletionMessage,
  FabricTool,
  RoutingLane,
} from "../types.js";

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
] as const;

function detectFabricApp(message: string): typeof MOE_ROUTES[number] | null {
  const lower = message.toLowerCase();
  let best: { route: typeof MOE_ROUTES[number]; score: number } | null = null;
  for (const route of MOE_ROUTES) {
    let score = 0;
    for (const kw of route.keywords) {
      if (lower.includes(kw)) score += route.priority;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { route, score };
    }
  }
  return best ? best.route : null;
}

/** Default summary tool for each fabric app (used for bare app name queries) */
const SUMMARY_TOOLS: Record<string, string> = {
  unifi: "unifi_network_status",
  proxmox: "pve_cluster_status",
  k8s: "k8s_cluster_info",
  cloudflare: "cf_list_zones",
  tailscale: "ts_health",
  cve: "cve_queue_stats",
  sandfly: "sandfly_get_alerts",
  git: "git_repo_list",
};

/** Specific query patterns → tool mappings for targeted questions */
const SPECIFIC_QUERIES: Array<{ pattern: RegExp; app: string; tool: string; args?: Record<string, unknown> }> = [
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

/** Determine which tool to call based on the user message */
function selectTool(app: string, message: string): { tool: string; args: Record<string, unknown> } {
  // Check for specific query patterns first
  for (const q of SPECIFIC_QUERIES) {
    if (q.app === app && q.pattern.test(message)) {
      return { tool: q.tool, args: q.args ?? {} };
    }
  }
  // Fall back to default summary tool
  return { tool: SUMMARY_TOOLS[app] ?? `${app}_health`, args: {} };
}

// ── Pre-formatters: turn raw JSON into readable reports ─────────────────────
// The 3b model is bad at parsing JSON. Do the heavy lifting in code.

type AnyRecord = Record<string, unknown>;

function formatUnifi(data: AnyRecord): string {
  const summary = data.summary as AnyRecord | undefined;
  const devices = data.devices as AnyRecord[] | undefined;
  if (!summary || !devices) return JSON.stringify(data, null, 2);

  const devSummary = summary.devices as AnyRecord | undefined;
  const lines: string[] = [
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
    for (const d of offline) lines.push(`- **${d.name}** (${d.model}) is offline — MAC: ${d.mac}`);
  }

  return lines.join("\n");
}

function formatProxmox(data: unknown): string {
  if (!Array.isArray(data)) return JSON.stringify(data, null, 2);
  const lines = ["## Proxmox Cluster Report", ""];
  for (const node of data) {
    const n = node as AnyRecord;
    lines.push(`- **${n.node ?? n.name}** — status: ${n.status ?? "unknown"}, type: ${n.type ?? "?"}`);
  }
  return lines.join("\n");
}

function formatK8s(data: AnyRecord): string {
  const lines = [
    "## Kubernetes Cluster Report",
    "",
    `- **Server version:** ${data.serverVersion ?? "?"}`,
    `- **Nodes:** ${data.nodeCount ?? "?"}`,
    `- **Namespaces:** ${data.namespaceCount ?? "?"}`,
    `- **Pods:** ${data.podCount ?? "?"}`,
  ];
  if (data.nodes && Array.isArray(data.nodes)) {
    lines.push("", "### Nodes");
    for (const n of data.nodes as AnyRecord[]) {
      lines.push(`- **${n.name}** — ${n.status ?? "?"}, ${n.roles ?? "worker"}, ${n.kubeletVersion ?? ""}`);
    }
  }
  return lines.join("\n");
}

function formatTailscale(data: AnyRecord): string {
  const lines = [
    "## Tailscale Network Report",
    "",
    `- **Total devices:** ${data.totalDevices ?? data.devices ?? "?"}`,
    `- **Authorized:** ${data.authorized ?? "?"}`,
    `- **Exit nodes:** ${data.exitNodes ?? "?"}`,
  ];
  return lines.join("\n");
}

function formatGeneric(app: string, data: unknown): string {
  const title = app.charAt(0).toUpperCase() + app.slice(1);
  if (Array.isArray(data)) {
    const lines = [`## ${title} Report`, "", `**${data.length} items**`, ""];
    for (const item of data.slice(0, 20)) {
      const i = item as AnyRecord;
      const name = i.name ?? i.full_name ?? i.id ?? "?";
      const desc = i.description ?? i.status ?? "";
      lines.push(`- **${name}**${desc ? ` — ${desc}` : ""}`);
    }
    if (data.length > 20) lines.push(`- ... and ${data.length - 20} more`);
    return lines.join("\n");
  }
  return `## ${title} Report\n\n${JSON.stringify(data, null, 2)}`;
}

const FORMATTERS: Record<string, (data: unknown) => string> = {
  unifi: (d) => formatUnifi(d as AnyRecord),
  proxmox: (d) => formatProxmox(d),
  k8s: (d) => formatK8s(d as AnyRecord),
  tailscale: (d) => formatTailscale(d as AnyRecord),
};

/** Fetch live data from a fabric app, pre-format into a readable report */
async function fetchFabricSummary(
  service: string,
  port: number,
  app: string,
  message: string,
): Promise<string | null> {
  const baseUrl = `http://${service}.fabric-sdk:${port}`;
  const { tool, args } = selectTool(app, message);

  try {
    const callRes = await fetch(`${baseUrl}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: tool, arguments: args }),
      signal: AbortSignal.timeout(15000),
    });
    if (!callRes.ok) return null;
    const result = await callRes.json();

    // Pre-format the data so the LLM doesn't have to parse JSON
    const formatter = FORMATTERS[app];
    if (formatter) return formatter(result);
    return formatGeneric(app, result);
  } catch {
    return null;
  }
}

export interface SendResult {
  messageId: string;
  role: "assistant";
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: ChatModel;
  routingLane?: RoutingLane;
}

// ── Anthropic tool conversion ─────────────────────────────────────────────────

function fabricToolToAnthropic(tool: FabricTool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
  };
}

// ── Agentic loop with fabric tool_use ─────────────────────────────────────────

async function completeWithTools(
  anthropic: Anthropic,
  model: ChatModel,
  systemPrompt: string | undefined,
  history: Array<Anthropic.MessageParam>,
  tools: Anthropic.Tool[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  maxTokens: number,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
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

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      // Max chars per tool result (~50k chars ≈ 12k tokens) to stay inside context limit
      const MAX_RESULT_CHARS = 50_000;

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          try {
            const result = await callTool(block.name, block.input as Record<string, unknown>);
            let content = JSON.stringify(result);
            if (content.length > MAX_RESULT_CHARS) {
              content = content.slice(0, MAX_RESULT_CHARS) + `\n...[truncated — ${content.length - MAX_RESULT_CHARS} chars omitted]`;
            }
            return {
              type: "tool_result" as const,
              tool_use_id: block.id,
              content,
            };
          } catch (err) {
            return {
              type: "tool_result" as const,
              tool_use_id: block.id,
              is_error: true,
              content: `Tool error: ${String(err)}`,
            };
          }
        }),
      );

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
function fireAndForget(fn: () => Promise<unknown>): void {
  fn().catch(() => {});
}

export async function sendMessage(
  adapter: ChatAdapter,
  sessionId: string,
  content: string,
  maxTokens = 8192,
): Promise<SendResult> {
  const isOllama = !!process.env.OLLAMA_ENDPOINT;
  const hasFabricGateway =
    typeof adapter.listFabricTools === "function" &&
    typeof adapter.callFabricTool === "function";

  // ── Parallel: fetch session + pre-fetch fabric data simultaneously ────────
  // Only fetch last 20 messages for LLM context — no need to load entire history
  const sessionPromise = adapter.getSession(sessionId, 20);
  const prefetchPromise = isOllama
    ? (async () => {
        const detected = detectFabricApp(content);
        if (!detected) return null;
        try {
          return await fetchFabricSummary(detected.service, detected.port, detected.app, content);
        } catch { return null; }
      })()
    : Promise.resolve(null);

  const [session, fabricContext] = await Promise.all([sessionPromise, prefetchPromise]);

  if (session.state === "archived") {
    throw new Error(`Session ${sessionId} is archived. Resume it or create a new session.`);
  }

  // ── Build history from session (already in memory) ────────────────────────
  const history: Anthropic.MessageParam[] = [
    ...session.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
  ];

  // Inject fabric context before the user message if we have it
  if (fabricContext) {
    const detected = detectFabricApp(content)!;
    history.push({
      role: "user",
      content: `Here is the live ${detected.app} report. Present this to the user as-is, adding brief commentary on anything notable (offline devices, issues, warnings). Do not list tool names.\n\n${fabricContext}`,
    });
  }

  history.push({ role: "user", content });

  // ── Store user message — fire and forget ──────────────────────────────────
  fireAndForget(async () => {
    const userMsg = await adapter.addMessage({ sessionId, role: "user", content });
    await adapter.embedAndStore(userMsg);
  });

  // ── LLM completion (the only blocking step the user waits for) ────────────
  let result: { content: string; inputTokens: number; outputTokens: number; routingLane?: RoutingLane };

  if (hasFabricGateway && !isOllama) {
    let fabricTools: FabricTool[] = [];
    try {
      const allTools = await adapter.listFabricTools!();
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
      fabricTools = await selectRelevantTools(allTools, content, anthropic);
    } catch {
      // Gateway unreachable or filter failed — proceed without tools
    }

    if (fabricTools.length > 0) {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
      result = await completeWithTools(
        anthropic,
        session.model,
        session.systemPrompt,
        history,
        fabricTools.map(fabricToolToAnthropic),
        (name, args) => adapter.callFabricTool!(name, args),
        maxTokens,
      );
    } else {
      result = await adapter.complete(
        history.map((m) => ({
          role: m.role as "user" | "assistant",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        })) as CompletionMessage[],
        { model: session.model, systemPrompt: session.systemPrompt, maxTokens },
      );
    }
  } else {
    result = await adapter.complete(
      history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })) as CompletionMessage[],
      { model: session.model, systemPrompt: session.systemPrompt, maxTokens },
    );
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
    messageId: sessionId,  // real ID is being stored async
    role: "assistant",
    content: result.content,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    model: session.model,
    routingLane: result.routingLane,
  };
}

export async function listMessages(
  adapter: ChatAdapter,
  sessionId: string,
  limit = 50,
  offset = 0,
): Promise<ChatMessage[]> {
  return adapter.getMessages(sessionId, limit, offset);
}

export async function injectContext(
  adapter: ChatAdapter,
  sessionId: string,
  context: string,
  role: "system" | "user" = "system",
): Promise<{ messageId: string; sessionId: string; role: string }> {
  const msg = await adapter.addMessage({
    sessionId,
    role,
    content: context,
    metadata: { injected: true, injectedAt: new Date().toISOString() },
  });
  return { messageId: msg.id, sessionId, role };
}
