import path from "node:path";
import { copyPath, ensureDir, removePath, trySymlinkDirectory } from "./fs";
import { loadHookCatalogFromSources, findHookById, resolveHookSelections, HookInstallSelection } from "./hookCatalog";
import { appendHookHistory, createEmptyHookState, loadHookInstallState, ManagedHookState, saveHookInstallState } from "./hookState";
import { parseTargets, resolveTargetPaths } from "./targets";
import { computeDirectoryDigest } from "./contentDigest";

export type HookTargetPlatform = "claude" | "gemini";
export type HookInstallScope = "user" | "project";
export type HookInstallMode = "symlink" | "copy";
export type HookOperation = "install" | "uninstall" | "sync";

export interface HookInstallRequest {
  operation: HookOperation;
  targets: HookTargetPlatform[];
  scope: HookInstallScope;
  projectPath?: string;
  agentDirName?: string;
  mode: HookInstallMode;
  hooks: string[];
  hookSelections?: HookInstallSelection[];
  removeUnselected?: boolean;
  force?: boolean;
}

export interface HookOperationWarning {
  code: string;
  message: string;
}

export interface HookOperationError {
  code: string;
  message: string;
}

export interface HookTargetOperationReport {
  target: HookTargetPlatform;
  installPath: string;
  operation: HookOperation;
  appliedHooks: string[];
  removedHooks: string[];
  skippedHooks: string[];
  warnings: HookOperationWarning[];
  errors: HookOperationError[];
}

export interface HookOperationReport {
  startedAt: string;
  completedAt: string;
  request: HookInstallRequest;
  targets: HookTargetOperationReport[];
}

function pushWarning(report: HookTargetOperationReport, code: string, message: string): void {
  report.warnings.push({ code, message });
}

function pushError(report: HookTargetOperationReport, code: string, message: string): void {
  report.errors.push({ code, message });
}

function verifyHookSourceIntegrity(hook: NonNullable<ReturnType<typeof findHookById>>, report: HookTargetOperationReport): string {
  const actual = computeDirectoryDigest(hook.sourcePath);
  const expected = hook.contentDigest || actual.digest;

  if (!hook.contentDigest) {
    pushWarning(
      report,
      "MISSING_HOOK_DIGEST",
      `Hook '${hook.hookId}' did not provide a catalog content digest; verified using runtime source digest only.`,
    );
  }

  if (actual.digest !== expected) {
    throw new Error(
      `Integrity verification failed for '${hook.hookId}'. Expected ${expected}, received ${actual.digest}.`,
    );
  }

  return expected;
}

function verifyInstalledHookIntegrity(destinationPath: string, expectedDigest: string): void {
  const installed = computeDirectoryDigest(destinationPath);
  if (installed.digest !== expectedDigest) {
    throw new Error(`Installed hook digest mismatch at '${destinationPath}'. Expected ${expectedDigest}, received ${installed.digest}.`);
  }
}

function defaultTargetReport(target: HookTargetPlatform, installPath: string, operation: HookOperation): HookTargetOperationReport {
  return {
    target,
    installPath,
    operation,
    appliedHooks: [],
    removedHooks: [],
    skippedHooks: [],
    warnings: [],
    errors: [],
  };
}

function toHookTargets(requested: HookTargetPlatform[]): HookTargetPlatform[] {
  const valid = new Set<HookTargetPlatform>(["claude", "gemini"]);
  return requested.filter((target) => valid.has(target));
}

async function uninstallTarget(request: HookInstallRequest, installPath: string, report: HookTargetOperationReport): Promise<void> {
  if (request.force) {
    await removePath(path.join(installPath, "hooks"));
    await removePath(path.join(installPath, ".ica", "hook-install-state.json"));
    return;
  }

  const state = await loadHookInstallState(installPath);
  if (!state) {
    return;
  }

  const selections = request.hookSelections || [];
  const selected = new Set(selections.map((selection) => selection.hookId));
  const removeAll = selections.length === 0;

  for (const managed of state.managedHooks) {
    const managedId = managed.hookId || managed.name;
    if (!removeAll && !selected.has(managedId) && !selected.has(managed.name)) continue;
    await removePath(managed.destinationPath);
    report.removedHooks.push(managedId);
  }

  const removedSet = new Set(report.removedHooks);
  const remainingHooks = state.managedHooks.filter((managed) => !removedSet.has(managed.hookId || managed.name));

  if (removeAll && remainingHooks.length === 0) {
    await removePath(path.join(installPath, ".ica", "hook-install-state.json"));
    return;
  }

  const next = appendHookHistory(
    {
      ...state,
      managedHooks: remainingHooks,
    },
    "uninstall",
    `Removed ${report.removedHooks.length} hook(s)`,
  );
  await saveHookInstallState(installPath, next);
}

async function installOrSyncTarget(repoRoot: string, request: HookInstallRequest, installPath: string, report: HookTargetOperationReport): Promise<void> {
  const catalog = await loadHookCatalogFromSources(repoRoot, true);

  const rawState =
    (await loadHookInstallState(installPath)) ||
    createEmptyHookState({
      installerVersion: catalog.version,
      target: report.target,
      scope: request.scope,
      projectPath: request.projectPath,
    });
  const selections = resolveHookSelections(catalog, request.hookSelections, request.hooks);
  const selectedHookIds = selections.map((selection) => selection.hookId);

  const hooksDir = path.join(installPath, "hooks");
  await ensureDir(hooksDir);

  const removeUnselected = request.operation === "sync" || Boolean(request.removeUnselected);

  const existingById = new Map(rawState.managedHooks.map((managed) => [managed.hookId || managed.name, managed]));
  const nextManagedHooks = [...rawState.managedHooks];

  if (removeUnselected) {
    for (const managed of rawState.managedHooks) {
      const managedId = managed.hookId || managed.name;
      if (selectedHookIds.includes(managedId)) continue;
      await removePath(managed.destinationPath);
      report.removedHooks.push(managedId);
    }
  }

  const selectedNames = new Set<string>();
  for (const hookId of selectedHookIds) {
    const hook = findHookById(catalog, hookId);
    if (!hook) {
      report.skippedHooks.push(hookId);
      pushWarning(report, "UNKNOWN_HOOK", `Unknown hook '${hookId}' was skipped.`);
      continue;
    }

    if (selectedNames.has(hook.hookName)) {
      report.skippedHooks.push(hook.hookId);
      pushWarning(
        report,
        "DUPLICATE_HOOK_NAME",
        `Skipped '${hook.hookId}' because hook name '${hook.hookName}' is already selected from another source.`,
      );
      continue;
    }
    selectedNames.add(hook.hookName);

    const destination = path.join(hooksDir, hook.name);
    await removePath(destination);
    const expectedDigest = verifyHookSourceIntegrity(hook, report);

    let effectiveMode: HookInstallMode = request.mode;
    if (request.mode === "symlink") {
      try {
        await trySymlinkDirectory(hook.sourcePath, destination);
      } catch {
        effectiveMode = "copy";
        await copyPath(hook.sourcePath, destination);
        pushWarning(report, "SYMLINK_FALLBACK", `Symlink failed for '${hook.name}', fell back to copy mode.`);
      }
    } else {
      await copyPath(hook.sourcePath, destination);
    }

    if (effectiveMode === "copy") {
      verifyInstalledHookIntegrity(destination, expectedDigest);
    }

    const managed: ManagedHookState = {
      name: hook.name,
      hookName: hook.hookName,
      hookId: hook.hookId,
      sourceId: hook.sourceId,
      sourceUrl: hook.sourceUrl,
      sourceRevision: catalog.sources.find((source) => source.id === hook.sourceId)?.revision,
      sourceContentDigest: expectedDigest,
      orphaned: false,
      installMode: request.mode,
      effectiveMode,
      destinationPath: destination,
      sourcePath: hook.sourcePath,
    };

    const existing = existingById.get(hook.hookId);
    if (existing) {
      const index = nextManagedHooks.findIndex((item) => (item.hookId || item.name) === hook.hookId);
      if (index >= 0) nextManagedHooks[index] = managed;
    } else {
      nextManagedHooks.push(managed);
    }

    report.appliedHooks.push(hook.hookId);
  }

  const removedSet = new Set(report.removedHooks);
  const finalManagedHooks = nextManagedHooks
    .filter((managed) => !removedSet.has(managed.hookId || managed.name))
    .sort((a, b) => (a.hookId || a.name).localeCompare(b.hookId || b.name));

  const state = appendHookHistory(
    {
      ...rawState,
      installerVersion: catalog.version,
      target: report.target,
      scope: request.scope,
      projectPath: request.projectPath,
      managedHooks: finalManagedHooks,
    },
    request.operation,
    `Applied ${report.appliedHooks.length}, removed ${report.removedHooks.length}, skipped ${report.skippedHooks.length}`,
  );

  await saveHookInstallState(installPath, state);
}

export async function executeHookOperation(repoRoot: string, request: HookInstallRequest): Promise<HookOperationReport> {
  const startedAt = new Date().toISOString();

  const requestedTargets = request.targets.length > 0 ? request.targets : (parseTargets(undefined) as HookTargetPlatform[]);
  const targets = toHookTargets(requestedTargets);
  if (targets.length === 0) {
    throw new Error("No hook-capable targets were specified or discovered");
  }

  const resolvedTargets = resolveTargetPaths(targets, request.scope, request.projectPath, request.agentDirName);
  const reports: HookTargetOperationReport[] = [];

  for (const resolved of resolvedTargets) {
    const report = defaultTargetReport(resolved.target as HookTargetPlatform, resolved.installPath, request.operation);
    reports.push(report);

    try {
      if (request.operation === "uninstall") {
        await uninstallTarget(request, resolved.installPath, report);
      } else {
        await installOrSyncTarget(repoRoot, request, resolved.installPath, report);
      }
    } catch (error) {
      pushError(report, "TARGET_OPERATION_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    request,
    targets: reports,
  };
}
