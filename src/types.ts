export interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data?: T;
}

export interface ApiErrorObject {
  error?: string;
  message?: string;
  operation?: string;
  required_tier?: string | null;
  required?: number;
  available?: number;
  feature_key?: string;
  retry_after_seconds?: number;
}

export interface ClientConfig {
  apiKey: string;
  mcpApiBaseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  maxToolConcurrency: number;
  maxMutatingConcurrency: number;
  maxPendingToolRequests: number;
  pollIntervalMs: number;
  maxPollIntervalMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  formData?: FormData;
  idempotencyKey?: string;
  retryMode?: "never" | "safe" | "idempotent";
  timeoutMs?: number;
}

export interface WaitForJobOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
}

export interface JobResult {
  presentation_id?: string;
  workflow?: string;
  status?: string;
  progress?: number;
  current_step?: string | null;
  error?: string | null;
  error_message?: string | null;
  download_url?: string | null;
  filename?: string | null;
  export_type?: string | null;
  slides_count?: number | null;
  total_pages?: number | null;
  created_at?: string;
  updated_at?: string;
  steps_completed?: string[];
  active?: boolean;
  job?: JobResult | null;
  [key: string]: unknown;
}

export type FetchLike = typeof fetch;
