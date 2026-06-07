#!/usr/bin/env node
/**
 * Apify Standby entrypoint for @drist/nabolag-mcp.
 *
 * The package ships a stdio MCP server (dist/index.js). On the Apify platform
 * Actors are reached over HTTP, so in Standby mode we expose a Streamable HTTP
 * MCP endpoint and bridge it to a freshly spawned stdio child per session.
 *
 * Pattern follows Apify's "deploy your own stdio MCP server" guide:
 *   - listen on ACTOR_WEB_SERVER_PORT
 *   - serve the MCP endpoint at webServerMcpPath (see .actor/actor.json -> "/mcp")
 *   - charge a pay-per-event for the start and for every tools/call
 *
 * This file is only used inside the Apify Actor. Local stdio usage
 * (npx @drist/nabolag-mcp / Claude Desktop) runs dist/index.js directly and
 * never touches this bridge or the Apify SDK.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Actor } from "apify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

await Actor.init();

const PORT = Number(process.env.ACTOR_WEB_SERVER_PORT) || 8080;
const MCP_PATH = "/mcp";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STDIO_ENTRY = path.resolve(__dirname, "../dist/index.js");

/** Spawn the bundled stdio MCP server and return a connected SDK client. */
async function makeUpstreamClient() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [STDIO_ENTRY],
  });
  const client = new Client({ name: "nabolag-standby-bridge", version: "0.2.0" });
  await client.connect(transport);
  return { client, transport };
}

/** A proxying MCP Server that forwards list/call to the stdio upstream and charges per call. */
function makeProxyServer(client) {
  const server = new Server(
    { name: "drist-nabolag-mcp", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return await client.listTools();
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // Pay-per-event: one charge per tool invocation (see .actor/pay_per_event.json).
    await Actor.charge({ eventName: "tool-call" });
    return await client.callTool({
      name: request.params.name,
      arguments: request.params.arguments ?? {},
    });
  });

  return server;
}

const httpServer = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        server: "drist-nabolag-mcp",
        version: "0.2.0",
        mcpEndpoint: MCP_PATH,
        tools: ["hent_kollektivdekning", "hent_stoysone", "hent_grontareal"],
      }),
    );
    return;
  }

  if (!req.url || !req.url.startsWith(MCP_PATH)) {
    res.writeHead(404).end("Not found");
    return;
  }

  // One upstream stdio child + one transport per request (stateless Streamable HTTP).
  let upstream;
  try {
    await Actor.charge({ eventName: "actor-start" });
    upstream = await makeUpstreamClient();
    const proxy = makeProxyServer(upstream.client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      upstream?.transport.close().catch(() => {});
    });
    await proxy.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    upstream?.transport.close().catch(() => {});
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

httpServer.listen(PORT, () => {
  console.error(`nabolag-mcp standby listening on :${PORT}${MCP_PATH}`);
});
