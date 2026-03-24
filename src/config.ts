import { ConfigurationError } from "./errors.js";
import type { ClientConfig } from "./types.js";

const DEFAULT_MCP_PATH = "/api/mcp/v1";

function toPositiveInt(name: string, rawValue: string | undefined, fallback: number): number {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeMcpApiBaseUrl(rawValue: string | undefined): string {
  const baseValue = (rawValue || "https://tosea.ai").trim().replace(/\/+$/, "");
  const url = new URL(baseValue.includes("/api/") ? baseValue : `${baseValue}${DEFAULT_MCP_PATH}`);
  if (!url.pathname.endsWith(DEFAULT_MCP_PATH)) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${DEFAULT_MCP_PATH}`;
  }
  return url.toString().replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  const apiKey = (env.TOSEA_API_KEY || "").trim();
  if (!apiKey) {
    throw new ConfigurationError("TOSEA_API_KEY is required");
  }
  if (!apiKey.startsWith("sk_")) {
    throw new ConfigurationError("TOSEA_API_KEY must start with 'sk_'");
  }

  const logLevel = (env.TOSEA_LOG_LEVEL || "info").trim().toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new ConfigurationError("TOSEA_LOG_LEVEL must be one of: debug, info, warn, error");
  }

  return {
    apiKey,
    mcpApiBaseUrl: normalizeMcpApiBaseUrl(env.TOSEA_API_BASE_URL),
    timeoutMs: toPositiveInt("TOSEA_TIMEOUT_MS", env.TOSEA_TIMEOUT_MS, 45_000),
    maxRetries: toPositiveInt("TOSEA_MAX_RETRIES", env.TOSEA_MAX_RETRIES, 2),
    maxToolConcurrency: toPositiveInt(
      "TOSEA_MAX_TOOL_CONCURRENCY",
      env.TOSEA_MAX_TOOL_CONCURRENCY,
      8
    ),
    maxMutatingConcurrency: toPositiveInt(
      "TOSEA_MAX_MUTATING_CONCURRENCY",
      env.TOSEA_MAX_MUTATING_CONCURRENCY,
      4
    ),
    maxPendingToolRequests: toPositiveInt(
      "TOSEA_MAX_PENDING_TOOL_REQUESTS",
      env.TOSEA_MAX_PENDING_TOOL_REQUESTS,
      32
    ),
    pollIntervalMs: toPositiveInt("TOSEA_POLL_INTERVAL_MS", env.TOSEA_POLL_INTERVAL_MS, 2_000),
    maxPollIntervalMs: toPositiveInt("TOSEA_MAX_POLL_MS", env.TOSEA_MAX_POLL_MS, 10_000),
    logLevel: logLevel as ClientConfig["logLevel"],
  };
}
