#!/usr/bin/env node
/**
 * N1nja — Hibernate N+1 Detector MCP Server
 *
 * Entry point only: delegates to the composition root in interfaces/mcp/server.ts.
 */

import { startMcpServer } from './interfaces/mcp/server';

startMcpServer().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
