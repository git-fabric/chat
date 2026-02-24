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

export async function search(
  adapter: ChatAdapter,
  query: string,
  opts: {
    project?: string;
    sessionId?: string;
    limit?: number;
  },
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 10;

  // Embed the query text
  const queryVector = await adapter.embed(query);

  // Search Qdrant
  return adapter.searchMessages(queryVector, {
    project: opts.project,
    sessionId: opts.sessionId,
    limit,
  });
}
