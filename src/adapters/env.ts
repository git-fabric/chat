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
import { createOllamaConfig, ollamaComplete, pingOllama } from "./ollama.js";
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
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY required");

  const qdrantUrl = process.env.QDRANT_URL;
  if (!qdrantUrl) throw new Error("QDRANT_URL required");

  const qdrantKey = process.env.QDRANT_API_KEY ?? "";

  const fabricGatewayUrl = process.env.FABRIC_GATEWAY_URL ?? null;
  const gatewayUrl = process.env.GATEWAY_URL ?? null;
  const ollamaConfig = createOllamaConfig();

  const anthropic = createAnthropicClient(anthropicKey);

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
        systemPrompt: opts.systemPrompt,
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

    async getSession(sessionId) {
      await boot();
      const payload = await getPoint(qdrantUrl!, qdrantKey, sessionId);
      if (!payload) throw new Error(`Session not found: ${sessionId}`);
      const session = payloadToSession(payload);

      // Fetch messages ordered by timestamp
      const msgResult = await scroll(
        qdrantUrl!,
        qdrantKey,
        { must: [
          { key: "_type", match: { value: TYPE_MESSAGE } },
          { key: "sessionId", match: { value: sessionId } },
        ]},
        1000,
      );
      const messages = msgResult.points
        .map((p) => payloadToMessage(p.payload))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      return { ...session, messages };
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
            if (intercept.context) {
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
          // Ollama failed — fall through to Claude
        }
      }

      // ── Claude (default route 0.0.0.0/0) ──────────────────────────
      const result = await anthropicComplete(anthropic, opts.model, opts.systemPrompt, messages, opts.maxTokens);
      return { ...result, routingLane: "claude" };
    },

    // ── Semantic search ───────────────────────────────────────────────────────

    async embed(text) {
      return voyageEmbed(anthropicKey, text);
    },

    async embedAndStore(message) {
      await boot();
      const vector = await voyageEmbed(anthropicKey, message.content);
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
      const anthropicLatency = await pingAnthropic(anthropic);

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
