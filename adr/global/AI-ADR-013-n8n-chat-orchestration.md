# AI-ADR-013: n8n as Chat Orchestration Layer

**Status:** Proposed
**Date:** 2026-03-12
**Author:** Ryan / ry-ops.dev
**Scope:** Global — affects fabric-chat architecture
**Depends On:** AI-ADR-012 (Agent Classification Taxonomy), AI-ADR-006 (Agent Permission Boundaries)

## Context

`fabric-chat` has grown into a sophisticated integration orchestrator: 12 MCP tools,
multi-turn conversations with Claude + Ollama, Qdrant vector search, Redis caching,
gateway registration, a service intelligence briefing system, MoE keyword routing,
deterministic short-circuits, agentic tool_use loops, and SSE streaming — all in
~2,500 lines of TypeScript across `messages.ts`, `service-intel.ts`, `cli.js`, and
supporting adapters.

The problem is **integration complexity has outgrown code-only orchestration**:

1. **Routing logic is invisible.** The three-lane routing model (deterministic →
   local-llm → Claude) is spread across `needsLlmReasoning()`, `detectFabricApp()`,
   `selectTools()`, and conditional branches in `sendMessage()`. Understanding the
   full decision path requires reading 400+ lines across multiple functions.

2. **Tool call chains are hard to reason about.** The agentic loop
   (`completeWithTools`) handles up to 10 rounds of tool_use, with pre-filtering
   via Haiku classification, parallel tool fetching, result truncation, and error
   recovery — all encoded procedurally.

3. **Adding new fabric integrations requires code changes.** Every new app needs
   entries in `MOE_ROUTES`, `SUMMARY_TOOLS`, `SPECIFIC_QUERIES`, `FORMATTERS`,
   and potentially `INSPECT_TOOLS`. This is a code-change-per-integration model
   that doesn't scale.

4. **Claude Code cannot carry the architectural vision.** The full mental model of
   how sessions, messages, routing, gateway tools, streaming, and service-intel
   interact is too complex to convey in instructions. Each session starts fresh
   without retained understanding of the system's behavioral intent.

## Decision

**Adopt n8n as the orchestration layer for fabric-chat.** Move integration logic,
routing decisions, and tool call chains from TypeScript into n8n workflows. Retain
TypeScript for domain logic that n8n cannot express (service-intel profiles,
formatters, Qdrant adapter).

### What moves to n8n

| Current code | n8n workflow |
|---|---|
| `sendMessage()` routing logic | **Main Chat Workflow** — Switch node branches by routing lane |
| `detectFabricApp()` + `MOE_ROUTES` | **MoE Router** — Switch node with keyword conditions |
| `completeWithTools()` agentic loop | **Agentic Tool Loop** — AI Agent node with tool sub-workflows |
| `fetchFabricSummary()` tool calls | **Fabric Data Fetch** — HTTP Request nodes per app |
| `sendMessageStream()` SSE | **Stream Workflow** — Webhook trigger + respond with streaming |
| `registerWithGateway()` + keepalive | **Gateway Registration** — Cron-triggered HTTP workflow |
| `bin/cli.js` HTTP server | n8n webhook endpoints replace custom HTTP server |
| `selectRelevantTools()` Haiku filter | **Tool Filter** — AI node for classification |

### What stays as code

| Component | Reason |
|---|---|
| `service-intel.ts` (944 lines) | Pure domain logic — deterministic profiles, not integration |
| `adapters/qdrant.ts` | Vector store operations — n8n's Qdrant node covers basics, but our schema is custom |
| `adapters/anthropic.ts` embeddings | Voyage AI embedding — stays as utility service |
| `types.ts` | Shared types for any remaining TypeScript services |
| Formatters (`formatUnifi`, etc.) | Report generation — could become n8n Code nodes or stay as API |

### Architecture: before and after

**Before (current):**
```
User → cli.js HTTP → sendMessage() → [routing logic] → Claude/Ollama
                                    → [gateway tools] → fabric-*
                                    → [service-intel]  → deterministic
                   → Qdrant (store)
                   → Redis (cache)
```

**After (proposed):**
```
User → n8n Webhook → Main Chat Workflow
                      ├─ Switch: Service Intel? → Code node (service-intel)
                      ├─ Switch: Deterministic? → Fabric Data sub-workflow → Format → Respond
                      ├─ Switch: Local LLM?     → Ollama node → Respond
                      └─ Default: Claude        → AI Agent node (with tool sub-workflows)
                                                    ├─ Tool: fabric-k8s   → HTTP Request
                                                    ├─ Tool: fabric-unifi → HTTP Request
                                                    └─ Tool: fabric-*    → HTTP Request
                   → Qdrant node (store embeddings)
                   → Redis node (cache)
```

### n8n deployment model

n8n runs as a container in the existing fabric-sdk namespace alongside other fabric
apps. It receives the same environment variables (`ANTHROPIC_API_KEY`, `QDRANT_URL`,
etc.) and can reach fabric services via internal DNS (`fabric-k8s.fabric-sdk:8200`).

Gateway registration shifts from code to an n8n workflow triggered on startup +
30-second cron — same HTTP calls, visual and editable.

### MCP compatibility

n8n exposes webhook endpoints that map to the current MCP tool interface:
- `POST /webhook/chat/tools/call` → routes to appropriate sub-workflow
- `POST /webhook/chat/stream` → SSE streaming workflow

The gateway registers against these n8n endpoints instead of the Node.js server.
Alternatively, a thin MCP shim (< 50 lines) can translate MCP protocol to n8n
webhook calls, preserving full MCP compatibility for other fabric apps.

### Quadrant classification (per AI-ADR-012)

n8n itself operates as a **Quadrant II agent** (High Capability, Low Risk):
- Non-deterministic routing decisions
- Touches non-sensitive conversation data
- Ephemeral workflow executions
- Governed by n8n's built-in audit logging

Individual tool sub-workflows inherit the quadrant of their target fabric app
(e.g., k8s read = Quadrant III, k8s write = Quadrant IV with human-in-the-loop).

## Migration strategy

### Phase 1: Parallel run
- Deploy n8n alongside existing fabric-chat
- Build the Main Chat Workflow in n8n
- Route a subset of traffic through n8n via feature flag
- Compare outputs between TypeScript and n8n paths

### Phase 2: n8n primary
- n8n handles all chat orchestration
- TypeScript services reduced to:
  - Service-intel API (Express/Fastify, ~100 lines wrapper)
  - Qdrant adapter API (if n8n's built-in node is insufficient)
- Gateway registration points to n8n webhooks

### Phase 3: Cleanup
- Remove `messages.ts` routing logic, `cli.js` HTTP server
- Retain `service-intel.ts` and `qdrant.ts` as microservices
- Archive old orchestration code

## Security controls

- n8n credentials store manages API keys (Anthropic, Qdrant, Redis)
- Webhook endpoints are internal-only (ClusterIP, no Ingress)
- n8n execution logs provide audit trail for all workflow runs
- Tool sub-workflows respect AI-ADR-012 quadrant boundaries
- Human-in-the-loop for Quadrant IV actions enforced via n8n approval nodes

## Consequences

**Positive:**
- Routing logic becomes visual, debuggable, and editable without code deploys
- Adding a new fabric integration = adding an HTTP Request node, not modifying 5 files
- Ryan can build and iterate on chat flows directly in n8n UI
- n8n's built-in AI Agent node handles the agentic tool_use loop natively
- Workflow execution history provides observability for free
- Reduces the "Claude Code can't carry the vision" problem — the vision lives in
  visual workflows, not in instructions to an AI

**Negative:**
- Introduces n8n as a new runtime dependency
- Some TypeScript logic needs thin API wrappers to be callable from n8n
- n8n's Code nodes are JavaScript (not TypeScript) — type safety is reduced
- Workflow versioning is JSON-based, not as git-friendly as source code
- Learning curve for n8n workflow design patterns

**Mitigations:**
- n8n workflows can be exported as JSON and stored in git for version control
- Critical domain logic stays in TypeScript (service-intel, Qdrant adapter)
- n8n community edition is self-hosted — no vendor lock-in on the orchestration layer

## References

- AI-ADR-012: Agent Classification Taxonomy
- AI-ADR-006: Agent Permission Boundaries
- n8n documentation: https://docs.n8n.io
- n8n AI Agent node: https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/
- Source: Architecture pivot discussion (2026-03-12)
