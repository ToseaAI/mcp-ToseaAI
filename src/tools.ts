import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { redactSecrets } from "./errors.js";
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

function wrapToolError(error: unknown): McpError {
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
  const server = new McpServer({
    name: "tosea",
    version: "0.1.0"
  });

  server.tool("tosea_health", "Check MCP connectivity to ToseaAI.", {}, async () => {
    try {
      return asToolResult(await client.health());
    } catch (error) {
      throw wrapToolError(error);
    }
  });

  server.tool(
    "tosea_get_permissions_summary",
    "Inspect current account tier and feature access before expensive runs.",
    {},
    async () => {
      try {
        return asToolResult(await client.getPermissionsSummary());
      } catch (error) {
        throw wrapToolError(error);
      }
    }
  );

  server.tool(
    "tosea_get_quota_status",
    "Inspect quota status for all features or a single feature key.",
    { feature_key: z.string().min(1).optional() },
    async ({ feature_key }) => {
      try {
        return asToolResult(await client.getQuotaStatus(feature_key));
      } catch (error) {
        throw wrapToolError(error);
      }
    }
  );

  server.tool(
    "tosea_list_presentations",
    "List the current user's presentations.",
    {
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0)
    },
    async ({ limit, offset }) => {
      try {
        return asToolResult(await client.listPresentations(limit, offset));
      } catch (error) {
        throw wrapToolError(error);
      }
    }
  );

  server.tool(
    "tosea_get_presentation_full_data",
    "Fetch full structured presentation data, including outlines and slides.",
    { presentation_id: z.string().uuid() },
    async ({ presentation_id }) => {
      try {
        return asToolResult(await client.getPresentationFullData(presentation_id));
      } catch (error) {
        throw wrapToolError(error);
      }
    }
  );

  server.tool(
    "tosea_parse_pdf",
    "Upload local files and run the parse-only stage. Returns a presentation_id and job payload.",
    {
      file_paths: z.array(z.string().min(1)).min(1).max(10),
      instruction: z.string().default(""),
      render_provider: z.string().default("default"),
      render_model: z.string().default("deepseek-chat-v3.1"),
      slide_domain: z.string().default("general"),
      page_count_range: pageCountRangeSchema.default("8-12"),
      template_name: z.string().default("beamer_classic"),
      slide_mode: z.enum(["html", "image"]).default("html")
    },
    async ({
      file_paths,
      instruction,
      render_provider,
      render_model,
      slide_domain,
      page_count_range,
      template_name,
      slide_mode
    }) => {
      try {
        return asToolResult(
          await client.pdfParse({
            filePaths: file_paths,
            instruction,
            renderProvider: render_provider,
            renderModel: render_model,
            slideDomain: slide_domain,
            pageCountRange: page_count_range,
            templateName: template_name,
            slideMode: slide_mode
          })
        );
      } catch (error) {
        throw wrapToolError(error);
      }
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
      try {
        return asToolResult(
          await client.generateOutline({
            presentationId: presentation_id,
            instruction,
            renderProvider: render_provider
          })
        );
      } catch (error) {
        throw wrapToolError(error);
      }
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
      try {
        return asToolResult(
          await client.editOutlinePage({
            presentationId: presentation_id,
            pageNumber: page_number,
            action,
            instruction,
            modelName: model_name,
            afterSlide: after_slide,
            idempotencyKey: idempotency_key
          })
        );
      } catch (error) {
        throw wrapToolError(error);
      }
    }
  );

  server.tool(
    "tosea_render_slides",
    "Queue slide rendering for all slides or a subset of slide numbers.",
    {
      presentation_id: z.string().uuid(),
      render_provider: z.string().optional(),
      force: z.boolean().default(false),
      slides_to_generate: z.array(z.number().int().min(1)).max(50).optional()
    },
    async ({ presentation_id, render_provider, force, slides_to_generate }) => {
      try {
        return asToolResult(
          await client.renderSlides({
            presentationId: presentation_id,
            renderProvider: render_provider,
            force,
            slidesToGenerate: normalizeSlideNumbers(slides_to_generate)
          })
        );
      } catch (error) {
        throw wrapToolError(error);
      }
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
      try {
        const screenshotBase64 = await maybeReadBase64File(screenshot_path);
        return asToolResult(
          await client.editSlidePage({
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
          })
        );
      } catch (error) {
        throw wrapToolError(error);
      }
    }
  );

  server.tool(
    "tosea_export_presentation",
    "Queue an export job for a completed presentation.",
    {
      presentation_id: z.string().uuid(),
      output_format: z.enum(["pdf", "pptx", "pptx_image"]),
      idempotency_key: z.string().min(8).optional()
    },
    async ({ presentation_id, output_format, idempotency_key }) => {
      try {
        return asToolResult(
          await client.exportPresentation({
            presentationId: presentation_id,
            outputFormat: output_format,
            idempotencyKey: idempotency_key
          })
        );
      } catch (error) {
        throw wrapToolError(error);
      }
    }
  );

  server.tool(
    "tosea_pdf_to_presentation",
    "Upload local files and generate a final export in one shot.",
    {
      file_paths: z.array(z.string().min(1)).min(1).max(10),
      instruction: z.string().default(""),
      output_format: z.enum(["pdf", "pptx", "pptx_image"]).default("pptx"),
      render_provider: z.string().default("default"),
      render_model: z.string().default("deepseek-chat-v3.1"),
      slide_domain: z.string().default("general"),
      page_count_range: pageCountRangeSchema.default("8-12"),
      template_name: z.string().default("beamer_classic"),
      slide_mode: z.enum(["html", "image"]).default("html")
    },
    async ({
      file_paths,
      instruction,
      output_format,
      render_provider,
      render_model,
      slide_domain,
      page_count_range,
      template_name,
      slide_mode
    }) => {
      try {
        return asToolResult(
          await client.pdfToPresentation({
            filePaths: file_paths,
            instruction,
            outputFormat: output_format,
            renderProvider: render_provider,
            renderModel: render_model,
            slideDomain: slide_domain,
            pageCountRange: page_count_range,
            templateName: template_name,
            slideMode: slide_mode
          })
        );
      } catch (error) {
        throw wrapToolError(error);
      }
    }
  );

  server.tool(
    "tosea_wait_for_job",
    "Poll a presentation job until completed or failed and return the final job payload.",
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
      try {
        return asToolResult(
          await client.waitForJob(presentation_id, {
            timeoutMs: timeout_seconds * 1000,
            pollIntervalMs: poll_interval_seconds * 1000,
            maxPollIntervalMs: max_poll_interval_seconds * 1000
          })
        );
      } catch (error) {
        throw wrapToolError(error);
      }
    }
  );

  server.tool("tosea_list_exports", "List presentations that already have export history.", {}, async () => {
    try {
      return asToolResult(await client.listExports());
    } catch (error) {
      throw wrapToolError(error);
    }
  });

  server.tool(
    "tosea_list_export_files",
    "List user-visible exported files for a presentation.",
    { presentation_id: z.string().uuid() },
    async ({ presentation_id }) => {
      try {
        return asToolResult(await client.listExportFiles(presentation_id));
      } catch (error) {
        throw wrapToolError(error);
      }
    }
  );

  server.tool(
    "tosea_redownload_export",
    "Get a fresh download URL for an existing exported file.",
    {
      presentation_id: z.string().uuid(),
      export_type: z.enum(["pdf", "pptx", "pptx_image"]),
      filename: z.string().min(1)
    },
    async ({ presentation_id, export_type, filename }) => {
      try {
        return asToolResult(
          await client.redownloadExport({
            presentationId: presentation_id,
            exportType: export_type,
            filename
          })
        );
      } catch (error) {
        throw wrapToolError(error);
      }
    }
  );

  return server;
}
