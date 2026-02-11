import fs from "node:fs";
import path from "node:path";
import { HarnessConfig } from "./types";

function parsePromptInjectionMode(value?: string): "block" | "warn" | "off" {
  const normalized = String(value || "block").trim().toLowerCase();
  if (normalized === "warn" || normalized === "off") {
    return normalized;
  }
  return "block";
}

export function getHarnessConfig(repoRoot: string): HarnessConfig {
  const baseRoot = process.env.ICA_HARNESS_HOME || path.join(repoRoot, ".agent", "harness");
  const cfg: HarnessConfig = {
    enabled: process.env.ICA_HARNESS_ENABLED !== "false",
    dbPath: process.env.ICA_HARNESS_DB_PATH || path.join(baseRoot, "harness.db"),
    uploadsPath: process.env.ICA_HARNESS_UPLOADS_PATH || path.join(baseRoot, "uploads"),
    artifactsPath: process.env.ICA_HARNESS_ARTIFACTS_PATH || path.join(baseRoot, "artifacts"),
    logsPath: process.env.ICA_HARNESS_LOGS_PATH || path.join(baseRoot, "logs"),
    authPath: process.env.ICA_HARNESS_AUTH_PATH || path.join(baseRoot, "auth"),
    dispatcherPollMs: Number(process.env.ICA_HARNESS_DISPATCHER_POLL_MS || "2000"),
    maxParallelRuns: Number(process.env.ICA_HARNESS_MAX_PARALLEL_RUNS || "1"),
    defaultRuntime: process.env.ICA_HARNESS_DEFAULT_RUNTIME === "host" ? "host" : "docker",
    promptInjectionMode: parsePromptInjectionMode(process.env.ICA_HARNESS_PROMPT_INJECTION_MODE),
    oauthCallbackHost: process.env.ICA_HARNESS_OAUTH_CALLBACK_HOST || process.env.ICA_DASHBOARD_HOST || "127.0.0.1",
    oauthCallbackPort: Number(process.env.ICA_HARNESS_OAUTH_CALLBACK_PORT || process.env.ICA_DASHBOARD_PORT || "4173"),
    oauthEncryptionKey:
      process.env.ICA_HARNESS_OAUTH_ENCRYPTION_KEY ||
      "ica-harness-dev-key-change-this-in-production-32bytes!!",
  };

  for (const dir of [path.dirname(cfg.dbPath), cfg.uploadsPath, cfg.artifactsPath, cfg.logsPath, cfg.authPath]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return cfg;
}
