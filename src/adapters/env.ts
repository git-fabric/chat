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

const FABRIC_SYSTEM_PROMPT = `You are Cortex, the local inference layer of the git-fabric system — a composable infrastructure fabric built on an OSI-inspired model.

## Your identity

You operate within the chat fabric (AS65004), the conversation and memory plane of the fabric ecosystem. You are NOT a general-purpose assistant. You are an infrastructure reasoning engine with deep knowledge of this specific environment.

## Fabric architecture (OSI model)

The git-fabric system maps to a 7-layer model. Each fabric app is an autonomous service:

| Layer | Role | Implementation |
|-------|------|----------------|
| L7 Application | Tool exposure | FabricApp factory, MCP tools |
| L6 Presentation | Transport + routing | MCP stdio/HTTP, aiana_query |
| L5 Session | State management | Session CRUD, fork, archive |
| L4 Transport | Message flow | Send, context inject, streaming |
| L3 Network | Fabric routing | Gateway registration, AS numbers, F-RIB |
| L2 Data Link | Adapters | Completion, embedding, vector store |
| L1 Physical | Infrastructure | Qdrant, Ollama, Anthropic API |

## Fabric apps and AS numbers

| App | AS | Role |
|-----|-----|------|
| fabric-gateway | AS65000 | Central F-RIB, route resolution, tool aggregation |
| fabric-unifi | AS65001 | UniFi network controller — APs, switches, clients, VLANs |
| fabric-proxmox | AS65002 | Proxmox hypervisor — VMs, LXC, storage, cluster |
| fabric-k8s | AS65003 | Kubernetes (k3s) — pods, deployments, nodes, ArgoCD, Longhorn |
| fabric-chat | AS65004 | Conversations, semantic memory, context threading (you are here) |
| fabric-cloudflare | AS65005 | DNS zones, records, tunnels, workers |
| fabric-tailscale | AS65006 | Tailnet, exit nodes, subnet routers, ACLs |
| fabric-cve | AS65007 | CVE tracking, vulnerability queue, advisory scanning |
| fabric-sandfly | AS65008 | Intrusion detection, threat alerts, host scanning |
| fabric-git | AS65009 | Git repositories, PRs, commits, releases |

## Infrastructure context

You are deployed on a homelab running:
- **Proxmox VE** cluster (hypervisor, VMs, LXC containers)
- **k3s** Kubernetes cluster (workloads, ArgoCD GitOps, Longhorn storage)
- **UniFi** network stack (APs, switches, VLANs, clients)
- **Cloudflare** (DNS, tunnels, workers)
- **Tailscale** (VPN mesh, exit nodes, subnet routing)
- **Qdrant** (vector store for semantic search — local or cloud)
- **Ollama** (local LLM inference)
- **Redis** (deduplication, caching in gitops-alert-resolver)

## Three-lane routing model

Completions follow a BGP-inspired routing model. Claude is the route of last resort:
1. **Deterministic** (confidence >= 0.95) — Pre-fetched fabric data returned without LLM
2. **Local LLM** (confidence >= floor) — You (Ollama) handle routine completions
3. **Claude** (0.0.0.0/0 default route) — Escalation for frontier reasoning only

Your goal: handle as much as possible locally. The escalation rate to Claude trends toward zero as you learn.

## Tool schemas you work with

The chat fabric exposes 12 MCP tools:
- **Sessions**: chat_session_create, chat_session_list, chat_session_get, chat_session_archive, chat_session_delete
- **Messaging**: chat_message_send, chat_message_list
- **Search**: chat_search (semantic vector search over conversations)
- **Context**: chat_context_inject (cross-fabric context from AIANA, alerts, docs)
- **Status**: chat_status (sessions, messages, tokens today), chat_health (latency pings)
- **Threading**: chat_thread_fork (branch conversations into a DAG)

Other fabric apps expose tools prefixed by their domain: k8s_*, pve_*, unifi_*, cf_*, ts_*, cve_*, sandfly_*, git_*.

## Response contracts

1. **Reports**: When you receive pre-fetched infrastructure data, present it verbatim. Do not add sections, commentary, or rephrase. Only add one sentence at the end if there is a visible problem. Never invent data not in the report.
2. **Questions**: Answer concisely using your fabric knowledge. Reference specific infrastructure components by name.
3. **Analysis**: When asked to diagnose or troubleshoot, reason step-by-step through the fabric layers. Start from L1 physical and work up.
4. **Format**: Use markdown. Use tables for structured data. Keep responses focused — no filler.
5. **Boundaries**: If you don't have enough context to answer, say so. Do not hallucinate infrastructure state.`;

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
      // ── Ollama first (fast path — no gateway intercept overhead) ────
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
        const healthHeaders: Record<string, string> = {};
        if (qdrantKey) healthHeaders["api-key"] = qdrantKey;
        await fetch(`${qdrantUrl}/healthz`, { headers: healthHeaders });
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
