import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { ApiError, TransportError } from "../src/errors.js";
import { ToseaClient } from "../src/http.js";

test("loadConfig normalizes base url and validates API key prefix", () => {
  const config = loadConfig({
    TOSEA_API_KEY: "sk_example_value",
    TOSEA_API_BASE_URL: "https://tosea.ai/"
  });

  assert.equal(config.mcpApiBaseUrl, "https://tosea.ai/api/mcp/v1");
  assert.equal(config.apiKey, "sk_example_value");
});

test("exportPresentation forwards idempotency header and export filename", async () => {
  const requests: Array<{ url: string; headers: HeadersInit | undefined; body: string | undefined }> = [];
  const client = new ToseaClient(
    loadConfig({
      TOSEA_API_KEY: "sk_export_value",
      TOSEA_API_BASE_URL: "https://tosea.ai"
    }),
    (async (input, init) => {
      requests.push({
        url: String(input),
        headers: init?.headers,
        body: typeof init?.body === "string" ? init.body : undefined
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
    exportFilename: "board_update_final.pptx",
    idempotencyKey: "export-1"
  });

  assert.equal(requests.length, 1);
  const headers = new Headers(requests[0]?.headers);
  assert.equal(headers.get("authorization"), "Bearer sk_export_value");
  assert.equal(headers.get("x-idempotency-key"), "export-1");
  assert.match(requests[0]?.url || "", /\/api\/mcp\/v1\/export$/);
  assert.match(requests[0]?.body || "", /"export_filename":"board_update_final\.pptx"/);
});

test("waitForJob follows nested job status for export and does not finish early", async () => {
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
      const jobStatus = callCount >= 2 ? "completed" : "running";
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            presentation_id: "8af3c601-7f0f-4fd2-bd36-45dbb3d2c1a0",
            status: "completed",
            job: {
              status: jobStatus,
              export_type: "pptx",
              filename: jobStatus === "completed" ? "deck.pptx" : null
            }
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
  assert.equal(result.terminal_status, "completed");
  assert.equal(result.final_status.status, "completed");
  assert.equal(result.final_status.job?.status, "completed");
  assert.equal(callCount, 2);
});

test("waitForJob falls back to top-level presentation status when nested job is absent", async () => {
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
  assert.equal(result.terminal_status, "completed");
  assert.equal(callCount, 2);
});

test("request normalizes JSON API errors without consuming the body twice", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tosea-mcp-test-"));
  const pdfPath = path.join(tempDir, "source.pdf");
  await writeFile(pdfPath, Buffer.from("%PDF-1.4\n%mock\n", "utf-8"));
  const client = new ToseaClient(
    loadConfig({
      TOSEA_API_KEY: "sk_error_value",
      TOSEA_API_BASE_URL: "https://tosea.ai"
    }),
    (async () => {
      return new Response(
        JSON.stringify({
          detail: {
            error: "insufficient_credits",
            message: "Insufficient credits for pdf_to_presentation.",
            operation: "pdf_to_presentation",
            required: 3,
            available: 0
          }
        }),
        {
          status: 402,
          headers: { "content-type": "application/json" }
        }
      );
    }) as typeof fetch
  );

  try {
    await assert.rejects(
      () =>
        client.pdfToPresentation({
          filePaths: [pdfPath],
          outputFormat: "pptx"
        }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 402);
        assert.equal(
          (error.detail as { message?: string }).message,
          "Insufficient credits for pdf_to_presentation."
        );
        return true;
      }
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("request normalizes terminated transport failures into retryable transport errors", async () => {
  const client = new ToseaClient(
    loadConfig({
      TOSEA_API_KEY: "sk_transport_value",
      TOSEA_API_BASE_URL: "https://tosea.ai"
    }),
    (async () => {
      throw new TypeError("terminated");
    }) as typeof fetch
  );

  await assert.rejects(
    () =>
      client.exportPresentation({
        presentationId: "13bb5c96-0ef0-42b5-b463-3c1d7e17c507",
        outputFormat: "pdf",
        idempotencyKey: "retry-transport-1"
      }),
    (error: unknown) => {
      assert.ok(error instanceof TransportError);
      assert.equal(error.isRetryable, true);
      assert.match(error.message, /Retry with the same idempotency key/i);
      return true;
    }
  );
});

test("pdfToPresentation forwards idempotency header when provided", async () => {
  const requests: Array<{ headers: HeadersInit | undefined }> = [];
  const client = new ToseaClient(
    loadConfig({
      TOSEA_API_KEY: "sk_idem_value",
      TOSEA_API_BASE_URL: "https://tosea.ai"
    }),
    (async (_input, init) => {
      requests.push({ headers: init?.headers });
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            presentation_id: "23c6b662-3a5a-49fb-a9d2-21a66bd5355c",
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

  const tempDir = await mkdtemp(path.join(tmpdir(), "tosea-mcp-test-"));
  const pdfPath = path.join(tempDir, "source.pdf");
  await writeFile(pdfPath, Buffer.from("%PDF-1.4\n%mock\n", "utf-8"));

  try {
    await client.pdfToPresentation({
      filePaths: [pdfPath],
      outputFormat: "pptx",
      idempotencyKey: "oneshot-retry-1"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const headers = new Headers(requests[0]?.headers);
  assert.equal(headers.get("x-idempotency-key"), "oneshot-retry-1");
});

test("pdfToPresentation forwards export_filename in multipart form data", async () => {
  const bodies: FormData[] = [];
  const client = new ToseaClient(
    loadConfig({
      TOSEA_API_KEY: "sk_export_form_value",
      TOSEA_API_BASE_URL: "https://tosea.ai"
    }),
    (async (_input, init) => {
      bodies.push(init?.body as FormData);
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            presentation_id: "23c6b662-3a5a-49fb-a9d2-21a66bd5355c",
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

  const tempDir = await mkdtemp(path.join(tmpdir(), "tosea-mcp-test-"));
  const pdfPath = path.join(tempDir, "source.pdf");
  await writeFile(pdfPath, Buffer.from("%PDF-1.4\n%mock\n", "utf-8"));

  try {
    await client.pdfToPresentation({
      filePaths: [pdfPath],
      outputFormat: "pptx",
      exportFilename: "executive_review_final.pptx"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.get("export_filename"), "executive_review_final.pptx");
});

test("pdfToPresentation forwards image-mode fields in multipart form data", async () => {
  const bodies: FormData[] = [];
  const client = new ToseaClient(
    loadConfig({
      TOSEA_API_KEY: "sk_image_oneshot_value",
      TOSEA_API_BASE_URL: "https://tosea.ai"
    }),
    (async (_input, init) => {
      bodies.push(init?.body as FormData);
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            presentation_id: "23c6b662-3a5a-49fb-a9d2-21a66bd5355c",
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

  const tempDir = await mkdtemp(path.join(tmpdir(), "tosea-mcp-test-"));
  const pdfPath = path.join(tempDir, "source.pdf");
  await writeFile(pdfPath, Buffer.from("%PDF-1.4\n%mock\n", "utf-8"));

  try {
    await client.pdfToPresentation({
      filePaths: [pdfPath],
      outputFormat: "pptx_image",
      slideMode: "image",
      imageModel: "gemini-3.1-flash-image-preview",
      logoFileId: "61d9ccea-22aa-4c4c-b6ef-f6c5ebf3c337",
      templateFileId: "f6172bc9-7ae5-45b1-8df8-ae4453170748",
      exportFilename: "image_board_final.pptx"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.get("output_format"), "pptx_image");
  assert.equal(bodies[0]?.get("slide_mode"), "image");
  assert.equal(bodies[0]?.get("image_model"), "gemini-3.1-flash-image-preview");
  assert.equal(bodies[0]?.get("logo_file_id"), "61d9ccea-22aa-4c4c-b6ef-f6c5ebf3c337");
  assert.equal(bodies[0]?.get("template_file_id"), "f6172bc9-7ae5-45b1-8df8-ae4453170748");
  assert.equal(bodies[0]?.get("export_filename"), "image_board_final.pptx");
});

test("image-mode parse forwards image_model in multipart form data", async () => {
  const bodies: FormData[] = [];
  const client = new ToseaClient(
    loadConfig({
      TOSEA_API_KEY: "sk_image_parse_value",
      TOSEA_API_BASE_URL: "https://tosea.ai"
    }),
    (async (_input, init) => {
      bodies.push(init?.body as FormData);
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            presentation_id: "23c6b662-3a5a-49fb-a9d2-21a66bd5355c",
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

  const tempDir = await mkdtemp(path.join(tmpdir(), "tosea-mcp-test-"));
  const pdfPath = path.join(tempDir, "source.pdf");
  await writeFile(pdfPath, Buffer.from("%PDF-1.4\n%mock\n", "utf-8"));

  try {
    await client.pdfParse({
      filePaths: [pdfPath],
      slideMode: "image",
      renderModel: "gemini-3.1-pro-preview",
      imageModel: "gemini-3.1-flash-image-preview",
      logoFileId: "c5097024-b81e-4b4d-9d70-16b390d266bf",
      templateFileId: "3f6d5bd0-2533-45ea-a5c9-28956df9ae87"
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.get("slide_mode"), "image");
  assert.equal(bodies[0]?.get("render_model"), "gemini-3.1-pro-preview");
  assert.equal(bodies[0]?.get("image_model"), "gemini-3.1-flash-image-preview");
  assert.equal(bodies[0]?.get("logo_file_id"), "c5097024-b81e-4b4d-9d70-16b390d266bf");
  assert.equal(bodies[0]?.get("template_file_id"), "3f6d5bd0-2533-45ea-a5c9-28956df9ae87");
});
