/**
 * @git-fabric/chat — shared types
 *
 * ChatAdapter interface decouples layers from any specific
 * Anthropic / Qdrant / GitHub client implementation.
 * Consumers provide concrete adapters at runtime.
 */

// ── Domain types ─────────────────────────────────────────────────────────────

export type ChatModel =
  | "claude-opus-4-6"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5-20251001";

export interface ChatSession {
  id: string;             // UUID v4
  title?: string;
  project?: string;
  model: ChatModel;
  systemPrompt?: string;
  state: "active" | "archived";
  createdAt: string;      // ISO-8601
  updatedAt: string;      // ISO-8601
  messageCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface ChatMessage {
  id: string;             // UUID v4
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  model?: ChatModel;      // set on assistant messages
  inputTokens?: number;   // set on assistant messages
  outputTokens?: number;  // set on assistant messages
  timestamp: string;      // ISO-8601
  metadata?: Record<string, unknown>;
}

// ── Completion types ─────────────────────────────────────────────────────────

export interface CompletionMessage {
  role: string;
  content: string;
}

export interface CompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: ChatModel;
}

// ── Search types ─────────────────────────────────────────────────────────────

export interface SearchResult extends ChatMessage {
  score: number;
}

// ── Stats / health types ─────────────────────────────────────────────────────

export interface ChatStats {
  totalSessions: number;
  totalMessages: number;
  tokensToday: number;
}

export interface ChatHealth {
  anthropic: { latencyMs: number };
  qdrant: { latencyMs: number };
}

// ── Index entry (fast listing without reading all session files) ──────────────

export interface SessionIndexEntry {
  id: string;
  title?: string;
  project?: string;
  state: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

// ── Fabric gateway types ──────────────────────────────────────────────────────

export interface FabricToolSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface FabricTool {
  name: string;
  description: string;
  inputSchema: FabricToolSchema;
}

export interface FabricToolResult {
  toolName: string;
  result: unknown;
  error?: string;
}

// ── Adapter interface ────────────────────────────────────────────────────────

export interface ChatAdapter {
  // Session CRUD
  createSession(opts: {
    systemPrompt?: string;
    project?: string;
    model?: ChatModel;
    title?: string;
  }): Promise<ChatSession>;

  listSessions(opts: {
    project?: string;
    limit: number;
    state: "active" | "archived" | "all";
  }): Promise<ChatSession[]>;

  getSession(sessionId: string): Promise<ChatSession & { messages: ChatMessage[] }>;

  updateSession(
    sessionId: string,
    patch: Partial<Pick<ChatSession, "state" | "title">>,
  ): Promise<ChatSession>;

  deleteSession(sessionId: string): Promise<void>;

  // Messages
  getMessages(
    sessionId: string,
    limit: number,
    offset: number,
  ): Promise<ChatMessage[]>;

  addMessage(msg: Omit<ChatMessage, "id" | "timestamp">): Promise<ChatMessage>;

  // LLM
  complete(
    messages: CompletionMessage[],
    opts: { model: ChatModel; systemPrompt?: string; maxTokens: number },
  ): Promise<CompletionResult>;

  // Semantic search
  embedAndStore(message: ChatMessage): Promise<void>;
  searchMessages(
    query: number[],
    opts: { project?: string; sessionId?: string; limit: number },
  ): Promise<SearchResult[]>;
  embed(text: string): Promise<number[]>;

  // Stats / health
  getStats(): Promise<ChatStats>;
  health(): Promise<ChatHealth>;

  // Fabric gateway (optional — present when FABRIC_GATEWAY_URL is configured)
  listFabricTools?(): Promise<FabricTool[]>;
  callFabricTool?(name: string, args: Record<string, unknown>): Promise<unknown>;
}
