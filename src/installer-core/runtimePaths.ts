import os from "node:os";
import path from "node:path";
import { TARGET_HOME_DIR } from "./constants";
import { TargetPlatform } from "./types";

function cleanEnvPath(value: string | undefined): string | null {
  if (!value || !value.trim()) {
    return null;
  }
  return path.resolve(value.trim());
}

function normalizeTarget(value: string | undefined): TargetPlatform | null {
  const normalized = (value || "").trim().toLowerCase();
  if (
    normalized === "claude" ||
    normalized === "codex" ||
    normalized === "cursor" ||
    normalized === "gemini" ||
    normalized === "antigravity"
  ) {
    return normalized;
  }
  return null;
}

export function getIcaGlobalRoot(homeDir = os.homedir()): string {
  return cleanEnvPath(process.env.ICA_STATE_HOME) ||
    cleanEnvPath(process.env.ICA_GLOBAL_HOME) ||
    path.resolve(homeDir, ".ica");
}

export function resolveActiveAgentHome(options: { homeDir?: string } = {}): string | null {
  const explicitHome = cleanEnvPath(process.env.ICA_HOME);
  if (explicitHome) {
    return explicitHome;
  }

  const activeTarget = normalizeTarget(process.env.ICA_ACTIVE_TARGET);
  if (!activeTarget) {
    return null;
  }

  const homeDir = options.homeDir || os.homedir();
  return path.resolve(homeDir, TARGET_HOME_DIR[activeTarget]);
}
