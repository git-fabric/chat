/**
 * Fabric gateway MCP client
 *
 * Thin HTTP client for the fabric-gateway MCP endpoint.
 * Handles JSON-RPC over SSE (StreamableHTTP transport).
 *
 * Two public functions:
 *   listTools(url)            — fetch all available tools
 *   callTool(url, name, args) — invoke a tool, unwrap content blocks
 *
 * Tool category pre-filter:
 *   selectRelevantTools(allTools, message, anthropic) — returns the subset of
 *   tools relevant to the user's message using a lightweight Haiku call.
 *   Caps tool list at MAX_TOOLS to keep context overhead manageable.
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import type { FabricTool } from "../types.js";

// Maximum tools to pass into the agentic loop — keeps context overhead low
const MAX_TOOLS = 40;

// ── Raw MCP request ───────────────────────────────────────────────────────────

async function mcpRequest(
  gatewayUrl: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const endpoint = gatewayUrl.replace(/\/$/, "") + "/mcp";
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Fabric gateway ${method} failed (${res.status}): ${text}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) throw new Error(`No data in SSE response for ${method}`);
    return JSON.parse(dataLine.slice(5).trim());
  }
  return res.json();
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function listTools(gatewayUrl: string): Promise<FabricTool[]> {
  const raw = (await mcpRequest(gatewayUrl, "tools/list")) as {
    result?: { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
    tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  };
  const tools = raw?.result?.tools ?? raw?.tools ?? [];
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as FabricTool["inputSchema"],
  }));
}

export async function callTool(
  gatewayUrl: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const raw = (await mcpRequest(gatewayUrl, "tools/call", { name, arguments: args })) as {
    result?: { content?: Array<{ type: string; text?: string }> };
    content?: Array<{ type: string; text?: string }>;
  };
  const contentBlocks = raw?.result?.content ?? raw?.content ?? [];
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) return raw;
  const textBlock = contentBlocks.find((b) => b.type === "text");
  if (!textBlock || !textBlock.text) return contentBlocks;
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return textBlock.text;
  }
}

// ── Tool pre-filter (change A) ────────────────────────────────────────────────
//
// Groups all tools by their prefix (k8s_, pve_, unifi_, etc.) and asks a fast
// Haiku call which categories are relevant to the user's message.
// Returns only tools from the relevant categories, capped at MAX_TOOLS.
// Falls back to all tools if the classification call fails.

export async function selectRelevantTools(
  allTools: FabricTool[],
  userMessage: string,
  anthropic: Anthropic,
): Promise<FabricTool[]> {
  if (allTools.length <= MAX_TOOLS) return allTools;

  // Build category map: prefix → tools[]
  const categoryMap = new Map<string, FabricTool[]>();
  for (const tool of allTools) {
    const prefix = tool.name.split("_")[0];
    if (!categoryMap.has(prefix)) categoryMap.set(prefix, []);
    categoryMap.get(prefix)!.push(tool);
  }

  // Build a compact category summary for classification
  const categorySummary = Array.from(categoryMap.entries())
    .map(([prefix, tools]) => `${prefix} (${tools.length} tools): ${tools.slice(0, 3).map((t) => t.name).join(", ")}${tools.length > 3 ? "..." : ""}`)
    .join("\n");

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 128,
      system:
        "You are a tool router. Given a user message and a list of tool categories, return ONLY the category prefixes that are relevant. Reply with a JSON array of strings, nothing else. Example: [\"k8s\",\"pve\"]",
      messages: [
        {
          role: "user",
          content: `Message: "${userMessage}"\n\nAvailable categories:\n${categorySummary}`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const text = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "[]";

    // Parse the JSON array — be tolerant of extra whitespace / markdown fences
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return allTools;

    const selectedPrefixes = JSON.parse(jsonMatch[0]) as string[];
    if (!Array.isArray(selectedPrefixes) || selectedPrefixes.length === 0) return allTools;

    // Always include fabric_ (health/routing meta-tools) and chat_
    const always = ["fabric", "chat"];
    const prefixSet = new Set([...always, ...selectedPrefixes]);

    const filtered: FabricTool[] = [];
    for (const [prefix, tools] of categoryMap) {
      if (prefixSet.has(prefix)) filtered.push(...tools);
    }

    // If filter returned nothing useful, fall back
    return filtered.length > 0 ? filtered : allTools;
  } catch {
    // Classification failed — pass all tools through
    return allTools;
  }
}
