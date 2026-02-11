import path from "node:path";
import { ensureDir, pathExists, readText, writeText } from "./fs";
import { InstallState, OperationKind } from "./types";

export const INSTALL_STATE_SCHEMA_VERSION = "1.0.0";

export function getStatePath(installPath: string): string {
  return path.join(installPath, ".ica", "install-state.json");
}

export async function loadInstallState(installPath: string): Promise<InstallState | null> {
  const statePath = getStatePath(installPath);
  if (!(await pathExists(statePath))) {
    return null;
  }

  const content = await readText(statePath);
  return JSON.parse(content) as InstallState;
}

export async function saveInstallState(installPath: string, state: InstallState): Promise<void> {
  const statePath = getStatePath(installPath);
  await ensureDir(path.dirname(statePath));
  await writeText(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

export function createEmptyState(params: {
  installerVersion: string;
  target: InstallState["target"];
  scope: InstallState["scope"];
  projectPath?: string;
}): InstallState {
  const now = new Date().toISOString();
  return {
    schemaVersion: INSTALL_STATE_SCHEMA_VERSION,
    installerVersion: params.installerVersion,
    target: params.target,
    scope: params.scope,
    projectPath: params.projectPath,
    installedAt: now,
    updatedAt: now,
    managedSkills: [],
    managedBaselinePaths: [],
    history: [],
  };
}

export function appendHistory(state: InstallState, operation: OperationKind, summary: string): InstallState {
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
