import type { ApiErrorObject } from "./types.js";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly detail: unknown;
  readonly isRetryable: boolean;

  constructor(
    message: string,
    options: {
      status: number;
      path: string;
      detail?: unknown;
      isRetryable?: boolean;
    },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.path = options.path;
    this.detail = options.detail;
    this.isRetryable = options.isRetryable ?? false;
  }
}

export class JobTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobTimeoutError";
  }
}

export function extractErrorMessage(detail: unknown): string {
  if (typeof detail === "string" && detail.trim()) {
    return detail;
  }
  if (detail && typeof detail === "object") {
    const objectDetail = detail as ApiErrorObject;
    if (typeof objectDetail.message === "string" && objectDetail.message.trim()) {
      return objectDetail.message;
    }
    if (typeof objectDetail.error === "string" && objectDetail.error.trim()) {
      return objectDetail.error;
    }
  }
  return "ToseaAI request failed";
}

export function redactSecrets(input: string): string {
  return input.replace(/sk_[A-Za-z0-9_-]{8,}/g, "sk_[redacted]");
}

