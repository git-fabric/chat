/**
 * Ollama adapter
 *
 * Local LLM completions via Ollama REST API.
 * This is the "local-llm" routing lane — confidence >= floor but < 0.95.
 * No tokens are counted (local inference is free).
 */
import type { CompletionMessage, CompletionResult } from "../types.js";
export interface OllamaConfig {
    endpoint: string;
    model: string;
}
export declare function createOllamaConfig(): OllamaConfig | null;
export declare function ollamaComplete(config: OllamaConfig, systemPrompt: string | undefined, messages: CompletionMessage[]): Promise<CompletionResult>;
export declare function embedOllama(endpoint: string, model: string, text: string): Promise<number[]>;
export declare function pingOllama(config: OllamaConfig): Promise<{
    latencyMs: number;
    available: boolean;
}>;
//# sourceMappingURL=ollama.d.ts.map