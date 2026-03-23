# `mcp-ToseaAI`

Official MCP server for ToseaAI document-to-presentation workflows.

This server wraps the production ToseaAI HTTP contract at `/api/mcp/v1` and exposes a stable MCP tool surface for Claude Code, Cursor, Codex, and other MCP clients.

- API keys stay server-side and are never echoed back to the agent.
- Long-running operations use `presentation_id` plus polling, not raw SSE.
- Mutating tools support explicit idempotency keys where the backend supports them.
- File uploads stay local until the MCP server streams them to ToseaAI over HTTPS.

## Why a separate repo

This repository should stay independent from the main application repository.

- Release cadence is different from the backend.
- Breaking changes to tool names and prompts must be versioned separately.
- Nested git repos or submodules add unnecessary operational friction for MCP users.

## Install

```bash
npm install
npm run build
```

## Required environment variables

```bash
TOSEA_API_KEY=sk_...
TOSEA_API_BASE_URL=https://tosea.ai
```

Optional:

- `TOSEA_TIMEOUT_MS`
- `TOSEA_MAX_RETRIES`
- `TOSEA_POLL_INTERVAL_MS`
- `TOSEA_MAX_POLL_MS`
- `TOSEA_LOG_LEVEL`

## Claude Code example

```json
{
  "mcpServers": {
    "tosea": {
      "command": "node",
      "args": ["C:/new/mcp-ToseaAI/dist/index.js"],
      "env": {
        "TOSEA_API_KEY": "sk_...",
        "TOSEA_API_BASE_URL": "https://tosea.ai"
      }
    }
  }
}
```

Client-specific examples live in [examples/README.md](/C:/new/mcp-ToseaAI/examples/README.md).

## Cursor example

Use [examples/cursor.mcp.json](/C:/new/mcp-ToseaAI/examples/cursor.mcp.json) as the starting point for your local `mcp.json`.

## OpenAI Agents SDK example

OpenAI's Agents SDK supports stdio MCP servers, so this repo can be used directly as a local subprocess MCP without needing a hosted HTTP wrapper. See [examples/openai-agents-typescript.ts](/C:/new/mcp-ToseaAI/examples/openai-agents-typescript.ts).

If you later need OpenAI Responses API hosted remote MCP mode, add a separate Streamable HTTP transport wrapper instead of changing this stdio package in place.

## Tool summary

- `tosea_health`
- `tosea_get_permissions_summary`
- `tosea_get_quota_status`
- `tosea_list_presentations`
- `tosea_get_presentation_full_data`
- `tosea_parse_pdf`
- `tosea_generate_outline`
- `tosea_edit_outline_page`
- `tosea_render_slides`
- `tosea_edit_slide_page`
- `tosea_export_presentation`
- `tosea_pdf_to_presentation`
- `tosea_wait_for_job`
- `tosea_list_exports`
- `tosea_list_export_files`
- `tosea_redownload_export`

## Reliability model

- `GET` requests use bounded retries with backoff and jitter.
- Upload-creating endpoints do not auto-retry because the current backend does not accept idempotency keys on those routes.
- `outline edit`, `slide edit`, and `export` support `idempotency_key`; reuse the same value only when retrying the same logical action.
- `wait_for_job` polls until `completed` or `failed`, then returns the final job payload as JSON.

## Security notes

- API keys must start with `sk_`.
- The server redacts bearer secrets from surfaced errors.
- The MCP tool layer does not expose JWT-only account operations.
- Export history only exposes user-visible files returned by the backend.

## Smoke test

This repository includes a non-billing smoke test that checks auth, health, permissions, and list access without creating presentations:

```bash
npm run smoke
```

Optional flags:

- `--feature-key outline_generate`
- `--expect-tier pro`
- `--list-limit 5`
