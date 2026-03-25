import { randomUUID } from "node:crypto";

import {
  ApiError,
  JobTimeoutError,
  TransportError,
  extractErrorMessage,
  normalizeRequestError
} from "./errors.js";
import type {
  ApiEnvelope,
  ClientConfig,
  FetchLike,
  JobResult,
  RequestOptions,
  WaitForJobOptions
} from "./types.js";
import { appendFilesToFormData } from "./uploads.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJitter(ms: number): number {
  const delta = Math.round(ms * 0.1);
  return ms + Math.floor(Math.random() * (delta + 1));
}

function canRetry(method: string, retryMode: RequestOptions["retryMode"]): boolean {
  if (retryMode === "never") {
    return false;
  }
  if (retryMode === "idempotent") {
    return method === "GET" || method === "POST";
  }
  return method === "GET";
}

function asJobResult(value: unknown): JobResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JobResult;
}

function resolveJobStatus(payload: JobResult): string {
  const nestedJob = asJobResult(payload.job);
  const nestedStatus = typeof nestedJob?.status === "string" ? nestedJob.status : "";
  if (nestedStatus) {
    return nestedStatus;
  }
  return typeof payload.status === "string" ? payload.status : "";
}

async function parseResponseBody<T>(
  response: Response
): Promise<{ envelope?: ApiEnvelope<T>; raw?: unknown; rawText?: string }> {
  const contentType = response.headers.get("content-type") || "";
  const rawText = await response.text();
  if (!rawText) {
    return {};
  }
  if (contentType.includes("application/json")) {
    try {
      const raw = JSON.parse(rawText) as unknown;
      if (raw && typeof raw === "object") {
        return { envelope: raw as ApiEnvelope<T>, raw, rawText };
      }
      return { raw, rawText };
    } catch {
      return { rawText };
    }
  }
  return { rawText };
}

export class ToseaClient {
  constructor(
    private readonly config: ClientConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async health(): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request("/health", { method: "GET", retryMode: "safe" });
  }

  async getPermissionsSummary(): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request("/permissions/features/summary", {
      method: "GET",
      retryMode: "safe"
    });
  }

  async getQuotaStatus(featureKey?: string): Promise<ApiEnvelope<Record<string, unknown>>> {
    const path = featureKey
      ? `/permissions/quotas/${encodeURIComponent(featureKey)}/status`
      : "/permissions/quotas/status";
    return this.request(path, { method: "GET", retryMode: "safe" });
  }

  async listPresentations(input: {
    page?: number;
    perPage?: number;
    status?: string;
    search?: string;
  } = {}): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request("/presentations", {
      method: "GET",
      query: {
        page: input.page ?? 1,
        per_page: input.perPage ?? 20,
        status: input.status,
        search: input.search
      },
      retryMode: "safe"
    });
  }

  async getPresentationFullData(
    presentationId: string
  ): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request(`/presentations/${presentationId}/full-data`, {
      method: "GET",
      retryMode: "safe"
    });
  }

  async getJobStatus(presentationId: string): Promise<ApiEnvelope<JobResult>> {
    return this.request(`/jobs/${presentationId}`, {
      method: "GET",
      retryMode: "safe"
    });
  }

  async waitForJob(
    presentationId: string,
    options: WaitForJobOptions = {}
  ): Promise<{ completed: boolean; terminal_status: string; final_status: JobResult }> {
    const timeoutMs = options.timeoutMs ?? 15 * 60_000;
    let intervalMs = options.pollIntervalMs ?? this.config.pollIntervalMs;
    const maxIntervalMs = options.maxPollIntervalMs ?? this.config.maxPollIntervalMs;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const envelope = await this.getJobStatus(presentationId);
      const payload = envelope.data ?? {};
      const terminalStatus = resolveJobStatus(payload);
      if (terminalStatus === "completed" || terminalStatus === "failed" || terminalStatus === "cancelled") {
        return {
          completed: terminalStatus === "completed",
          terminal_status: terminalStatus,
          final_status: payload
        };
      }
      await sleep(withJitter(intervalMs));
      intervalMs = Math.min(maxIntervalMs, Math.round(intervalMs * 1.5));
    }

    throw new JobTimeoutError(
      `Timed out waiting for presentation ${presentationId} after ${timeoutMs} ms`
    );
  }

  async pdfParse(input: {
    filePaths: string[];
    instruction?: string;
    renderProvider?: string;
    renderModel?: string;
    imageModel?: string | undefined;
    slideDomain?: string;
    pageCountRange?: string;
    templateName?: string;
    logoFileId?: string | undefined;
    templateFileId?: string | undefined;
    slideMode?: string;
    idempotencyKey?: string | undefined;
  }): Promise<ApiEnvelope<Record<string, unknown>>> {
    const formData = new FormData();
    await appendFilesToFormData(formData, input.filePaths);
    formData.set("instruction", input.instruction ?? "");
    formData.set("render_provider", input.renderProvider ?? "default");
    formData.set("render_model", input.renderModel ?? "deepseek-chat-v3.1");
    if (input.imageModel) {
      formData.set("image_model", input.imageModel);
    }
    formData.set("slide_domain", input.slideDomain ?? "general");
    formData.set("page_count_range", input.pageCountRange ?? "8-12");
    formData.set("template_name", input.templateName ?? "beamer_classic");
    if (input.logoFileId) {
      formData.set("logo_file_id", input.logoFileId);
    }
    if (input.templateFileId) {
      formData.set("template_file_id", input.templateFileId);
    }
    formData.set("slide_mode", input.slideMode ?? "html");

    return this.request("/pdf-parse", {
      method: "POST",
      formData,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      retryMode: "never"
    });
  }

  async generateOutline(input: {
    presentationId: string;
    instruction?: string | undefined;
    renderProvider?: string | undefined;
  }): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request("/outline-generate", {
      method: "POST",
      body: {
        presentation_id: input.presentationId,
        instruction: input.instruction ?? "",
        render_provider: input.renderProvider ?? undefined
      },
      retryMode: "never"
    });
  }

  async editOutlinePage(input: {
    presentationId: string;
    pageNumber: number;
    action: "modify" | "insert";
    instruction: string;
    modelName?: string | undefined;
    afterSlide?: number | undefined;
    idempotencyKey?: string | undefined;
  }): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request(
      `/presentations/${input.presentationId}/outlines/${input.pageNumber}/ai-edit`,
      {
        method: "POST",
        body: {
          action: input.action,
          instruction: input.instruction,
          model_name: input.modelName,
          after_slide: input.afterSlide
        },
        idempotencyKey: input.idempotencyKey ?? randomUUID(),
        retryMode: "idempotent"
      }
    );
  }

  async renderSlides(input: {
    presentationId: string;
    renderProvider?: string | undefined;
    renderModel?: string | undefined;
    imageModel?: string | undefined;
    force?: boolean | undefined;
    slidesToGenerate?: number[] | undefined;
  }): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request("/slides-render", {
      method: "POST",
      body: {
        presentation_id: input.presentationId,
        render_provider: input.renderProvider ?? undefined,
        render_model: input.renderModel ?? undefined,
        image_model: input.imageModel ?? undefined,
        force: input.force ?? false,
        slides_to_generate: input.slidesToGenerate
      },
      retryMode: "never"
    });
  }

  async editSlidePage(input: {
    presentationId: string;
    pageNumber: number;
    action: "modify" | "insert";
    instruction: string;
    editMode?: "outline_layout" | "layout_only" | undefined;
    modelName?: string | undefined;
    imageModel?: string | undefined;
    afterSlide?: number | undefined;
    screenshotBase64?: string | undefined;
    idempotencyKey?: string | undefined;
  }): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request(
      `/presentations/${input.presentationId}/slides/${input.pageNumber}/ai-edit`,
      {
        method: "POST",
        body: {
          action: input.action,
          instruction: input.instruction,
          edit_mode: input.editMode ?? "outline_layout",
          model_name: input.modelName,
          image_model: input.imageModel,
          after_slide: input.afterSlide,
          screenshot_base64: input.screenshotBase64
        },
        idempotencyKey: input.idempotencyKey ?? randomUUID(),
        retryMode: "idempotent"
      }
    );
  }

  async exportPresentation(input: {
    presentationId: string;
    outputFormat: "pdf" | "pptx" | "pptx_image" | "html_zip";
    exportFilename?: string | undefined;
    idempotencyKey?: string | undefined;
  }): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request("/export", {
      method: "POST",
      body: {
        presentation_id: input.presentationId,
        output_format: input.outputFormat,
        export_filename: input.exportFilename
      },
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      retryMode: "idempotent"
    });
  }

  async pdfToPresentation(input: {
    filePaths: string[];
    instruction?: string;
    outputFormat?: "pdf" | "pptx" | "pptx_image";
    exportFilename?: string | undefined;
    renderProvider?: string;
    renderModel?: string;
    imageModel?: string | undefined;
    slideDomain?: string;
    pageCountRange?: string;
    templateName?: string;
    logoFileId?: string | undefined;
    templateFileId?: string | undefined;
    slideMode?: string;
    idempotencyKey?: string | undefined;
  }): Promise<ApiEnvelope<Record<string, unknown>>> {
    const formData = new FormData();
    await appendFilesToFormData(formData, input.filePaths);
    formData.set("instruction", input.instruction ?? "");
    formData.set("output_format", input.outputFormat ?? "pptx");
    if (input.exportFilename) {
      formData.set("export_filename", input.exportFilename);
    }
    formData.set("render_provider", input.renderProvider ?? "default");
    formData.set("render_model", input.renderModel ?? "deepseek-chat-v3.1");
    if (input.imageModel) {
      formData.set("image_model", input.imageModel);
    }
    formData.set("slide_domain", input.slideDomain ?? "general");
    formData.set("page_count_range", input.pageCountRange ?? "8-12");
    formData.set("template_name", input.templateName ?? "beamer_classic");
    if (input.logoFileId) {
      formData.set("logo_file_id", input.logoFileId);
    }
    if (input.templateFileId) {
      formData.set("template_file_id", input.templateFileId);
    }
    formData.set("slide_mode", input.slideMode ?? "html");

    return this.request("/pdf-to-presentation", {
      method: "POST",
      formData,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      retryMode: "never"
    });
  }

  async listExports(): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request("/exports", { method: "GET", retryMode: "safe" });
  }

  async listExportFiles(presentationId: string): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request(`/exports/${presentationId}/files`, {
      method: "GET",
      retryMode: "safe"
    });
  }

  async redownloadExport(input: {
    presentationId: string;
    exportType: "pdf" | "pptx" | "pptx_image" | "html_zip";
    filename: string;
  }): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request(`/exports/${input.presentationId}/download/${input.exportType}`, {
      method: "GET",
      query: { filename: input.filename },
      retryMode: "safe"
    });
  }

  private async request<T>(path: string, options: RequestOptions): Promise<ApiEnvelope<T>> {
    const method = options.method ?? "GET";
    const url = new URL(`${this.config.mcpApiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    let attempt = 0;
    const maxAttempts = canRetry(method, options.retryMode) ? this.config.maxRetries + 1 : 1;

    while (attempt < maxAttempts) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? this.config.timeoutMs
      );

      try {
        const headers = new Headers({
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: "application/json"
        });
        if (options.idempotencyKey) {
          headers.set("X-Idempotency-Key", options.idempotencyKey);
        }

        let body: BodyInit | undefined;
        if (options.formData) {
          body = options.formData;
        } else if (options.body !== undefined) {
          headers.set("Content-Type", "application/json");
          body = JSON.stringify(options.body);
        }

        const requestInit: RequestInit = {
          method,
          headers,
          signal: controller.signal
        };
        if (body !== undefined) {
          requestInit.body = body;
        }

        const response = await this.fetchImpl(url, requestInit);
        const parsedBody = await parseResponseBody<T>(response);
        const envelope = parsedBody.envelope;
        if (!response.ok) {
          const errorDetail =
            (parsedBody.raw as { detail?: unknown } | undefined)?.detail ??
            (envelope as { detail?: unknown } | undefined)?.detail ??
            parsedBody.raw ??
            parsedBody.rawText ??
            envelope;
          const retryAfterHeader = response.headers.get("retry-after");
          const retryAfterMs = retryAfterHeader
            ? Number.parseInt(retryAfterHeader, 10) * 1000
            : undefined;
          const retryable = response.status === 429 || response.status >= 500;
          const apiError = new ApiError(extractErrorMessage(errorDetail), {
            status: response.status,
            path,
            detail: errorDetail,
            isRetryable: retryable
          });
          if (attempt + 1 < maxAttempts && retryable) {
            await sleep(retryAfterMs ?? withJitter(500 * (attempt + 1)));
            attempt += 1;
            continue;
          }
          throw apiError;
        }

        if (!envelope) {
          return { success: true } as ApiEnvelope<T>;
        }
        if (!envelope.success) {
          throw new ApiError("ToseaAI returned an unsuccessful response", {
            status: response.status,
            path,
            detail: envelope
          });
        }
        return envelope;
      } catch (error) {
        const normalizedError = normalizeRequestError(error, path);
        if (attempt + 1 >= maxAttempts) {
          throw normalizedError;
        }
        if (
          (normalizedError instanceof ApiError && !normalizedError.isRetryable) ||
          (normalizedError instanceof TransportError && !normalizedError.isRetryable)
        ) {
          throw normalizedError;
        }

        await sleep(withJitter(500 * (attempt + 1)));
        attempt += 1;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new ApiError("ToseaAI request failed after retries", {
      status: 500,
      path
    });
  }
}
