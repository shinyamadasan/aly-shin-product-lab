#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createInventoryCountService } from "../product-lab/inventory-count-service-local.ts";
import { createProductLabReadService } from "../product-lab/read-service.ts";
import { createProductLabMcpServer } from "./mcp-server.ts";
import { createPurchaseService } from "./purchase-service-local.ts";

process.stderr.write("Product Lab MCP stdio server starting\n");

const handle = serveStdio(
  () => createProductLabMcpServer(createProductLabReadService(), createInventoryCountService(), createPurchaseService()),
  { onerror: () => process.stderr.write("Product Lab MCP protocol error\n") },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
