#!/usr/bin/env node
/**
 * knowledge-mcp-server: lets Claude (or any MCP client) read an organisation's knowledge base in PostgreSQL.
 *
 * Serves stdio by default (a local client starts it as a subprocess).
 * Serves Streamable HTTP when TRANSPORT=http (how it would run on Cloud Run).
 *
 * In stdio mode stdout carries the protocol, so this file only ever logs to stderr.
 */
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { closePool, describeDbError, pool } from "./db.js";
import { registerTools } from "./tools.js";

/** A fresh server per stdio connection and per HTTP request. The database pool is shared and lives in db.ts. */
function createServer(): McpServer {
  const server = new McpServer({ name: "knowledge-mcp-server", version: "1.0.0" });
  registerTools(server);
  return server;
}

if (process.env.TRANSPORT === "http") {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 8080);
  const allowedHosts = (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map(name => name.trim())
    .filter(Boolean);
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1";

  // On localhost the SDK checks Host and Origin headers by itself. On any other bind it only does so when
  // told which host names to accept, so refuse to start without them rather than serve the whole internet.
  if (!local && allowedHosts.length === 0) {
    console.error(`HOST=${host} is not localhost. Set ALLOWED_HOSTS to the host name(s) this server is reached at.`);
    process.exit(1);
  }

  const app = createMcpExpressApp(local ? { host } : { host, allowedHosts });
  const nodeHandler = toNodeHandler(createMcpHandler(createServer));
  app.all("/mcp", (req, res) => void nodeHandler(req, res, req.body));

  // For uptime probes: 200 only when the database answers.
  app.get("/healthz", (_req, res) => {
    pool
      .query("SELECT 1")
      .then(() => res.json({ ok: true }))
      .catch((error: unknown) => res.status(503).json({ ok: false, error: describeDbError(error) }));
  });

  const httpServer = app.listen(port, host, () => {
    console.error(`knowledge-mcp-server listening on http://${host}:${port}/mcp`);
  });

  // Cloud Run sends SIGTERM before it stops a container: finish open requests, then close the pool.
  const shutdown = () => {
    httpServer.close(() => void closePool().finally(() => process.exit(0)));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  serveStdio(createServer);
  console.error("knowledge-mcp-server running on stdio");
}
