#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { redactSecrets } from "./errors.js";
import { createToseaServer } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createToseaServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  const message = redactSecrets(
    error instanceof Error ? error.stack || error.message : String(error)
  );
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

