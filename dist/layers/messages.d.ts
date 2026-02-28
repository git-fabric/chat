/**
 * Messages layer
 *
 * Message send/receive: complete a turn, list messages, inject context.
 * Handles full Anthropic API round-trip with session history reconstruction.
 * When a fabric gateway is configured, uses Claude tool_use to query live
 * infrastructure data (k8s, unifi, proxmox, sandfly, cve, cloudflare, tailscale).
 *
 * Inputs:  ChatAdapter + message params
 * Outputs: ChatMessage objects / send results
 */
import type { ChatAdapter, ChatMessage, ChatModel } from "../types.js";
export interface SendResult {
    messageId: string;
    role: "assistant";
    content: string;
    inputTokens: number;
    outputTokens: number;
    model: ChatModel;
}
export declare function sendMessage(adapter: ChatAdapter, sessionId: string, content: string, maxTokens?: number): Promise<SendResult>;
export declare function listMessages(adapter: ChatAdapter, sessionId: string, limit?: number, offset?: number): Promise<ChatMessage[]>;
export declare function injectContext(adapter: ChatAdapter, sessionId: string, context: string, role?: "system" | "user"): Promise<{
    messageId: string;
    sessionId: string;
    role: string;
}>;
//# sourceMappingURL=messages.d.ts.map