#!/usr/bin/env node
/**
 * @git-fabric/chat CLI
 *
 * Standalone MCP server entry point.
 * - Set MCP_HTTP_PORT to run as a persistent HTTP server (in-cluster use)
 * - Unset MCP_HTTP_PORT to run on stdio (local/gateway use)
 */

import { createApp } from "../dist/app.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "node:http";

const app = createApp();

function buildServer() {
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

  return server;
}

const httpPort = process.env.MCP_HTTP_PORT ? Number(process.env.MCP_HTTP_PORT) : null;

if (httpPort) {
  // In-cluster mode: stateless StreamableHTTP on MCP_HTTP_PORT
  // SDK 1.26 stateless transport is single-use — create new transport+server per request
  const httpServer = createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.url === "/mcp" || req.url === "/") {
      // Read and parse the request body before handing to transport.
      // SDK 1.27+ expects parsedBody to be the already-parsed JSON object.
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let parsedBody;
      try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = undefined; }
      // SDK 1.27 requires Accept: application/json, text/event-stream on all MCP requests.
      // Hono (used inside StreamableHTTPServerTransport) builds Web Standard headers from
      // req.rawHeaders — the immutable socket-parsed array — not from req.headers.
      // We must patch both so the validation in webStandardStreamableHttp.js sees the value.
      const normalizedAccept = 'application/json, text/event-stream';
      req.headers['accept'] = normalizedAccept;
      const acceptIdx = req.rawHeaders.findIndex(
        (h, i) => i % 2 === 0 && h.toLowerCase() === 'accept'
      );
      if (acceptIdx !== -1) {
        req.rawHeaders[acceptIdx + 1] = normalizedAccept;
      } else {
        req.rawHeaders.push('accept', normalizedAccept);
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = buildServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }
    res.writeHead(404).end("not found");
  });

  httpServer.listen(httpPort, () => {
    console.log(`${app.name} MCP server listening on :${httpPort}`);
  });
} else {
  // Local/gateway mode: stdio
  const transport = new StdioServerTransport();
  const server = buildServer();
  await server.connect(transport);
}
