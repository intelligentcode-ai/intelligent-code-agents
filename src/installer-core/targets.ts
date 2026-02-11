import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { SUPPORTED_TARGETS, TARGET_HOME_DIR } from "./constants";
import { InstallScope, ResolvedTargetPath, TargetPlatform } from "./types";

function hasCommand(command: string): boolean {
  try {
    execSync(process.platform === "win32" ? `where ${command}` : `command -v ${command}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasDir(dirPath: string): boolean {
  return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
}

export function discoverTargets(): TargetPlatform[] {
  const home = os.homedir();
  const targets: TargetPlatform[] = [];

  if (hasDir(path.join(home, ".claude")) || hasCommand("claude")) {
    targets.push("claude");
  }

  if (
    hasDir(path.join(home, ".codex")) ||
    hasCommand("codex") ||
    (process.platform === "darwin" && hasDir("/Applications/Codex.app"))
  ) {
    targets.push("codex");
  }

  if (
    hasDir(path.join(home, ".cursor")) ||
    hasCommand("cursor") ||
    hasDir(path.join(home, "Library/Application Support/Cursor")) ||
    hasDir(path.join(home, ".config/Cursor"))
  ) {
    targets.push("cursor");
  }

  if (hasDir(path.join(home, ".gemini")) || hasCommand("gemini") || hasDir(path.join(home, ".config/gemini"))) {
    targets.push("gemini");
  }

  if (hasDir(path.join(home, ".antigravity")) || hasCommand("antigravity")) {
    targets.push("antigravity");
  }

  return Array.from(new Set(targets));
}

export function parseTargets(value?: string): TargetPlatform[] {
  if (!value || !value.trim()) {
    return discoverTargets();
  }

  const requested = value
    .split(/[\s,]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const valid = requested.filter((item): item is TargetPlatform => SUPPORTED_TARGETS.includes(item as TargetPlatform));
  return Array.from(new Set(valid));
}

export function resolveInstallPath(
  target: TargetPlatform,
  scope: InstallScope,
  projectPath?: string,
  agentDirName?: string,
): string {
  const homeDir = agentDirName || TARGET_HOME_DIR[target];
  if (scope === "project") {
    if (!projectPath) {
      throw new Error("projectPath is required for project scope");
    }
    return path.resolve(projectPath, homeDir);
  }
  return path.resolve(os.homedir(), homeDir);
}

export function resolveTargetPaths(
  targets: TargetPlatform[],
  scope: InstallScope,
  projectPath?: string,
  agentDirName?: string,
): ResolvedTargetPath[] {
  return targets.map((target) => ({
    target,
    scope,
    projectPath: scope === "project" ? path.resolve(projectPath || "") : undefined,
    installPath: resolveInstallPath(target, scope, projectPath, agentDirName),
  }));
}
