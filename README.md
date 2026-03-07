# @git-fabric/chat

Chat fabric app — conversation session management, semantic history search, and context threading.

Part of the [git-fabric](https://github.com/git-fabric) ecosystem.

## What it is

A fabric app for **conversation management** — create and manage chat sessions, persist conversation history to Qdrant (semantic search over past conversations), support multi-turn threading, and provide context injection from other fabric apps via the gateway.

This is the "conversation plane" of the fabric. It manages session state, message history, and semantic retrieval. Completions are routed through the fabric's three-lane model:

1. **Deterministic** (confidence >= 0.95) — session CRUD, message listing, stats answered directly by fabric tools
2. **Local LLM** (confidence >= floor) — Ollama inference for routine completions (planned)
3. **Claude** (default route, `0.0.0.0/0`) — complex completions requiring frontier-class reasoning

> **Current state**: Completions route directly to Anthropic API (Claude). Local LLM routing via Ollama is planned but not yet implemented. The adapter interface is designed for this — `ChatAdapter.complete()` is the seam where routing will be added.

## Tools

| Tool | Description |
|------|-------------|
| `chat_session_create` | Create a new chat session with optional system prompt, project, model, and title |
| `chat_session_list` | List recent sessions, filtered by project and state |
| `chat_session_get` | Get full session with message history |
| `chat_session_archive` | Mark a session as archived |
| `chat_session_delete` | Permanently delete a session and all its messages |
| `chat_message_send` | Send a message and get a completion response (full multi-turn context) |
| `chat_message_list` | List messages in a session with pagination |
| `chat_search` | Semantic search over all stored conversation content |
| `chat_context_inject` | Inject external context (e.g. Aiana memory recall) into a session |
| `chat_status` | Aggregate stats: total sessions, messages, tokens today |
| `chat_health` | Ping completion and vector backends, returns latency for each |
| `chat_thread_fork` | Fork a session at a message point to explore an alternative branch |

## Architecture

Follows the [git-fabric OSI model](https://github.com/git-fabric/sdk):

```
Layer 7 — Application    app.ts (FabricApp factory, 12 tools)
Layer 6 — Presentation   bin/cli.js (MCP stdio + HTTP, aiana_query)
Layer 5 — Session        layers/sessions.ts (CRUD, fork, archive)
Layer 4 — Transport      layers/messages.ts (send, context inject)
Layer 3 — Network        Gateway registration (AS65004, fabric.chat.*)
Layer 2 — Data Link      adapters/ (completion, embedding, vector store)
Layer 1 — Physical       Qdrant Cloud, Anthropic API
```

### Gateway registration

- **AS number**: 65004
- **Routes**: `fabric.chat`, `fabric.chat.sessions`, `fabric.chat.messages`, `fabric.chat.search`
- **aiana_query**: Maps natural language queries to live tools (sessions, search, status, health) with library fallback

### State storage

- **Sessions + messages** — Qdrant Cloud collection `chat_fabric__messages__v1` (1536-dim)
- **Semantic vectors** — Same Qdrant collection (text-embedding-3-small embeddings)
- **Completions** — Anthropic API (claude-sonnet-4-6 default, configurable per session)

### Library

Reference docs fetched on demand from git:
- `anthropics/anthropic-cookbook` — Claude API patterns and best practices

## Usage

### Via gateway (recommended)

The gateway discovers chat via registration. No manual configuration needed — chat advertises its routes and the gateway's F-RIB handles resolution.

### Standalone (HTTP)

```bash
MCP_HTTP_PORT=8204 \
ANTHROPIC_API_KEY=sk-ant-... \
QDRANT_URL=https://your-cluster.qdrant.io \
QDRANT_API_KEY=... \
npx @git-fabric/chat start
```

### Standalone (stdio)

```bash
ANTHROPIC_API_KEY=sk-ant-... \
QDRANT_URL=https://your-cluster.qdrant.io \
QDRANT_API_KEY=... \
npx @git-fabric/chat start
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for completions (default route) |
| `QDRANT_URL` | Yes | Qdrant instance URL (cloud or in-cluster) |
| `QDRANT_API_KEY` | No | Qdrant API key (omit for in-cluster no-auth) |
| `FABRIC_GATEWAY_URL` | No | Gateway MCP endpoint for cross-fabric tool calls |
| `MCP_HTTP_PORT` | No | HTTP server port (omit for stdio mode) |
| `GATEWAY_URL` | No | Gateway registration endpoint |
| `POD_IP` | No | Pod IP for gateway mcp_endpoint (default: 0.0.0.0) |
| `OLLAMA_ENDPOINT` | No | Ollama endpoint for local LLM routing (planned) |
| `OLLAMA_MODEL` | No | Ollama model for local inference (planned) |

## Routing roadmap

The completion path currently goes straight to Anthropic. The target architecture:

```
chat_message_send
  → adapter.complete()
    → deterministic check (cached answers, FAQ)     — confidence >= 0.95
    → local LLM (Ollama, qwen2.5-coder:3b)          — confidence >= floor
    → Claude (Anthropic API)                         — default route (0.0.0.0/0)
```

This matches the fabric-sdk BGP routing model: Claude is the route of last resort with lowest local preference. As the AIANA feedback loop indexes Claude's answers back into the knowledge base, the escalation rate to Claude trends toward zero.

## License

MIT
