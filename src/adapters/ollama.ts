/**
 * Ollama adapter
 *
 * Local LLM completions via Ollama REST API.
 * This is the "local-llm" routing lane — confidence >= floor but < 0.95.
 * No tokens are counted (local inference is free).
 */

import type { CompletionMessage, CompletionResult } from "../types.js";

export interface OllamaConfig {
  endpoint: string;  // e.g. http://ollama.fabric-sdk:11434
  model: string;     // e.g. qwen2.5-coder:3b
}

export function createOllamaConfig(): OllamaConfig | null {
  const endpoint = process.env.OLLAMA_ENDPOINT;
  if (!endpoint) return null;
  return {
    endpoint: endpoint.replace(/\/$/, ""),
    model: process.env.OLLAMA_MODEL || "qwen2.5-coder:3b",
  };
}

export async function ollamaComplete(
  config: OllamaConfig,
  systemPrompt: string | undefined,
  messages: CompletionMessage[],
): Promise<CompletionResult> {
  const ollamaMessages: { role: string; content: string }[] = [];

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
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama completion failed (${res.status}): ${text}`);
  }

  const data = await res.json() as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };

  return {
    content: data.message?.content ?? "",
    inputTokens: data.prompt_eval_count ?? 0,
    outputTokens: data.eval_count ?? 0,
    model: config.model,
    routingLane: "local-llm",
  };
}

export async function pingOllama(config: OllamaConfig): Promise<{ latencyMs: number; available: boolean }> {
  const start = Date.now();
  try {
    const res = await fetch(`${config.endpoint}/api/tags`, { signal: AbortSignal.timeout(5000) });
    return { latencyMs: Date.now() - start, available: res.ok };
  } catch {
    return { latencyMs: Date.now() - start, available: false };
  }
}
