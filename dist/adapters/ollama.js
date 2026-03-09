/**
 * Ollama adapter
 *
 * Local LLM completions via Ollama REST API.
 * This is the "local-llm" routing lane — confidence >= floor but < 0.95.
 * No tokens are counted (local inference is free).
 */
export function createOllamaConfig() {
    const endpoint = process.env.OLLAMA_ENDPOINT;
    if (!endpoint)
        return null;
    return {
        endpoint: endpoint.replace(/\/$/, ""),
        model: process.env.OLLAMA_MODEL || "qwen2.5-coder:3b",
    };
}
export async function ollamaComplete(config, systemPrompt, messages) {
    const ollamaMessages = [];
    if (systemPrompt) {
        ollamaMessages.push({ role: "system", content: systemPrompt });
    }
    for (const m of messages) {
        if (m.role === "user" || m.role === "assistant") {
            ollamaMessages.push({ role: m.role, content: m.content });
        }
    }
    const res = await fetch(`${config.endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: config.model,
            messages: ollamaMessages,
            stream: false,
            keep_alive: "30m",
            options: { num_predict: 512 },
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama completion failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    return {
        content: data.message?.content ?? "",
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
        model: config.model,
        routingLane: "local-llm",
    };
}
export async function embedOllama(endpoint, model, text) {
    const res = await fetch(`${endpoint}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: text }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama embed failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    return data.embeddings[0];
}
export async function pingOllama(config) {
    const start = Date.now();
    try {
        const res = await fetch(`${config.endpoint}/`, { signal: AbortSignal.timeout(5000) });
        return { latencyMs: Date.now() - start, available: res.ok };
    }
    catch {
        return { latencyMs: Date.now() - start, available: false };
    }
}
//# sourceMappingURL=ollama.js.map