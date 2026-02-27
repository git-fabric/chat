/**
 * @git-fabric/chat — shared types
 *
 * ChatAdapter interface decouples layers from any specific
 * Anthropic / Qdrant / GitHub client implementation.
 * Consumers provide concrete adapters at runtime.
 */
export type ChatModel = "claude-opus-4-6" | "claude-sonnet-4-6" | "claude-haiku-4-5-20251001";
export interface ChatSession {
    id: string;
    title?: string;
    project?: string;
    model: ChatModel;
    systemPrompt?: string;
    state: "active" | "archived";
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
}
export interface ChatMessage {
    id: string;
    sessionId: string;
    role: "user" | "assistant" | "system";
    content: string;
    model?: ChatModel;
    inputTokens?: number;
    outputTokens?: number;
    timestamp: string;
    metadata?: Record<string, unknown>;
}
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
export interface SearchResult extends ChatMessage {
    score: number;
}
export interface ChatStats {
    totalSessions: number;
    totalMessages: number;
    tokensToday: number;
}
export interface ChatHealth {
    anthropic: {
        latencyMs: number;
    };
    qdrant: {
        latencyMs: number;
    };
}
export interface SessionIndexEntry {
    id: string;
    title?: string;
    project?: string;
    state: "active" | "archived";
    createdAt: string;
    updatedAt: string;
    messageCount: number;
}
export interface ChatAdapter {
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
    getSession(sessionId: string): Promise<ChatSession & {
        messages: ChatMessage[];
    }>;
    updateSession(sessionId: string, patch: Partial<Pick<ChatSession, "state" | "title">>): Promise<ChatSession>;
    deleteSession(sessionId: string): Promise<void>;
    getMessages(sessionId: string, limit: number, offset: number): Promise<ChatMessage[]>;
    addMessage(msg: Omit<ChatMessage, "id" | "timestamp">): Promise<ChatMessage>;
    complete(messages: CompletionMessage[], opts: {
        model: ChatModel;
        systemPrompt?: string;
        maxTokens: number;
    }): Promise<CompletionResult>;
    embedAndStore(message: ChatMessage): Promise<void>;
    searchMessages(query: number[], opts: {
        project?: string;
        sessionId?: string;
        limit: number;
    }): Promise<SearchResult[]>;
    embed(text: string): Promise<number[]>;
    getStats(): Promise<ChatStats>;
    health(): Promise<ChatHealth>;
}
//# sourceMappingURL=types.d.ts.map