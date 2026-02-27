/**
 * Messages layer
 *
 * Message send/receive: complete a turn, list messages, inject context.
 * Handles full Anthropic API round-trip with session history reconstruction.
 *
 * Inputs:  ChatAdapter + message params
 * Outputs: ChatMessage objects / send results
 */
export async function sendMessage(adapter, sessionId, content, maxTokens = 8192) {
    // Load session with current history
    const session = await adapter.getSession(sessionId);
    if (session.state === "archived") {
        throw new Error(`Session ${sessionId} is archived. Resume it or create a new session.`);
    }
    // Store the user message first
    const userMsg = await adapter.addMessage({
        sessionId,
        role: "user",
        content,
    });
    // Embed and store user message in Qdrant (best-effort)
    try {
        await adapter.embedAndStore(userMsg);
    }
    catch {
        // Non-fatal: semantic search degrades gracefully
    }
    // Build message history for Anthropic
    // Include all prior messages + the new user message
    const history = [
        ...session.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content },
    ];
    // Complete
    const result = await adapter.complete(history, {
        model: session.model,
        systemPrompt: session.systemPrompt,
        maxTokens,
    });
    // Store assistant response
    const assistantMsg = await adapter.addMessage({
        sessionId,
        role: "assistant",
        content: result.content,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
    });
    // Embed and store assistant message (best-effort)
    try {
        await adapter.embedAndStore(assistantMsg);
    }
    catch {
        // Non-fatal
    }
    return {
        messageId: assistantMsg.id,
        role: "assistant",
        content: result.content,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        model: result.model,
    };
}
export async function listMessages(adapter, sessionId, limit = 50, offset = 0) {
    return adapter.getMessages(sessionId, limit, offset);
}
export async function injectContext(adapter, sessionId, context, role = "system") {
    const msg = await adapter.addMessage({
        sessionId,
        role,
        content: context,
        metadata: { injected: true, injectedAt: new Date().toISOString() },
    });
    return { messageId: msg.id, sessionId, role };
}
//# sourceMappingURL=messages.js.map