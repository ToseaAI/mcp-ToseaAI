import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  ApiError,
  BackpressureError,
  TransportError,
  redactSecrets
} from "./errors.js";
import { ToolExecutionGate } from "./execution.js";
import { ToseaClient } from "./http.js";
import type { ClientConfig, FetchLike } from "./types.js";
import { maybeReadBase64File } from "./uploads.js";

function asToolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function formatApiErrorMessage(error: ApiError): string {
  const baseMessage = redactSecrets(error.message);
  if (baseMessage.startsWith(`HTTP ${error.status}:`)) {
    return baseMessage;
  }
  return `HTTP ${error.status}: ${baseMessage}`;
}

function buildReadOnlyDedupeKey(toolName: string, args: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tool: toolName,
    args,
  });
}

function wrapToolError(error: unknown): McpError {
  if (error instanceof BackpressureError) {
    return new McpError(ErrorCode.InternalError, redactSecrets(error.message), {
      retryable: true,
      transport_error: false,
      backpressure_error: true,
      retry_after_ms: error.retryAfterMs
    });
  }
  if (error instanceof ApiError) {
    const message = formatApiErrorMessage(error);
    return new McpError(ErrorCode.InternalError, message, {
      http_status: error.status,
      path: error.path,
      detail: error.detail,
      retryable: error.isRetryable
    });
  }
  if (error instanceof TransportError) {
    const message = redactSecrets(error.message);
    return new McpError(ErrorCode.InternalError, message, {
      path: error.path,
      detail: error.detail,
      retryable: error.isRetryable,
      transport_error: true
    });
  }
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  return new McpError(ErrorCode.InternalError, message);
}

function normalizeSlideNumbers(slides: number[] | undefined): number[] | undefined {
  if (!slides || !slides.length) {
    return undefined;
  }
  return [...new Set(slides)].sort((a, b) => a - b);
}

const pageCountRangeSchema = z.enum([
  "4-8",
  "8-12",
  "12-16",
  "16-20",
  "20-30",
  "30-40",
  "40-50",
  "50-100"
]);

export function createToseaServer(config: ClientConfig, fetchImpl?: FetchLike): McpServer {
  const client = new ToseaClient(config, fetchImpl);
  const executionGate = new ToolExecutionGate(
    config.maxToolConcurrency,
    config.maxMutatingConcurrency,
    config.maxPendingToolRequests
  );
  const server = new McpServer({
    name: "tosea",
    version: "0.1.0"
  });

  async function runReadOnly<T>(
    operation: () => Promise<T>,
    dedupeKey?: string
  ) {
    try {
      return asToolResult(await executionGate.runReadOnly(operation, dedupeKey));
    } catch (error) {
      throw wrapToolError(error);
    }
  }

  async function runMutating<T>(
    operation: () => Promise<T>,
    presentationId?: string
  ) {
    try {
      return asToolResult(
        await executionGate.runMutating(operation, presentationId)
      );
    } catch (error) {
      throw wrapToolError(error);
    }
  }

  server.tool("tosea_health", "Check MCP connectivity to ToseaAI.", {}, async () => {
    return await runReadOnly(
      () => client.health(),
      buildReadOnlyDedupeKey("tosea_health")
    );
  });

  server.tool(
    "tosea_get_permissions_summary",
    "Inspect current account tier and feature access before expensive runs.",
    {},
    async () => {
      return await runReadOnly(
        () => client.getPermissionsSummary(),
        buildReadOnlyDedupeKey("tosea_get_permissions_summary")
      );
    }
  );

  server.tool(
    "tosea_get_quota_status",
    "Inspect quota status for all features or a single feature key.",
    { feature_key: z.string().min(1).optional() },
    async ({ feature_key }) => {
      return await runReadOnly(
        () => client.getQuotaStatus(feature_key),
        buildReadOnlyDedupeKey("tosea_get_quota_status", {
          feature_key: feature_key ?? null
        })
      );
    }
  );

  server.tool(
    "tosea_list_presentations",
    "List the current user's presentations.",
    {
      page: z.number().int().min(1).default(1),
      per_page: z.number().int().min(1).max(100).default(20),
      status: z.string().optional(),
      search: z.string().min(1).optional()
    },
    async ({ page, per_page, status, search }) => {
      return await runReadOnly(() =>
        client.listPresentations({
          page,
          perPage: per_page,
          ...(status ? { status } : {}),
          ...(search ? { search } : {})
        }),
        buildReadOnlyDedupeKey("tosea_list_presentations", {
          page,
          per_page,
          status: status ?? null,
          search: search ?? null
        })
      );
    }
  );

  server.tool(
    "tosea_get_presentation_full_data",
    "Fetch full structured presentation data, including outlines and slides.",
    { presentation_id: z.string().uuid() },
    async ({ presentation_id }) => {
      return await runReadOnly(
        () => client.getPresentationFullData(presentation_id),
        buildReadOnlyDedupeKey("tosea_get_presentation_full_data", {
          presentation_id
        })
      );
    }
  );

  server.tool(
    "tosea_parse_pdf",
    "Upload local source files and run the parse-only stage. Use logo_file_id for a previously confirmed logo upload. Use template_file_id only with slide_mode='image'; it points to a previously confirmed custom-template upload, not a source document.",
    {
      file_paths: z.array(z.string().min(1)).min(1).max(10),
      instruction: z.string().default(""),
      render_provider: z.string().default("default"),
      render_model: z.string().default("deepseek-chat-v3.1"),
      image_model: z.string().optional(),
      slide_domain: z.string().default("general"),
      page_count_range: pageCountRangeSchema.default("8-12"),
      template_name: z.string().default("beamer_classic"),
      logo_file_id: z.string().uuid().optional(),
      template_file_id: z.string().uuid().optional(),
      slide_mode: z.enum(["html", "image"]).default("html"),
      idempotency_key: z.string().min(8).optional()
    },
    async ({
      file_paths,
      instruction,
      render_provider,
      render_model,
      image_model,
      slide_domain,
      page_count_range,
      template_name,
      logo_file_id,
      template_file_id,
      slide_mode,
      idempotency_key
    }) => {
      return await runMutating(() =>
        client.pdfParse({
          filePaths: file_paths,
          instruction,
          renderProvider: render_provider,
          renderModel: render_model,
          imageModel: image_model,
          slideDomain: slide_domain,
          pageCountRange: page_count_range,
          templateName: template_name,
          logoFileId: logo_file_id,
          templateFileId: template_file_id,
          slideMode: slide_mode,
          idempotencyKey: idempotency_key
        })
      );
    }
  );

  server.tool(
    "tosea_generate_outline",
    "Queue outline generation for an existing presentation.",
    {
      presentation_id: z.string().uuid(),
      instruction: z.string().default(""),
      render_provider: z.string().optional()
    },
    async ({ presentation_id, instruction, render_provider }) => {
      return await runMutating(
        () =>
          client.generateOutline({
            presentationId: presentation_id,
            instruction,
            renderProvider: render_provider
          }),
        presentation_id
      );
    }
  );

  server.tool(
    "tosea_edit_outline_page",
    "Modify or insert outline content synchronously through the aggregated MCP edit contract.",
    {
      presentation_id: z.string().uuid(),
      page_number: z.number().int().min(1),
      action: z.enum(["modify", "insert"]),
      instruction: z.string().min(1),
      model_name: z.string().optional(),
      after_slide: z.number().int().min(1).optional(),
      idempotency_key: z.string().min(8).optional()
    },
    async ({
      presentation_id,
      page_number,
      action,
      instruction,
      model_name,
      after_slide,
      idempotency_key
    }) => {
      return await runMutating(
        () =>
          client.editOutlinePage({
            presentationId: presentation_id,
            pageNumber: page_number,
            action,
            instruction,
            modelName: model_name,
            afterSlide: after_slide,
            idempotencyKey: idempotency_key
          }),
        presentation_id
      );
    }
  );

  server.tool(
    "tosea_render_slides",
    "Queue slide rendering for all slides or a subset of slide numbers.",
    {
      presentation_id: z.string().uuid(),
      render_provider: z.string().optional(),
      render_model: z.string().optional(),
      image_model: z.string().optional(),
      force: z.boolean().default(false),
      slides_to_generate: z.array(z.number().int().min(1)).max(50).optional()
    },
    async ({
      presentation_id,
      render_provider,
      render_model,
      image_model,
      force,
      slides_to_generate
    }) => {
      return await runMutating(
        () =>
          client.renderSlides({
            presentationId: presentation_id,
            renderProvider: render_provider,
            renderModel: render_model,
            imageModel: image_model,
            force,
            slidesToGenerate: normalizeSlideNumbers(slides_to_generate)
          }),
        presentation_id
      );
    }
  );

  server.tool(
    "tosea_edit_slide_page",
    "Modify or insert a slide. Supports optional screenshot grounding for multimodal edits.",
    {
      presentation_id: z.string().uuid(),
      page_number: z.number().int().min(1),
      action: z.enum(["modify", "insert"]),
      instruction: z.string().min(1),
      edit_mode: z.enum(["outline_layout", "layout_only"]).default("outline_layout"),
      model_name: z.string().optional(),
      image_model: z.string().optional(),
      after_slide: z.number().int().min(1).optional(),
      screenshot_path: z.string().optional(),
      idempotency_key: z.string().min(8).optional()
    },
    async ({
      presentation_id,
      page_number,
      action,
      instruction,
      edit_mode,
      model_name,
      image_model,
      after_slide,
      screenshot_path,
      idempotency_key
    }) => {
      return await runMutating(
        async () => {
          const screenshotBase64 = await maybeReadBase64File(screenshot_path);
          return await client.editSlidePage({
            presentationId: presentation_id,
            pageNumber: page_number,
            action,
            instruction,
            editMode: edit_mode,
            modelName: model_name,
            imageModel: image_model,
            afterSlide: after_slide,
            screenshotBase64,
            idempotencyKey: idempotency_key
          });
        },
        presentation_id
      );
    }
  );

  server.tool(
    "tosea_export_presentation",
    "Queue an export job for a completed presentation. Use output_format='pptx_image' when an image-mode deck must be delivered as a pure image-based PPTX. Use html_zip only for HTML-mode decks.",
    {
      presentation_id: z.string().uuid(),
      output_format: z.enum(["pdf", "pptx", "pptx_image", "html_zip"]),
      export_filename: z.string().min(1).max(255).optional(),
      idempotency_key: z.string().min(8).optional()
    },
    async ({ presentation_id, output_format, export_filename, idempotency_key }) => {
      return await runMutating(
        () =>
          client.exportPresentation({
            presentationId: presentation_id,
            outputFormat: output_format,
            exportFilename: export_filename,
            idempotencyKey: idempotency_key
          }),
        presentation_id
      );
    }
  );

  server.tool(
    "tosea_pdf_to_presentation",
    "Upload local source files and generate a final export in one shot. Keep slide_mode='html' by default. Use slide_mode='image' only when the user explicitly wants image-mode rendering. Use template_file_id only with slide_mode='image'; it points to a previously confirmed custom-template upload, not a source document. Use logo_file_id for a previously confirmed logo upload. Choose output_format='pptx_image' when the user wants an image-based PPTX export.",
    {
      file_paths: z.array(z.string().min(1)).min(1).max(10),
      instruction: z.string().default(""),
      output_format: z.enum(["pdf", "pptx", "pptx_image"]).default("pptx"),
      export_filename: z.string().min(1).max(255).optional(),
      render_provider: z.string().default("default"),
      render_model: z.string().default("deepseek-chat-v3.1"),
      image_model: z.string().optional(),
      slide_domain: z.string().default("general"),
      page_count_range: pageCountRangeSchema.default("8-12"),
      template_name: z.string().default("beamer_classic"),
      logo_file_id: z.string().uuid().optional(),
      template_file_id: z.string().uuid().optional(),
      slide_mode: z.enum(["html", "image"]).default("html"),
      idempotency_key: z.string().min(8).optional()
    },
    async ({
      file_paths,
      instruction,
      output_format,
      export_filename,
      render_provider,
      render_model,
      image_model,
      slide_domain,
      page_count_range,
      template_name,
      logo_file_id,
      template_file_id,
      slide_mode,
      idempotency_key
    }) => {
      return await runMutating(() =>
        client.pdfToPresentation({
          filePaths: file_paths,
          instruction,
          outputFormat: output_format,
          exportFilename: export_filename,
          renderProvider: render_provider,
          renderModel: render_model,
          imageModel: image_model,
          slideDomain: slide_domain,
          pageCountRange: page_count_range,
          templateName: template_name,
          logoFileId: logo_file_id,
          templateFileId: template_file_id,
          slideMode: slide_mode,
          idempotencyKey: idempotency_key
        })
      );
    }
  );

  server.tool(
    "tosea_wait_for_job",
    "Poll a presentation job until completed, failed, or cancelled. When backend payload includes nested job progress, wait on data.job.status instead of the top-level presentation status.",
    {
      presentation_id: z.string().uuid(),
      timeout_seconds: z.number().int().min(5).max(3600).default(900),
      poll_interval_seconds: z.number().int().min(1).max(60).default(2),
      max_poll_interval_seconds: z.number().int().min(1).max(120).default(10)
    },
    async ({
      presentation_id,
      timeout_seconds,
      poll_interval_seconds,
      max_poll_interval_seconds
    }) => {
      return await runReadOnly(() =>
        client.waitForJob(presentation_id, {
          timeoutMs: timeout_seconds * 1000,
          pollIntervalMs: poll_interval_seconds * 1000,
          maxPollIntervalMs: max_poll_interval_seconds * 1000
        }),
        buildReadOnlyDedupeKey("tosea_wait_for_job", {
          presentation_id,
          timeout_seconds,
          poll_interval_seconds,
          max_poll_interval_seconds
        })
      );
    }
  );

  server.tool("tosea_list_exports", "List presentations that already have export history.", {}, async () => {
    return await runReadOnly(
      () => client.listExports(),
      buildReadOnlyDedupeKey("tosea_list_exports")
    );
  });

  server.tool(
    "tosea_list_export_files",
    "List user-visible exported files for a presentation.",
    { presentation_id: z.string().uuid() },
    async ({ presentation_id }) => {
      return await runReadOnly(
        () => client.listExportFiles(presentation_id),
        buildReadOnlyDedupeKey("tosea_list_export_files", {
          presentation_id
        })
      );
    }
  );

  server.tool(
    "tosea_redownload_export",
    "Get a fresh download URL for an existing exported file.",
    {
      presentation_id: z.string().uuid(),
      export_type: z.enum(["pdf", "pptx", "pptx_image", "html_zip"]),
      filename: z.string().min(1)
    },
    async ({ presentation_id, export_type, filename }) => {
      return await runReadOnly(
        () =>
          client.redownloadExport({
          presentationId: presentation_id,
          exportType: export_type,
          filename
          }),
        buildReadOnlyDedupeKey("tosea_redownload_export", {
          presentation_id,
          export_type,
          filename
        })
      );
    }
  );

  return server;
}
