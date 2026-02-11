import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathExists, readText, writeText } from "./fs";

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function resolveEnvTemplate(value: string, envMap: Record<string, string>): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, varName: string) => envMap[varName] ?? _match);
}

function loadEnvFile(filePath?: string): Record<string, string> {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf8");
  const entries: Record<string, string> = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    entries[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }

  return entries;
}

export async function mergeMcpConfig(mcpConfigFile: string, envFile?: string): Promise<void> {
  const parsed = JSON.parse(await readText(mcpConfigFile)) as McpConfig;
  const servers = parsed.mcpServers || (parsed as Record<string, unknown>);

  const claudeSettingsPath = path.join(os.homedir(), ".claude.json");
  const existing = (await pathExists(claudeSettingsPath))
    ? (JSON.parse(await readText(claudeSettingsPath)) as Record<string, unknown>)
    : {};

  const envMap = {
    ...Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key, value || ""])),
    ...loadEnvFile(envFile),
  };

  const resolved = JSON.parse(JSON.stringify(servers), (_key, value) => {
    if (typeof value === "string") {
      return resolveEnvTemplate(value, envMap);
    }
    return value;
  }) as Record<string, unknown>;

  const merged = {
    ...existing,
    mcpServers: {
      ...((existing.mcpServers as Record<string, unknown>) || {}),
      ...resolved,
    },
  };

  await writeText(claudeSettingsPath, `${JSON.stringify(merged, null, 2)}\n`);
}
