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
 *   OLLAMA_ENDPOINT     — Ollama endpoint for local-llm routing lane
 *   OLLAMA_MODEL        — Ollama model (default: qwen2.5-coder:3b)
 *   GATEWAY_URL         — Gateway /intercept endpoint for three-lane routing
 */

import { randomUUID } from "crypto";
import { createAnthropicClient, complete as anthropicComplete, embed as voyageEmbed, pingAnthropic } from "./anthropic.js";
import { createOllamaConfig, ollamaComplete, embedOllama, pingOllama } from "./ollama.js";
import {
  COLLECTION,
  ensureCollection,
  upsertPoint,
  upsertPointNoVec,
  setPayload,
  deleteByFilter,
  deleteById,
  search as qdrantSearch,
  scroll,
  getPoint,
  setEmbeddingDims,
} from "./qdrant.js";
import { listTools as gatewayListTools, callTool as gatewayCallTool, selectRelevantTools } from "./gateway.js";
import type {
  ChatAdapter,
  ChatSession,
  ChatMessage,
  ChatModel,
  CompletionMessage,
  CompletionResult,
  SearchResult,
  FabricTool,
  RoutingLane,
} from "../types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MODEL: ChatModel = "claude-sonnet-4-6";

// ── Default fabric system prompt ──────────────────────────────────────────────
// Applied when no systemPrompt is provided. Teaches the LLM about the fabric
// ecosystem so it can provide useful responses about infrastructure services.

const FABRIC_SYSTEM_PROMPT = `You are Cortex, a helpful infrastructure assistant for the git-fabric platform.
You have access to live infrastructure data from fabric services. When a user mentions a service, you receive live data automatically. Summarize it clearly and concisely.

## Fabric Services & Capabilities

### UniFi — Network Infrastructure (unifi_)
Manages UniFi network devices via the UI.com Cloud API.
Tools: unifi_health (API connectivity + device count), unifi_list_hosts (consoles/gateways), unifi_get_host (host details by ID), unifi_list_sites (all sites), unifi_get_site (site details), unifi_list_devices (APs, switches, gateways, PDUs — returns id, name, model, ip, status, mac, version, firmwareStatus), unifi_get_device (device details by ID or MAC), unifi_network_status (comprehensive: hosts + sites + all devices with online/offline counts), unifi_debug (raw API connectivity diagnostics).

### Proxmox — Virtualization (pve_)
Manages Proxmox VE hypervisors, VMs, LXC containers, and storage.
Tools: pve_cluster_status (overall cluster status + resources), pve_list_nodes (all cluster nodes), pve_get_node_status (node resource usage), pve_list_vms (VMs across nodes), pve_get_vm_config (VM configuration), pve_get_vm_status (VM current state), pve_start_vm, pve_stop_vm (force), pve_shutdown_vm (ACPI graceful), pve_reboot_vm, pve_list_containers (LXC on a node), pve_get_container_status, pve_start_container, pve_stop_container, pve_list_storage (cluster or per-node), pve_get_storage_status, pve_list_tasks (recent tasks), pve_get_task_status (by UPID), pve_list_vm_snapshots, pve_create_vm_snapshot, pve_delete_vm_snapshot.

### Kubernetes — Container Orchestration (k8s_)
Read-only access to the k3s cluster — pods, deployments, services, nodes, events, and more.
Tools: k8s_cluster_info (version, node/namespace/pod counts), k8s_list_namespaces, k8s_list_pods (by namespace), k8s_get_pod (containers, conditions, events), k8s_get_pod_logs (container logs), k8s_pod_problems (failing/crashing/not-ready pods), k8s_list_deployments, k8s_get_deployment (image, strategy, conditions), k8s_list_services, k8s_list_nodes (status, roles, version), k8s_get_node (capacity, allocatable, taints, conditions), k8s_list_events (cluster events, warnings), k8s_list_pvcs (PersistentVolumeClaims), k8s_list_cronjobs, k8s_list_jobs, k8s_list_ingress_routes (Traefik IngressRoutes), k8s_list_argocd_apps (ArgoCD sync/health status), k8s_get_argocd_app (ArgoCD app details + deploy history), k8s_list_scaled_objects (KEDA ScaledObjects), k8s_list_longhorn_volumes (Longhorn volume state + PVC).

### Cloudflare — DNS & CDN (cf_)
Manages Cloudflare zones, DNS records, cache, and Workers KV.
Tools: cf_list_zones (domains in account), cf_get_zone (zone details), cf_list_dns_records (DNS records for a zone), cf_create_dns_record, cf_update_dns_record, cf_delete_dns_record, cf_purge_cache (everything or specific files/tags/hosts), cf_list_kv_namespaces (Workers KV), cf_list_kv_keys, cf_read_kv_value, cf_write_kv_value, cf_delete_kv_value, cf_zone_analytics (requests, bandwidth, threats, pageviews).

### Tailscale — Mesh VPN (ts_)
Manages the Tailscale network: devices, DNS, ACLs, and auth keys.
Tools: ts_list_devices (all tailnet devices), ts_get_device (device details), ts_authorize_device, ts_set_device_tags (ACL tags), ts_get_device_routes (advertised + enabled routes), ts_set_device_routes (exit nodes, subnet routing), ts_delete_device, ts_get_dns (nameservers, MagicDNS, search paths, split DNS), ts_set_dns_nameservers, ts_set_magic_dns, ts_set_search_paths, ts_set_split_dns, ts_get_acl (current ACL policy), ts_validate_acl, ts_set_acl (WARNING: changes access rules), ts_list_keys (auth keys), ts_create_key, ts_delete_key, ts_health (device counts, authorized, exit nodes).

### CVE — Vulnerability Management (cve_)
Scans managed GitHub repos for vulnerabilities, enriches CVE data from NVD, triages and remediates.
Tools: cve_scan (scan repos via GitHub Advisory Database, append to queue), cve_enrich (fetch NVD details for a CVE ID), cve_batch (batch enrich + rank by severity, up to 20), cve_triage (process pending queue entries, apply severity policy, open PRs), cve_queue_list (list entries by status/severity), cve_queue_stats (dashboard: totals by status/severity, oldest pending, top repos), cve_queue_update (manually update entry status), cve_compact (remove old resolved entries).

### Sandfly — Linux Security (sandfly_)
Agentless Linux security scanning: intrusion detection, malware, rootkits, compliance.
Tools: sandfly_get_version, sandfly_get_license, sandfly_get_config, sandfly_list_hosts (managed hosts), sandfly_get_host (host details), sandfly_add_hosts, sandfly_delete_host, sandfly_get_host_processes (running processes), sandfly_get_host_users, sandfly_get_host_listeners (network listeners), sandfly_get_host_services, sandfly_get_host_scheduled_tasks (cron), sandfly_get_host_kernel_modules, sandfly_list_credentials (SSH creds), sandfly_add_credential, sandfly_delete_credential, sandfly_start_scan, sandfly_get_scan_errors, sandfly_get_results (with filters), sandfly_get_alerts (per-host alert/error/pass counts), sandfly_get_result (specific result), sandfly_get_host_result_summary, sandfly_delete_result, sandfly_list_sandflies (detection scripts), sandfly_get_sandfly, sandfly_activate_sandfly, sandfly_deactivate_sandfly, sandfly_list_schedules, sandfly_get_schedule, sandfly_add_schedule, sandfly_run_schedule, sandfly_pause_schedule, sandfly_unpause_schedule, sandfly_delete_schedule, sandfly_list_jump_hosts, sandfly_add_jump_host, sandfly_delete_jump_host, sandfly_list_notifications, sandfly_add_notification, sandfly_test_notification, sandfly_get_host_snapshot (full security snapshot), sandfly_get_scan_performance, sandfly_get_audit_log.

### Git — Source Control (git_)
GitHub API integration for repos, commits, branches, PRs, and file operations.
Tools: git_repo_list (repos for org/user), git_repo_get (repo details), git_repo_create, git_repo_delete (irreversible), git_file_get (file content), git_file_list (directory listing), git_commit_list (recent commits), git_commit_get (commit details + changed files), git_commit_compare (diff between refs), git_commit_push (commit files via Git Data API), git_branch_list, git_branch_create, git_branch_delete, git_branch_protect (protection rules), git_pr_list, git_pr_get (PR details + files + review state), git_pr_create, git_pr_merge.

### Aiana — Knowledge & Memory (aiana_)
Semantic memory system with vector search. Stores and recalls context across projects.
Tools: aiana_memory_search (semantic search over memories), aiana_memory_add (store a memory — scrubbed for secrets), aiana_memory_recall (recall memories for a project), aiana_memory_delete, aiana_memory_export (export all/by project), aiana_memory_import, aiana_session_list (sessions by project), aiana_preference_add (store user preference), aiana_memory_feedback (rate memory helpfulness), aiana_status (collection stats, per-project counts), aiana_health (Qdrant connectivity + latency).

### Chat — Conversation Management (chat_)
This service. Manages chat sessions, messages, semantic search over history.
Tools: chat_session_create, chat_session_list, chat_session_get, chat_session_archive, chat_session_delete, chat_message_send, chat_message_list, chat_search (semantic search), chat_context_inject, chat_status, chat_health, chat_thread_fork.

## Response Guidelines

When you receive live data from a fabric service:
1. Summarize the key metrics first (counts, health, status)
2. Highlight anything notable — offline devices, failing pods, pending vulnerabilities, alerts
3. Use bullet points and clear sections
4. Keep it concise — the user wants an operational overview, not raw JSON
5. If something looks wrong, call it out and suggest next steps

If you don't receive live data, describe what the service provides and what kind of reports are available.`;

// Qdrant payload _type discriminators
const TYPE_SESSION = "session";
const TYPE_MESSAGE = "message";

// ── Session payload helpers ───────────────────────────────────────────────────

function sessionToPayload(s: ChatSession): Record<string, unknown> {
  return { _type: TYPE_SESSION, ...s };
}

function payloadToSession(p: Record<string, unknown>): ChatSession {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _type, ...rest } = p;
  return rest as unknown as ChatSession;
}

// ── Message payload helpers ───────────────────────────────────────────────────

function messageToPayload(m: ChatMessage): Record<string, unknown> {
  return { _type: TYPE_MESSAGE, ...m };
}

function payloadToMessage(p: Record<string, unknown>): ChatMessage {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _type, ...rest } = p;
  return rest as unknown as ChatMessage;
}

// ── Token helpers ─────────────────────────────────────────────────────────────

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── createAdapterFromEnv ──────────────────────────────────────────────────────

export function createAdapterFromEnv(): ChatAdapter {
  const ollamaConfig = createOllamaConfig();
  const ollamaEndpoint = process.env.OLLAMA_ENDPOINT?.replace(/\/$/, "");
  const ollamaEmbedModel = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey && !ollamaEndpoint) throw new Error("ANTHROPIC_API_KEY required");

  const qdrantUrl = process.env.QDRANT_URL;
  if (!qdrantUrl) throw new Error("QDRANT_URL required");

  const qdrantKey = process.env.QDRANT_API_KEY ?? "";

  const fabricGatewayUrl = process.env.FABRIC_GATEWAY_URL ?? null;
  const gatewayUrl = process.env.GATEWAY_URL ?? null;

  if (ollamaEndpoint) {
    setEmbeddingDims(768);
  }

  const anthropic = anthropicKey ? createAnthropicClient(anthropicKey) : null;

  // Lazy collection bootstrap — runs once on first use
  let collectionReady = false;
  async function boot(): Promise<void> {
    if (collectionReady) return;
    await ensureCollection(qdrantUrl!, qdrantKey);
    collectionReady = true;
  }

  return {
    // ── Sessions ──────────────────────────────────────────────────────────────

    async createSession(opts) {
      await boot();
      const now = new Date().toISOString();
      const session: ChatSession = {
        id: randomUUID(),
        title: opts.title,
        project: opts.project,
        model: opts.model ?? DEFAULT_MODEL,
        systemPrompt: opts.systemPrompt ?? FABRIC_SYSTEM_PROMPT,
        state: "active",
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      };
      await upsertPointNoVec(qdrantUrl!, qdrantKey, session.id, sessionToPayload(session));
      return session;
    },

    async listSessions(opts) {
      await boot();
      const must: Record<string, unknown>[] = [
        { key: "_type", match: { value: TYPE_SESSION } },
      ];
      if (opts.state !== "all") {
        must.push({ key: "state", match: { value: opts.state } });
      }
      if (opts.project) {
        must.push({ key: "project", match: { value: opts.project } });
      }

      const result = await scroll(
        qdrantUrl!,
        qdrantKey,
        { must },
        opts.limit,
      );

      return result.points
        .map((p) => payloadToSession(p.payload))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async getSession(sessionId, messageLimit?: number) {
      await boot();
      const payload = await getPoint(qdrantUrl!, qdrantKey, sessionId);
      if (!payload) throw new Error(`Session not found: ${sessionId}`);
      const session = payloadToSession(payload);

      // Fetch recent messages — limit to last N for LLM context efficiency
      const limit = messageLimit ?? 1000;
      const msgResult = await scroll(
        qdrantUrl!,
        qdrantKey,
        { must: [
          { key: "_type", match: { value: TYPE_MESSAGE } },
          { key: "sessionId", match: { value: sessionId } },
        ]},
        limit,
      );
      const messages = msgResult.points
        .map((p) => payloadToMessage(p.payload))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      // If we hit the limit, only keep the most recent messages
      const trimmed = messages.length >= limit ? messages.slice(-limit) : messages;

      return { ...session, messages: trimmed };
    },

    async updateSession(sessionId, patch) {
      await boot();
      const payload = await getPoint(qdrantUrl!, qdrantKey, sessionId);
      if (!payload) throw new Error(`Session not found: ${sessionId}`);
      const current = payloadToSession(payload);
      const updated: ChatSession = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      await setPayload(qdrantUrl!, qdrantKey, sessionId, sessionToPayload(updated));
      return updated;
    },

    async deleteSession(sessionId) {
      await boot();
      // Delete session point
      await deleteById(qdrantUrl!, qdrantKey, sessionId);
      // Delete all message points for this session
      await deleteByFilter(qdrantUrl!, qdrantKey, {
        must: [
          { key: "_type", match: { value: TYPE_MESSAGE } },
          { key: "sessionId", match: { value: sessionId } },
        ],
      });
    },

    // ── Messages ──────────────────────────────────────────────────────────────

    async getMessages(sessionId, limit, offset) {
      await boot();
      const result = await scroll(
        qdrantUrl!,
        qdrantKey,
        { must: [
          { key: "_type", match: { value: TYPE_MESSAGE } },
          { key: "sessionId", match: { value: sessionId } },
        ]},
        limit + offset,
      );
      return result.points
        .map((p) => payloadToMessage(p.payload))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .slice(offset, offset + limit);
    },

    async addMessage(msg) {
      await boot();
      const message: ChatMessage = {
        ...msg,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
      };
      // Store message with zero vector (embedAndStore adds the real vector separately)
      await upsertPointNoVec(qdrantUrl!, qdrantKey, message.id, messageToPayload(message));

      // Update session stats inline — single setPayload call
      const sessionPayload = await getPoint(qdrantUrl!, qdrantKey, msg.sessionId);
      if (sessionPayload) {
        const s = payloadToSession(sessionPayload);
        const updatedSession: ChatSession = {
          ...s,
          messageCount: s.messageCount + 1,
          totalInputTokens: s.totalInputTokens + (msg.inputTokens ?? 0),
          totalOutputTokens: s.totalOutputTokens + (msg.outputTokens ?? 0),
          updatedAt: message.timestamp,
        };
        await setPayload(qdrantUrl!, qdrantKey, msg.sessionId, sessionToPayload(updatedSession));
      }

      return message;
    },

    // ── LLM (three-lane routing) ─────────────────────────────────────────────
    //
    // Lane 1: deterministic (>= 0.95) — gateway resolved with high confidence
    // Lane 2: local-llm (>= floor)    — Ollama handles routine completions
    // Lane 3: claude (< floor)         — Anthropic API, default route 0.0.0.0/0
    //
    // When GATEWAY_URL is set, we ask the gateway's /intercept endpoint first.
    // It consults the F-RIB, queries the authoritative fabric, and returns a
    // routing_lane + context. We use that to decide where to send the completion.
    //
    // When no gateway: try Ollama directly if configured, else fall through to Claude.

    async complete(messages, opts): Promise<CompletionResult> {
      const lastMessage = messages[messages.length - 1]?.content ?? "";

      // ── Gateway intercept (if available) ──────────────────────────
      if (gatewayUrl) {
        try {
          const interceptRes = await fetch(`${gatewayUrl}/intercept`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query_text: lastMessage,
              domain_hint: opts.systemPrompt ? "fabric.chat" : undefined,
              requestor_fabric_id: "fabric-chat",
            }),
            signal: AbortSignal.timeout(5000),
          });

          if (interceptRes.ok) {
            const intercept = await interceptRes.json() as {
              lane: RoutingLane;
              confidence: number;
              context?: string;
            };

            // Deterministic — gateway already has the answer
            if (intercept.lane === "deterministic" && intercept.context) {
              return {
                content: intercept.context,
                inputTokens: 0,
                outputTokens: 0,
                model: "gateway-deterministic",
                routingLane: "deterministic",
              };
            }

            // Local-LLM — use Ollama with injected context
            if (intercept.lane === "local-llm" && ollamaConfig) {
              const contextMessages: CompletionMessage[] = intercept.context
                ? [{ role: "system", content: `Context from fabric knowledge base:\n\n${intercept.context}` }, ...messages]
                : messages;
              try {
                const result = await ollamaComplete(ollamaConfig, opts.systemPrompt, contextMessages);
                return { ...result, routingLane: "local-llm" };
              } catch {
                // Ollama failed — fall through to Claude
              }
            }

            // Claude lane or Ollama unavailable — fall through with context injection
            if (intercept.context && anthropic) {
              const augmented: CompletionMessage[] = [
                { role: "system", content: `Context from fabric knowledge base:\n\n${intercept.context}` },
                ...messages,
              ];
              const result = await anthropicComplete(anthropic, opts.model, opts.systemPrompt, augmented, opts.maxTokens);
              return { ...result, routingLane: "claude" };
            }
          }
        } catch {
          // Gateway unreachable — fall through to direct routing
        }
      }

      // ── Direct Ollama (no gateway, but Ollama configured) ─────────
      if (ollamaConfig) {
        try {
          return await ollamaComplete(ollamaConfig, opts.systemPrompt, messages);
        } catch {
          if (!anthropic) throw new Error("Ollama completion failed and no Anthropic API key configured");
          // Ollama failed — fall through to Claude
        }
      }

      // ── Claude (default route 0.0.0.0/0) ──────────────────────────
      if (!anthropic) throw new Error("ANTHROPIC_API_KEY required for Claude completions");
      const result = await anthropicComplete(anthropic, opts.model, opts.systemPrompt, messages, opts.maxTokens);
      return { ...result, routingLane: "claude" };
    },

    // ── Semantic search ───────────────────────────────────────────────────────

    async embed(text) {
      if (ollamaEndpoint) {
        return embedOllama(ollamaEndpoint, ollamaEmbedModel, text);
      }
      return voyageEmbed(anthropicKey!, text);
    },

    async embedAndStore(message) {
      await boot();
      const vector = ollamaEndpoint
        ? await embedOllama(ollamaEndpoint, ollamaEmbedModel, message.content)
        : await voyageEmbed(anthropicKey!, message.content);
      // Upsert with real vector — overwrites the zero-vector placeholder
      await upsertPoint(qdrantUrl!, qdrantKey, {
        id: message.id,
        vector,
        payload: messageToPayload(message),
      });
    },

    async searchMessages(query, opts) {
      await boot();
      const must: Record<string, unknown>[] = [
        { key: "_type", match: { value: TYPE_MESSAGE } },
      ];
      if (opts.sessionId) must.push({ key: "sessionId", match: { value: opts.sessionId } });
      if (opts.project) must.push({ key: "project", match: { value: opts.project } });

      const results = await qdrantSearch(
        qdrantUrl!,
        qdrantKey,
        query,
        must.length > 1 ? { must } : { must: [must[0]] },
        opts.limit,
      );

      return results.map((r) => ({
        ...(payloadToMessage(r.payload) as ChatMessage),
        score: r.score,
      })) as SearchResult[];
    },

    // ── Stats / health ────────────────────────────────────────────────────────

    async getStats() {
      await boot();
      const today = isoToday();

      // Count sessions
      const sessionResult = await scroll(
        qdrantUrl!,
        qdrantKey,
        { must: [{ key: "_type", match: { value: TYPE_SESSION } }] },
        10000,
      );
      const sessions = sessionResult.points.map((p) => payloadToSession(p.payload));
      const totalSessions = sessions.length;
      const totalMessages = sessions.reduce((s, sess) => s + sess.messageCount, 0);
      const tokensToday = sessions
        .filter((s) => s.updatedAt.startsWith(today))
        .reduce((sum, s) => sum + s.totalInputTokens + s.totalOutputTokens, 0);

      return { totalSessions, totalMessages, tokensToday };
    },

    async health() {
      const anthropicLatency = anthropic ? await pingAnthropic(anthropic) : 0;

      const qdrantStart = Date.now();
      try {
        await fetch(`${qdrantUrl}/healthz`, { headers: { "api-key": qdrantKey } });
      } catch { /* measure regardless */ }
      const qdrantLatency = Date.now() - qdrantStart;

      const ollamaHealth = ollamaConfig ? await pingOllama(ollamaConfig) : undefined;

      return {
        anthropic: { latencyMs: anthropicLatency },
        qdrant: { latencyMs: qdrantLatency },
        ...(ollamaHealth ? { ollama: ollamaHealth } : {}),
      };
    },

    // ── Fabric gateway (optional) ─────────────────────────────────────────────

    ...(fabricGatewayUrl
      ? {
          async listFabricTools() {
            return gatewayListTools(fabricGatewayUrl);
          },
          async callFabricTool(name: string, args: Record<string, unknown>) {
            return gatewayCallTool(fabricGatewayUrl, name, args);
          },
        }
      : {}),
  } satisfies ChatAdapter;
}

// Re-export sub-adapters for direct use in tests / pipelines
export { selectRelevantTools };
export type { FabricTool };
