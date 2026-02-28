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

import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatAdapter,
  ChatMessage,
  ChatModel,
  CompletionMessage,
  FabricTool,
} from "../types.js";

export interface SendResult {
  messageId: string;
  role: "assistant";
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: ChatModel;
}

// ── Anthropic tool conversion ─────────────────────────────────────────────────

function fabricToolToAnthropic(tool: FabricTool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
  };
}

// ── Agentic loop with fabric tool_use ─────────────────────────────────────────

async function completeWithTools(
  anthropic: Anthropic,
  model: ChatModel,
  systemPrompt: string | undefined,
  history: Array<Anthropic.MessageParam>,
  tools: Anthropic.Tool[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  maxTokens: number,
): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  let totalInput = 0;
  let totalOutput = 0;
  let messages = [...history];

  // Up to 10 tool-call rounds to prevent infinite loops
  for (let round = 0; round < 10; round++) {
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools,
      messages,
    });

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;

    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      // Extract final text content
      const textBlock = response.content.find((b) => b.type === "text");
      const content = textBlock && textBlock.type === "text" ? textBlock.text : "";
      return { content, inputTokens: totalInput, outputTokens: totalOutput };
    }

    if (response.stop_reason === "tool_use") {
      // Append assistant message with tool use blocks
      messages.push({ role: "assistant", content: response.content });

      // Execute all tool calls in parallel
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          try {
            const result = await callTool(
              block.name,
              block.input as Record<string, unknown>,
            );
            return {
              type: "tool_result" as const,
              tool_use_id: block.id,
              content: JSON.stringify(result),
            };
          } catch (err) {
            return {
              type: "tool_result" as const,
              tool_use_id: block.id,
              is_error: true,
              content: `Tool error: ${String(err)}`,
            };
          }
        }),
      );

      // Append tool results and continue
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Unknown stop_reason — return whatever text we have
    const textBlock = response.content.find((b) => b.type === "text");
    const content = textBlock && textBlock.type === "text" ? textBlock.text : "";
    return { content, inputTokens: totalInput, outputTokens: totalOutput };
  }

  throw new Error("Agentic loop exceeded 10 rounds without finishing");
}

// ── sendMessage ───────────────────────────────────────────────────────────────

export async function sendMessage(
  adapter: ChatAdapter,
  sessionId: string,
  content: string,
  maxTokens = 8192,
): Promise<SendResult> {
  // Load session with current history
  const session = await adapter.getSession(sessionId);
  if (session.state === "archived") {
    throw new Error(
      `Session ${sessionId} is archived. Resume it or create a new session.`,
    );
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
  } catch {
    // Non-fatal: semantic search degrades gracefully
  }

  // Build message history for Anthropic
  const history: Anthropic.MessageParam[] = [
    ...session.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    { role: "user", content },
  ];

  // Determine if fabric tools are available
  const hasFabricGateway =
    typeof adapter.listFabricTools === "function" &&
    typeof adapter.callFabricTool === "function";

  let result: { content: string; inputTokens: number; outputTokens: number };

  if (hasFabricGateway) {
    // Fetch available tools from the gateway (best-effort — fall back to plain if fails)
    let fabricTools: FabricTool[] = [];
    try {
      fabricTools = await adapter.listFabricTools!();
    } catch {
      // Gateway unreachable — proceed without tools
    }

    if (fabricTools.length > 0) {
      const anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY!,
      });
      const anthropicTools = fabricTools.map(fabricToolToAnthropic);
      result = await completeWithTools(
        anthropic,
        session.model,
        session.systemPrompt,
        history,
        anthropicTools,
        (name, args) => adapter.callFabricTool!(name, args),
        maxTokens,
      );
    } else {
      // No tools loaded — fall back to plain completion
      result = await adapter.complete(
        history.map((m) => ({
          role: m.role as "user" | "assistant",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        })) as CompletionMessage[],
        { model: session.model, systemPrompt: session.systemPrompt, maxTokens },
      );
    }
  } else {
    // No gateway configured — plain completion
    result = await adapter.complete(
      history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })) as CompletionMessage[],
      { model: session.model, systemPrompt: session.systemPrompt, maxTokens },
    );
  }

  // Store assistant response
  const assistantMsg = await adapter.addMessage({
    sessionId,
    role: "assistant",
    content: result.content,
    model: session.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });

  // Embed and store assistant message (best-effort)
  try {
    await adapter.embedAndStore(assistantMsg);
  } catch {
    // Non-fatal
  }

  return {
    messageId: assistantMsg.id,
    role: "assistant",
    content: result.content,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    model: session.model,
  };
}

export async function listMessages(
  adapter: ChatAdapter,
  sessionId: string,
  limit = 50,
  offset = 0,
): Promise<ChatMessage[]> {
  return adapter.getMessages(sessionId, limit, offset);
}

export async function injectContext(
  adapter: ChatAdapter,
  sessionId: string,
  context: string,
  role: "system" | "user" = "system",
): Promise<{ messageId: string; sessionId: string; role: string }> {
  const msg = await adapter.addMessage({
    sessionId,
    role,
    content: context,
    metadata: { injected: true, injectedAt: new Date().toISOString() },
  });
  return { messageId: msg.id, sessionId, role };
}
