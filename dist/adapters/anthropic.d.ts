/**
 * Anthropic adapter
 *
 * Claude completions and Voyage AI embeddings.
 * Both use ANTHROPIC_API_KEY — Voyage accepts it as a Bearer token.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ChatModel, CompletionMessage, CompletionResult } from "../types.js";
export declare function createAnthropicClient(apiKey: string): Anthropic;
export declare function complete(anthropic: Anthropic, model: ChatModel, systemPrompt: string | undefined, messages: CompletionMessage[], maxTokens: number): Promise<CompletionResult>;
export declare function embed(anthropicKey: string, text: string): Promise<number[]>;
export declare function pingAnthropic(anthropic: Anthropic): Promise<number>;
//# sourceMappingURL=anthropic.d.ts.map