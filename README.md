# `mcp-ToseaAI`

Official MCP server for ToseaAI document-to-presentation workflows.

This server wraps the production ToseaAI HTTP contract at `/api/mcp/v1` and exposes a stable MCP tool surface for Claude Code, Cursor, Codex, and other MCP clients.

- API keys stay server-side and are never echoed back to the agent.
- Long-running operations use `presentation_id` plus polling, not raw SSE.
- Mutating tools support explicit idempotency keys where the backend supports them.
- Export-capable tools accept an optional `export_filename` so downstream clients can receive a friendly attachment name.
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
- `TOSEA_MAX_TOOL_CONCURRENCY`
- `TOSEA_MAX_MUTATING_CONCURRENCY`
- `TOSEA_MAX_PENDING_TOOL_REQUESTS`
- `TOSEA_POLL_INTERVAL_MS`
- `TOSEA_MAX_POLL_MS`
- `TOSEA_LOG_LEVEL`

## Claude Code example

```json
{
  "mcpServers": {
    "tosea": {
      "command": "node",
      "args": ["C:/new/mcp-ToseaAI/dist/src/index.js"],
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
- Read-only tools use `singleflight` coalescing for identical in-flight requests, so repeated concurrent calls like the same `list_presentations` query are collapsed into one upstream request.
- All tools use bounded local concurrency inside one MCP server process; once the local queue is full, the MCP server returns a retryable backpressure error instead of letting requests pile up until transport-level failure.
- Mutating tools are locally gated with bounded concurrency, and writes for the same `presentation_id` are serialized inside one MCP server process.
- Upload-creating endpoints (`pdf-parse`, `pdf-to-presentation`) accept `idempotency_key`, but the MCP server still avoids silent auto-retries for large uploads by default.
- `outline edit`, `slide edit`, and `export` support `idempotency_key`; reuse the same value only when retrying the same logical action.
- `tosea_export_presentation` and `tosea_pdf_to_presentation` accept optional `export_filename` when the visible exported attachment name matters.
- `wait_for_job` follows nested `data.job.status` when the backend reports a separate export/full job, and falls back to top-level presentation status when no nested job exists.
- `html_zip` export is supported for HTML-mode decks and remains a free export on the backend.
- Stdio lifecycle is tied to the host process: the server shuts down on `stdin` close, `SIGINT`, and `SIGTERM`, and unexpected transport failures are surfaced as retryable host-transport errors instead of opaque raw exceptions.

## Attachment delivery

If an MCP client downloads a finished export and then relays it through OpenClaw, WeChat, email, or another chat surface:

- pass `export_filename` when the user cares about the final visible attachment name
- preserve filename, extension, and `Content-Type` when re-uploading the artifact
- do not repackage the file as an anonymous binary attachment, or downstream clients may show only a generic attachment label

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
