/**
 * Sessions layer
 *
 * Session lifecycle: create, list, get, archive, delete, fork.
 * All state is delegated to the ChatAdapter (GitHub + Qdrant).
 *
 * Inputs:  ChatAdapter + session params
 * Outputs: ChatSession objects
 */
import type { ChatAdapter, ChatSession, ChatModel } from "../types.js";
export declare function createSession(adapter: ChatAdapter, opts: {
    systemPrompt?: string;
    project?: string;
    model?: ChatModel;
    title?: string;
}): Promise<{
    sessionId: string;
    createdAt: string;
}>;
export declare function listSessions(adapter: ChatAdapter, opts: {
    project?: string;
    limit?: number;
    state?: "active" | "archived" | "all";
}): Promise<ChatSession[]>;
export declare function getSession(adapter: ChatAdapter, sessionId: string): Promise<ChatSession & {
    messages: import("../types.js").ChatMessage[];
}>;
export declare function archiveSession(adapter: ChatAdapter, sessionId: string): Promise<{
    sessionId: string;
    archived: true;
}>;
export declare function deleteSession(adapter: ChatAdapter, sessionId: string): Promise<{
    sessionId: string;
    deleted: true;
}>;
export declare function forkSession(adapter: ChatAdapter, sessionId: string, forkFromMessageId: string, title?: string): Promise<{
    newSessionId: string;
}>;
//# sourceMappingURL=sessions.d.ts.map