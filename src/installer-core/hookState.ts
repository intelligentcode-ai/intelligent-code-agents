import path from "node:path";
import { ensureDir, pathExists, readText, writeText } from "./fs";

export type HookOperationKind = "install" | "uninstall" | "sync";

export interface ManagedHookState {
  name: string;
  hookName?: string;
  hookId: string;
  sourceId: string;
  sourceUrl: string;
  sourceRevision?: string;
  orphaned?: boolean;
  installMode: "symlink" | "copy";
  effectiveMode: "symlink" | "copy";
  destinationPath: string;
  sourcePath: string;
}

export interface HookOperationLogEntry {
  timestamp: string;
  operation: HookOperationKind;
  summary: string;
}

export interface HookInstallState {
  schemaVersion: string;
  installerVersion: string;
  target: "claude" | "gemini";
  scope: "user" | "project";
  projectPath?: string;
  installedAt: string;
  updatedAt: string;
  managedHooks: ManagedHookState[];
  managedBaselinePaths: string[];
  history: HookOperationLogEntry[];
}

export const HOOK_INSTALL_STATE_SCHEMA_VERSION = "1.0.0";

export function getHookStatePath(installPath: string): string {
  return path.join(installPath, ".ica", "hook-install-state.json");
}

export async function loadHookInstallState(installPath: string): Promise<HookInstallState | null> {
  const statePath = getHookStatePath(installPath);
  if (!(await pathExists(statePath))) {
    return null;
  }

  const content = await readText(statePath);
  return JSON.parse(content) as HookInstallState;
}

export async function saveHookInstallState(installPath: string, state: HookInstallState): Promise<void> {
  const statePath = getHookStatePath(installPath);
  await ensureDir(path.dirname(statePath));
  await writeText(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function createEmptyHookState(params: {
  installerVersion: string;
  target: HookInstallState["target"];
  scope: HookInstallState["scope"];
  projectPath?: string;
}): HookInstallState {
  const now = new Date().toISOString();
  return {
    schemaVersion: HOOK_INSTALL_STATE_SCHEMA_VERSION,
    installerVersion: params.installerVersion,
    target: params.target,
    scope: params.scope,
    projectPath: params.projectPath,
    installedAt: now,
    updatedAt: now,
    managedHooks: [],
    managedBaselinePaths: [],
    history: [],
  };
}

export function appendHookHistory(state: HookInstallState, operation: HookOperationKind, summary: string): HookInstallState {
  const next = { ...state };
  next.updatedAt = new Date().toISOString();
  next.history = [
    ...next.history,
    {
      timestamp: next.updatedAt,
      operation,
      summary,
    },
  ].slice(-100);
  return next;
}
