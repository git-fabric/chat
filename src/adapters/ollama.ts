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

/** Scale num_predict based on the last user message length.
 *  Short inputs (greetings, single words) → 128 tokens max
 *  Medium inputs (questions)              → 512 tokens max
 *  Long inputs (analysis, multi-context)  → 1024 tokens max */
function adaptiveNumPredict(messages: CompletionMessage[]): number {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return 512;
  const len = lastUser.content.length;
  if (len < 20) return 128;
  if (len < 200) return 512;
  return 1024;
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
      keep_alive: "30m",
      options: { num_predict: adaptiveNumPredict(messages) },
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

export async function* ollamaCompleteStream(
  config: OllamaConfig,
  systemPrompt: string | undefined,
  messages: CompletionMessage[],
): AsyncGenerator<{ token?: string; done?: boolean; inputTokens?: number; outputTokens?: number }> {
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
      stream: true,
      keep_alive: "30m",
      options: { num_predict: adaptiveNumPredict(messages) },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama stream failed (${res.status}): ${text}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!; // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line) as {
        message?: { content?: string };
        done?: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
      };

      if (chunk.done) {
        yield {
          done: true,
          inputTokens: chunk.prompt_eval_count ?? 0,
          outputTokens: chunk.eval_count ?? 0,
        };
      } else if (chunk.message?.content) {
        yield { token: chunk.message.content };
      }
    }
  }
}

export async function embedOllama(
  endpoint: string,
  model: string,
  text: string,
): Promise<number[]> {
  const res = await fetch(`${endpoint}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embed failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { embeddings: number[][] };
  return data.embeddings[0];
}

export async function pingOllama(config: OllamaConfig): Promise<{ latencyMs: number; available: boolean }> {
  const start = Date.now();
  try {
    const res = await fetch(`${config.endpoint}/`, { signal: AbortSignal.timeout(5000) });
    return { latencyMs: Date.now() - start, available: res.ok };
  } catch {
    return { latencyMs: Date.now() - start, available: false };
  }
}
