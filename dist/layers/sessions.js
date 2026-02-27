/**
 * Sessions layer
 *
 * Session lifecycle: create, list, get, archive, delete, fork.
 * All state is delegated to the ChatAdapter (GitHub + Qdrant).
 *
 * Inputs:  ChatAdapter + session params
 * Outputs: ChatSession objects
 */
export async function createSession(adapter, opts) {
    const session = await adapter.createSession(opts);
    return { sessionId: session.id, createdAt: session.createdAt };
}
export async function listSessions(adapter, opts) {
    return adapter.listSessions({
        project: opts.project,
        limit: opts.limit ?? 20,
        state: opts.state ?? "active",
    });
}
export async function getSession(adapter, sessionId) {
    return adapter.getSession(sessionId);
}
export async function archiveSession(adapter, sessionId) {
    await adapter.updateSession(sessionId, { state: "archived" });
    return { sessionId, archived: true };
}
export async function deleteSession(adapter, sessionId) {
    await adapter.deleteSession(sessionId);
    return { sessionId, deleted: true };
}
export async function forkSession(adapter, sessionId, forkFromMessageId, title) {
    // Load original session with full history
    const original = await adapter.getSession(sessionId);
    // Find the fork point — include messages up to and including forkFromMessageId
    const forkIndex = original.messages.findIndex((m) => m.id === forkFromMessageId);
    if (forkIndex === -1) {
        throw new Error(`Message ${forkFromMessageId} not found in session ${sessionId}`);
    }
    const messagesUpToFork = original.messages.slice(0, forkIndex + 1);
    // Create new session with same config
    const forked = await adapter.createSession({
        systemPrompt: original.systemPrompt,
        project: original.project,
        model: original.model,
        title: title ?? `Fork of ${original.title ?? sessionId} at ${forkFromMessageId.slice(0, 8)}`,
    });
    // Replay messages into the new session
    for (const msg of messagesUpToFork) {
        await adapter.addMessage({
            sessionId: forked.id,
            role: msg.role,
            content: msg.content,
            model: msg.model,
            inputTokens: msg.inputTokens,
            outputTokens: msg.outputTokens,
            metadata: msg.metadata,
        });
    }
    return { newSessionId: forked.id };
}
//# sourceMappingURL=sessions.js.map