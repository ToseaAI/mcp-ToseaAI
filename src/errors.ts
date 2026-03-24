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

export class TransportError extends Error {
  readonly path: string;
  readonly detail: unknown;
  readonly isRetryable: boolean;

  constructor(
    message: string,
    options: {
      path: string;
      detail?: unknown;
      isRetryable?: boolean;
    }
  ) {
    super(message);
    this.name = "TransportError";
    this.path = options.path;
    this.detail = options.detail;
    this.isRetryable = options.isRetryable ?? true;
  }
}

export class BackpressureError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs = 1000) {
    super(message);
    this.name = "BackpressureError";
    this.retryAfterMs = retryAfterMs;
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

function messageLooksTransportLike(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("terminated") ||
    normalized.includes("fetch failed") ||
    normalized.includes("connection closed") ||
    normalized.includes("econnreset") ||
    normalized.includes("socket") ||
    normalized.includes("abort") ||
    normalized.includes("network")
  );
}

export function normalizeRequestError(
  error: unknown,
  path: string
): ApiError | TransportError | Error {
  if (error instanceof ApiError || error instanceof TransportError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new TransportError(
      "ToseaAI host transport timed out before a response was received. Retry with the same idempotency key.",
      {
        path,
        detail: { name: error.name, message: error.message },
        isRetryable: true,
      }
    );
  }
  if (error instanceof TypeError || error instanceof Error) {
    const detail = { name: error.name, message: error.message };
    if (messageLooksTransportLike(error.message)) {
      return new TransportError(
        "ToseaAI host transport terminated while processing the request. Retry with the same idempotency key.",
        {
          path,
          detail,
          isRetryable: true,
        }
      );
    }
    return error;
  }
  return new Error(String(error));
}
