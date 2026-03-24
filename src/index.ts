#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { redactSecrets } from "./errors.js";
import { createToseaServer } from "./tools.js";

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createToseaServer(config);
  const transport = new StdioServerTransport();
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    writeStderr(`[tosea-mcp] shutting down: ${reason}`);
    try {
      await server.close();
    } catch (error) {
      const message = redactSecrets(
        error instanceof Error ? error.stack || error.message : String(error)
      );
      writeStderr(`[tosea-mcp] shutdown error: ${message}`);
    }
    process.exit(exitCode);
  };

  process.stdin.on("close", () => {
    void shutdown("stdin closed");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("unhandledRejection", (error) => {
    const message = redactSecrets(
      error instanceof Error ? error.stack || error.message : String(error)
    );
    writeStderr(`[tosea-mcp] unhandled rejection: ${message}`);
    void shutdown("unhandledRejection", 1);
  });
  process.on("uncaughtException", (error) => {
    const message = redactSecrets(error.stack || error.message);
    writeStderr(`[tosea-mcp] uncaught exception: ${message}`);
    void shutdown("uncaughtException", 1);
  });

  await server.connect(transport);
}

main().catch((error) => {
  const message = redactSecrets(
    error instanceof Error ? error.stack || error.message : String(error)
  );
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
