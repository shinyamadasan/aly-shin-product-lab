#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createProductLabMcpServer } from "./mcp-server.ts";

process.stderr.write("Product Lab MCP stdio server starting\n");

const handle = serveStdio(
  () => createProductLabMcpServer(),
  { onerror: () => process.stderr.write("Product Lab MCP protocol error\n") },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
