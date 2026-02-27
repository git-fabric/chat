/**
 * Search layer
 *
 * Semantic search over conversation history using Qdrant vector search
 * and OpenAI text-embedding-3-small embeddings.
 *
 * Inputs:  ChatAdapter + query params
 * Outputs: SearchResult[] (ChatMessage + score)
 */
import type { ChatAdapter, SearchResult } from "../types.js";
export declare function search(adapter: ChatAdapter, query: string, opts: {
    project?: string;
    sessionId?: string;
    limit?: number;
}): Promise<SearchResult[]>;
//# sourceMappingURL=search.d.ts.map