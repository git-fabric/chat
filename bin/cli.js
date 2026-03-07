#!/usr/bin/env node
import { createApp } from "../dist/app.js";
import { Library } from "../dist/library.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "node:http";

const app = createApp();
const library = new Library();

function buildServer() {
  const server = new Server({ name: app.name, version: app.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: app.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = app.tools.find((t) => t.name === req.params.name);
    if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }], isError: true };
    try {
      const result = await tool.execute(req.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: String(e) }], isError: true };
    }
  });
  return server;
}

// ── Gateway registration ─────────────────────────────────────────────────────

const GATEWAY_URL = process.env.GATEWAY_URL;
const MCP_HTTP_PORT = process.env.MCP_HTTP_PORT ? Number(process.env.MCP_HTTP_PORT) : null;
const POD_IP = process.env.POD_IP || "0.0.0.0";

let sessionToken = null;

async function registerWithGateway() {
  if (!GATEWAY_URL) return;
  const mcpEndpoint = `http://${POD_IP}:${MCP_HTTP_PORT || 8200}/mcp`;
  const body = {
    fabric_id: "fabric-chat",
    as_number: 65004,
    version: app.version,
    mcp_endpoint: mcpEndpoint,
    ollama_endpoint: process.env.OLLAMA_ENDPOINT || "http://ollama.fabric-sdk:11434",
    ollama_model: process.env.OLLAMA_MODEL || "qwen2.5-coder:3b",
    supervisor: "standalone",
    tailscale_node: "fabric-chat",
    worker_pool: { total: 0, healthy: 0, workers: [] },
    routes: [
      { prefix: "fabric.chat", local_pref: 100, confidence_floor: 0.7, description: "AI conversation sessions, semantic search, context threading" },
      { prefix: "fabric.chat.sessions", local_pref: 100, confidence_floor: 0.7, description: "Session management — create, list, archive, delete" },
      { prefix: "fabric.chat.messages", local_pref: 100, confidence_floor: 0.7, description: "Messaging — send, list, context injection" },
      { prefix: "fabric.chat.search", local_pref: 100, confidence_floor: 0.7, description: "Semantic search over conversation history" },
    ],
  };
  try {
    const res = await fetch(`${GATEWAY_URL}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    if (data.ok) { sessionToken = data.session_token; console.log(`[fabric-chat] Registered with gateway: ${sessionToken} (${data.routes_accepted} routes)`); }
    else console.warn(`[fabric-chat] Registration rejected: ${JSON.stringify(data)}`);
  } catch (err) { console.warn(`[fabric-chat] Gateway registration failed (standalone mode): ${err.message}`); }
}

async function sendKeepalive() {
  if (!GATEWAY_URL || !sessionToken) return;
  try {
    const res = await fetch(`${GATEWAY_URL}/keepalive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fabric_id: "fabric-chat", session_token: sessionToken, worker_pool: { total: 0, healthy: 0, workers: [] }, timestamp: Math.floor(Date.now() / 1000) }) });
    if (res.status === 401) { console.log("[fabric-chat] Session expired — re-registering"); sessionToken = null; await registerWithGateway(); }
  } catch {}
}

// ── Server startup ───────────────────────────────────────────────────────────

const httpPort = MCP_HTTP_PORT;

if (httpPort) {
  const httpServer = createServer(async (req, res) => {
    if (req.url === "/healthz" || req.url === "/health") {
      const h = await app.health();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(h));
      return;
    }
    if (req.url === "/tools") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(app.tools.map((t) => ({ name: t.name, description: t.description }))));
      return;
    }
    if ((req.url === "/mcp/tools/call" || req.url === "/tools/call") && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      if (body.name === "aiana_query") {
        const queryText = (body.arguments?.query_text || "").toLowerCase();
        try {
          let context = "";
          let confidence = 0;
          let source = "chat-api";

          if (/\b(session|conversation)s?\b.*\b(list|show|get|active)\b/.test(queryText)) {
            const sessions = await app.tools.find(t => t.name === "chat_session_list")?.execute({});
            context = JSON.stringify(sessions, null, 2);
            confidence = 0.95;
          } else if (/\b(search|find|look)\b.*\b(message|conversation|chat)\b/.test(queryText)) {
            const query = queryText.replace(/\b(search|find|look)\b.*\b(for|in|through)\b\s*/i, "");
            const results = await app.tools.find(t => t.name === "chat_search")?.execute({ query });
            context = JSON.stringify(results, null, 2);
            confidence = 0.85;
          } else if (/\b(status|stat|quota|token|usage)\b/.test(queryText)) {
            const status = await app.tools.find(t => t.name === "chat_status")?.execute({});
            context = JSON.stringify(status, null, 2);
            confidence = 0.9;
          } else if (/\b(health|ping|check)\b/.test(queryText)) {
            const health = await app.tools.find(t => t.name === "chat_health")?.execute({});
            context = JSON.stringify(health, null, 2);
            confidence = 0.95;
          } else {
            const libraryResult = await library.query(queryText);
            if (libraryResult && libraryResult.context) {
              context = libraryResult.context;
              confidence = libraryResult.confidence;
              source = "library";
              console.log(`[fabric-chat] Library hit: ${libraryResult.sources.join(", ")}`);
            } else {
              const status = await app.tools.find(t => t.name === "chat_status")?.execute({});
              context = JSON.stringify(status, null, 2);
              confidence = 0.5;
            }
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ context, confidence, source }));
        } catch (err) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ context: `Error querying chat: ${err.message}`, confidence: 0 }));
        }
        return;
      }

      const tool = app.tools.find((t) => t.name === body.name);
      if (!tool) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: `Tool not found: ${body.name}` })); return; }
      try {
        const result = await tool.execute(body.arguments ?? {});
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    if (req.url === "/mcp" || req.url === "/") {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = buildServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, undefined);
      return;
    }
    res.writeHead(404).end("not found");
  });

  httpServer.listen(httpPort, () => {
    console.log(`[fabric-chat] ${app.name} v${app.version} — ${app.tools.length} tools`);
    console.log(`[fabric-chat] MCP server listening on :${httpPort}`);
    console.log(`[fabric-chat] Endpoints: /health /tools /tools/call /mcp/tools/call /mcp`);
  });

  await registerWithGateway();
  if (GATEWAY_URL) setInterval(sendKeepalive, 30_000);
} else {
  const transport = new StdioServerTransport();
  const server = buildServer();
  await server.connect(transport);
}
