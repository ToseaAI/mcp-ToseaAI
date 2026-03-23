import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { ToseaClient } from "../src/http.js";

test("loadConfig normalizes base url and validates API key prefix", () => {
  const config = loadConfig({
    TOSEA_API_KEY: "sk_example_value",
    TOSEA_API_BASE_URL: "https://tosea.ai/"
  });

  assert.equal(config.mcpApiBaseUrl, "https://tosea.ai/api/mcp/v1");
  assert.equal(config.apiKey, "sk_example_value");
});

test("exportPresentation forwards idempotency header", async () => {
  const requests: Array<{ url: string; headers: HeadersInit | undefined }> = [];
  const client = new ToseaClient(
    loadConfig({
      TOSEA_API_KEY: "sk_export_value",
      TOSEA_API_BASE_URL: "https://tosea.ai"
    }),
    (async (input, init) => {
      requests.push({
        url: String(input),
        headers: init?.headers
      });
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            presentation_id: "13bb5c96-0ef0-42b5-b463-3c1d7e17c507",
            job: { status: "queued" }
          }
        }),
        {
          status: 202,
          headers: { "content-type": "application/json" }
        }
      );
    }) as typeof fetch
  );

  await client.exportPresentation({
    presentationId: "13bb5c96-0ef0-42b5-b463-3c1d7e17c507",
    outputFormat: "pptx",
    idempotencyKey: "export-1"
  });

  assert.equal(requests.length, 1);
  const headers = new Headers(requests[0]?.headers);
  assert.equal(headers.get("authorization"), "Bearer sk_export_value");
  assert.equal(headers.get("x-idempotency-key"), "export-1");
  assert.match(requests[0]?.url || "", /\/api\/mcp\/v1\/export$/);
});

test("waitForJob polls until completion", async () => {
  let callCount = 0;
  const client = new ToseaClient(
    loadConfig({
      TOSEA_API_KEY: "sk_wait_value",
      TOSEA_API_BASE_URL: "https://tosea.ai",
      TOSEA_POLL_INTERVAL_MS: "1",
      TOSEA_MAX_POLL_MS: "1"
    }),
    (async () => {
      callCount += 1;
      const status = callCount >= 2 ? "completed" : "running";
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            presentation_id: "8af3c601-7f0f-4fd2-bd36-45dbb3d2c1a0",
            status
          }
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }) as typeof fetch
  );

  const result = await client.waitForJob("8af3c601-7f0f-4fd2-bd36-45dbb3d2c1a0", {
    timeoutMs: 100,
    pollIntervalMs: 1,
    maxPollIntervalMs: 1
  });

  assert.equal(result.completed, true);
  assert.equal(result.final_status.status, "completed");
  assert.equal(callCount, 2);
});
