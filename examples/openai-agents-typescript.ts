import { Agent, MCPServerStdio, run } from "@openai/agents";

async function main(): Promise<void> {
  const apiKey = process.env.TOSEA_API_KEY;
  if (!apiKey) {
    throw new Error("TOSEA_API_KEY is required");
  }

  const mcpServer = new MCPServerStdio({
    name: "tosea",
    fullCommand: "node C:/new/mcp-ToseaAI/dist/src/index.js",
    cacheToolsList: true,
    env: {
      TOSEA_API_KEY: apiKey,
      TOSEA_API_BASE_URL: process.env.TOSEA_API_BASE_URL ?? "https://tosea.ai"
    }
  });

  await mcpServer.connect();

  try {
    const agent = new Agent({
      name: "Tosea Presentation Agent",
      instructions:
        "Use the Tosea MCP tools to build decks from local documents. Prefer staged workflows when the user requests edits.",
      mcpServers: [mcpServer]
    });

    const result = await run(
      agent,
      "Check the account health and list the most recent presentations."
    );
    console.log(result.finalOutput);
  } finally {
    await mcpServer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

