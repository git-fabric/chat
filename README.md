# @git-fabric/chat

Chat fabric app — AI conversation sessions, semantic history search, and context threading as a composable MCP layer.

Part of the [git-fabric](https://github.com/git-fabric) ecosystem.

## What it is

A fabric app for **AI conversation management** — create and manage chat sessions with Claude, persist conversation history to Qdrant Cloud (semantic search over past conversations), support multi-turn threading, and provide context injection from external memory sources (e.g. Aiana).

This is the "conversation plane" of the fabric. Consumers (cortex agents, Claude Desktop, Claude Code via git-steer) use these tools to interact with Claude across sessions.

## Tools

| Tool | Description |
|------|-------------|
| `chat_session_create` | Create a new chat session with optional system prompt, project, model, and title |
| `chat_session_list` | List recent sessions, filtered by project and state |
| `chat_session_get` | Get full session with message history |
| `chat_session_archive` | Mark a session as archived |
| `chat_session_delete` | Permanently delete a session and all its messages |
| `chat_message_send` | Send a message and get a Claude response (full multi-turn context) |
| `chat_message_list` | List messages in a session with pagination |
| `chat_search` | Semantic search over all stored conversation content |
| `chat_context_inject` | Inject external context (e.g. Aiana memory recall) into a session |
| `chat_status` | Aggregate stats: total sessions, messages, tokens today |
| `chat_health` | Ping Anthropic and Qdrant, returns latency for each |
| `chat_thread_fork` | Fork a session at a message point to explore an alternative branch |

## Architecture

Follows the [git-fabric layered pattern](https://github.com/git-fabric/gateway):

```
Detection / Query  →  layers/sessions.ts, layers/search.ts (reads)
Action             →  layers/messages.ts, layers/sessions.ts (effectful)
Adapter            →  adapters/env.ts (Anthropic + OpenAI + Qdrant + GitHub)
Surface            →  app.ts (FabricApp factory)
```

### State storage

- **Sessions + messages** → GitHub repo `ry-ops/git-steer-state` (same state repo as git-steer)
  - Session metadata: `chat/sessions/{sessionId}.json`
  - Message history: `chat/sessions/{sessionId}/messages.jsonl` (JSONL, one message per line)
  - Fast listing index: `chat/index.json`
- **Semantic vectors** → Qdrant Cloud collection `chat_fabric__messages__v1` (1536-dim, text-embedding-3-small)
- **Completions** → Anthropic API (claude-sonnet-4-6 default, configurable per session)

## Usage

### Via gateway (recommended)

```yaml
# gateway.yaml
apps:
  - name: "@git-fabric/chat"
    enabled: true
```

### Standalone MCP server

```bash
ANTHROPIC_API_KEY=sk-ant-... \
OPENAI_API_KEY=sk-... \
QDRANT_URL=https://your-cluster.qdrant.io \
QDRANT_API_KEY=... \
GITHUB_TOKEN=ghp_... \
npx @git-fabric/chat
```

### Programmatic

```typescript
import { createApp } from "@git-fabric/chat";

const app = createApp();
// app.tools, app.health(), etc.
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude completions |
| `OPENAI_API_KEY` | Yes | OpenAI API key for text-embedding-3-small |
| `QDRANT_URL` | Yes | Qdrant Cloud cluster URL |
| `QDRANT_API_KEY` | Yes | Qdrant Cloud API key |
| `GITHUB_TOKEN` | Yes | GitHub PAT for state repo read/write |
| `GITHUB_STATE_REPO` | No | State repo (default: `ry-ops/git-steer-state`) |

## Models

| Model | ID |
|-------|----|
| Claude Opus 4.6 | `claude-opus-4-6` |
| Claude Sonnet 4.6 (default) | `claude-sonnet-4-6` |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` |

## License

MIT
