/**
 * Anthropic adapter
 *
 * Claude completions and Voyage AI embeddings.
 * Both use ANTHROPIC_API_KEY — Voyage accepts it as a Bearer token.
 */
import Anthropic from "@anthropic-ai/sdk";
const EMBEDDING_MODEL = "voyage-3-lite";
// ── Completions ───────────────────────────────────────────────────────────────
export function createAnthropicClient(apiKey) {
    return new Anthropic({ apiKey });
}
export async function complete(anthropic, model, systemPrompt, messages, maxTokens) {
    const userAssistantMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
    const response = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: userAssistantMessages,
    });
    const textBlock = response.content.find((b) => b.type === "text");
    const content = textBlock && textBlock.type === "text" ? textBlock.text : "";
    return {
        content,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model,
    };
}
// ── Embeddings ────────────────────────────────────────────────────────────────
export async function embed(anthropicKey, text) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${anthropicKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: [text], model: EMBEDDING_MODEL }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Voyage embed failed (${res.status}): ${body}`);
    }
    const data = (await res.json());
    return data.data[0].embedding;
}
// ── Health ping ───────────────────────────────────────────────────────────────
export async function pingAnthropic(anthropic) {
    const start = Date.now();
    try {
        await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
        });
    }
    catch {
        // Measure latency even on error
    }
    return Date.now() - start;
}
//# sourceMappingURL=anthropic.js.map