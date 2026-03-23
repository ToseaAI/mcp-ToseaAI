import { randomUUID } from "node:crypto";

import { ApiError, JobTimeoutError, extractErrorMessage } from "./errors.js";
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

async function parseResponseBody<T>(response: Response): Promise<ApiEnvelope<T> | undefined> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as ApiEnvelope<T>;
  }
  return undefined;
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

  async listPresentations(limit = 20, offset = 0): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request("/presentations", {
      method: "GET",
      query: { limit, offset },
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
  ): Promise<{ completed: boolean; final_status: JobResult }> {
    const timeoutMs = options.timeoutMs ?? 15 * 60_000;
    let intervalMs = options.pollIntervalMs ?? this.config.pollIntervalMs;
    const maxIntervalMs = options.maxPollIntervalMs ?? this.config.maxPollIntervalMs;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const envelope = await this.getJobStatus(presentationId);
      const job = envelope.data ?? {};
      const status = String(job.status || "");
      if (status === "completed" || status === "failed") {
        return {
          completed: status === "completed",
          final_status: job
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
    slideDomain?: string;
    pageCountRange?: string;
    templateName?: string;
    slideMode?: string;
  }): Promise<ApiEnvelope<Record<string, unknown>>> {
    const formData = new FormData();
    await appendFilesToFormData(formData, input.filePaths);
    formData.set("instruction", input.instruction ?? "");
    formData.set("render_provider", input.renderProvider ?? "default");
    formData.set("render_model", input.renderModel ?? "deepseek-chat-v3.1");
    formData.set("slide_domain", input.slideDomain ?? "general");
    formData.set("page_count_range", input.pageCountRange ?? "8-12");
    formData.set("template_name", input.templateName ?? "beamer_classic");
    formData.set("slide_mode", input.slideMode ?? "html");

    return this.request("/pdf-parse", {
      method: "POST",
      formData,
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
    force?: boolean | undefined;
    slidesToGenerate?: number[] | undefined;
  }): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request("/slides-render", {
      method: "POST",
      body: {
        presentation_id: input.presentationId,
        render_provider: input.renderProvider ?? undefined,
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
    outputFormat: "pdf" | "pptx" | "pptx_image";
    idempotencyKey?: string | undefined;
  }): Promise<ApiEnvelope<Record<string, unknown>>> {
    return this.request("/export", {
      method: "POST",
      body: {
        presentation_id: input.presentationId,
        output_format: input.outputFormat
      },
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      retryMode: "idempotent"
    });
  }

  async pdfToPresentation(input: {
    filePaths: string[];
    instruction?: string;
    outputFormat?: "pdf" | "pptx" | "pptx_image";
    renderProvider?: string;
    renderModel?: string;
    slideDomain?: string;
    pageCountRange?: string;
    templateName?: string;
    slideMode?: string;
  }): Promise<ApiEnvelope<Record<string, unknown>>> {
    const formData = new FormData();
    await appendFilesToFormData(formData, input.filePaths);
    formData.set("instruction", input.instruction ?? "");
    formData.set("output_format", input.outputFormat ?? "pptx");
    formData.set("render_provider", input.renderProvider ?? "default");
    formData.set("render_model", input.renderModel ?? "deepseek-chat-v3.1");
    formData.set("slide_domain", input.slideDomain ?? "general");
    formData.set("page_count_range", input.pageCountRange ?? "8-12");
    formData.set("template_name", input.templateName ?? "beamer_classic");
    formData.set("slide_mode", input.slideMode ?? "html");

    return this.request("/pdf-to-presentation", {
      method: "POST",
      formData,
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
    exportType: "pdf" | "pptx" | "pptx_image";
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

        const envelope = await parseResponseBody<T>(response);
        if (!response.ok) {
          const clonedBody = await response.clone().json().catch(() => undefined);
          const errorDetail =
            (clonedBody as { detail?: unknown } | undefined)?.detail ??
            (envelope as { detail?: unknown } | undefined)?.detail ??
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
        if (attempt + 1 >= maxAttempts) {
          throw error;
        }
        if (error instanceof ApiError && !error.isRetryable) {
          throw error;
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
