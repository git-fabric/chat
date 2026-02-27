/**
 * Search layer
 *
 * Semantic search over conversation history using Qdrant vector search
 * and OpenAI text-embedding-3-small embeddings.
 *
 * Inputs:  ChatAdapter + query params
 * Outputs: SearchResult[] (ChatMessage + score)
 */
export async function search(adapter, query, opts) {
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
//# sourceMappingURL=search.js.map