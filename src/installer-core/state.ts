import path from "node:path";
import { ensureDir, pathExists, readText, writeText } from "./fs";
import { InstallState, OperationKind, SkillCatalog } from "./types";

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

export function reconcileLegacyManagedSkills(state: InstallState, catalog: SkillCatalog): InstallState {
  const updated = state.managedSkills.map((managed) => {
    const hasSourceBinding = Boolean(managed.sourceId && managed.skillId);
    const candidates = catalog.skills.filter((skill) => skill.name === managed.name);

    if (hasSourceBinding) {
      const found = catalog.skills.find((skill) => skill.skillId === managed.skillId);
      if (found) {
        return {
          ...managed,
          skillName: found.skillName,
          sourceId: found.sourceId,
          sourceUrl: found.sourceUrl,
          sourcePath: found.sourcePath,
          orphaned: false,
        };
      }
      return {
        ...managed,
        sourceId: managed.sourceId || "unknown",
        sourceUrl: managed.sourceUrl || "",
        skillId: managed.skillId || `${managed.sourceId || "unknown"}/${managed.name}`,
        skillName: managed.skillName || managed.name,
        orphaned: true,
      };
    }

    if (candidates.length === 1) {
      const only = candidates[0];
      return {
        ...managed,
        skillName: only.skillName,
        sourceId: only.sourceId,
        sourceUrl: only.sourceUrl,
        sourcePath: only.sourcePath,
        skillId: only.skillId,
        orphaned: false,
      };
    }

    return {
      ...managed,
      skillName: managed.skillName || managed.name,
      sourceId: "unknown",
      sourceUrl: "",
      skillId: `unknown/${managed.name}`,
      orphaned: true,
    };
  });

  return {
    ...state,
    managedSkills: updated,
  };
}
