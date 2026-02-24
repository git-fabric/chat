#!/usr/bin/env node
/**
 * @git-fabric/chat CLI
 *
 * Standalone MCP server entry point.
 * Runs the git-fabric/chat app directly via the gateway MCP server pattern.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *   OPENAI_API_KEY=sk-... \
 *   QDRANT_URL=https://... \
 *   QDRANT_API_KEY=... \
 *   GITHUB_TOKEN=ghp_... \
 *   fabric-chat
 *
 * Or register via gateway.yaml:
 *   apps:
 *     - name: "@git-fabric/chat"
 *       enabled: true
 */

import { createApp } from "../dist/app.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const app = createApp();

const server = new Server(
  { name: app.name, version: app.version },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: app.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = app.tools.find((t) => t.name === req.params.name);
  if (!tool) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      isError: true,
    };
  }
  try {
    const result = await tool.execute(req.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: String(e) }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
