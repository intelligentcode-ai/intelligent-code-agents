import path from "node:path";
import { BASELINE_DIRECTORIES, BASELINE_FILES, TARGET_HOME_DIR } from "./constants";
import { applyClaudeIntegration } from "./claudeIntegration";
import { loadCatalogFromSources } from "./catalog";
import { findSkillById, resolveInstallSelections } from "./catalogMultiSource";
import { copyPath, ensureDir, pathExists, removePath, trySymlinkDirectory } from "./fs";
import { mergeMcpConfig } from "./mcp";
import { computePlannerDelta } from "./planner";
import { assertPathWithin, redactSensitive } from "./security";
import { appendHistory, createEmptyState, getStatePath, loadInstallState, reconcileLegacyManagedSkills, saveInstallState } from "./state";
import { computeDirectoryDigest } from "./contentDigest";
import {
  InstallRequest,
  InstallState,
  ManagedSkillState,
  OperationReport,
  SkillCatalog,
  ResolvedTargetPath,
  TargetOperationReport,
  TargetPlatform,
} from "./types";
import { parseTargets, resolveTargetPaths } from "./targets";

export interface InstallHookContext {
  repoRoot: string;
  request: InstallRequest;
  resolvedTarget: ResolvedTargetPath;
}

export interface PostInstallHookContext extends InstallHookContext {
  report: TargetOperationReport;
}

export interface ExecuteOperationHooks {
  onBeforeInstall?(context: InstallHookContext): Promise<void> | void;
  onAfterInstall?(context: PostInstallHookContext): Promise<void> | void;
}

export interface ExecuteOperationOptions {
  hooks?: ExecuteOperationHooks;
}

function buildBaselinePaths(installPath: string): string[] {
  const dirs = BASELINE_DIRECTORIES.map((dirName) => path.join(installPath, dirName));
  const files = BASELINE_FILES.map((fileName) => path.join(installPath, fileName));
  return [...dirs, ...files, path.join(installPath, "skills"), path.join(installPath, "logs"), path.join(installPath, "ica.config.json")];
}

async function installBaseline(repoRoot: string, installPath: string, configFile?: string): Promise<void> {
  await ensureDir(installPath);
  await ensureDir(path.join(installPath, "skills"));
  await ensureDir(path.join(installPath, "logs"));

  for (const directory of BASELINE_DIRECTORIES) {
    const source = path.join(repoRoot, "src", directory);
    const destination = path.join(installPath, directory);
    await removePath(destination);
    await copyPath(source, destination);
  }

  const versionSource = path.join(repoRoot, "src", "VERSION");
  await copyPath(versionSource, path.join(installPath, "VERSION"));

  const defaultConfigSource = path.join(repoRoot, "ica.config.default.json");
  await copyPath(defaultConfigSource, path.join(installPath, "ica.config.default.json"));

  const defaultWorkflowSource = path.join(repoRoot, "ica.workflow.default.json");
  await copyPath(defaultWorkflowSource, path.join(installPath, "ica.workflow.default.json"));

  const targetConfig = path.join(installPath, "ica.config.json");
  if (configFile) {
    await copyPath(path.resolve(configFile), targetConfig);
  } else if (!(await pathExists(targetConfig))) {
    await copyPath(defaultConfigSource, targetConfig);
  }
}

function pushWarning(report: TargetOperationReport, code: string, message: string): void {
  report.warnings.push({ code, message: redactSensitive(message) });
}

function pushError(report: TargetOperationReport, code: string, message: string): void {
  report.errors.push({ code, message: redactSensitive(message) });
}

function verifySkillSourceIntegrity(skill: SkillCatalog["skills"][number], report: TargetOperationReport): string {
  const actual = computeDirectoryDigest(skill.sourcePath);
  const expected = skill.contentDigest || actual.digest;

  if (!skill.contentDigest) {
    pushWarning(
      report,
      "MISSING_SKILL_DIGEST",
      `Skill '${skill.skillId}' did not provide a catalog content digest; verified using runtime source digest only.`,
    );
  }

  if (actual.digest !== expected) {
    throw new Error(
      `Integrity verification failed for '${skill.skillId}'. Expected ${expected}, received ${actual.digest}.`,
    );
  }

  return expected;
}

function verifyInstalledSkillIntegrity(destinationPath: string, expectedDigest: string): void {
  const installed = computeDirectoryDigest(destinationPath);
  if (installed.digest !== expectedDigest) {
    throw new Error(`Installed skill digest mismatch at '${destinationPath}'. Expected ${expectedDigest}, received ${installed.digest}.`);
  }
}

async function removeTrackedPath(installPath: string, candidatePath: string): Promise<void> {
  assertPathWithin(installPath, candidatePath);
  await removePath(candidatePath);
}

async function uninstallTarget(
  request: InstallRequest,
  resolved: ResolvedTargetPath,
  report: TargetOperationReport,
  catalog: SkillCatalog,
): Promise<void> {
  if (request.force) {
    await removePath(resolved.installPath);
    return;
  }

  const existing = await loadInstallState(resolved.installPath);
  const state = existing ? reconcileLegacyManagedSkills(existing, catalog) : null;
  if (!state) {
    return;
  }

  const selections = resolveInstallSelections(catalog, request.skillSelections, request.skills);
  const selected = new Set(selections.map((selection) => selection.skillId));
  const removeAll = selections.length === 0;

  for (const managed of state.managedSkills) {
    const managedId = managed.skillId || managed.name;
    if (!removeAll && !selected.has(managedId) && !selected.has(managed.name)) continue;
    await removeTrackedPath(resolved.installPath, managed.destinationPath);
    report.removedSkills.push(managedId);
  }

  const removedSet = new Set(report.removedSkills);
  const remainingSkills = state.managedSkills.filter((managed) => !removedSet.has(managed.skillId || managed.name));

  let updatedState: InstallState = {
    ...state,
    managedSkills: remainingSkills,
  };

  if (removeAll) {
    for (const baselinePath of state.managedBaselinePaths) {
      if (!(await pathExists(baselinePath))) continue;
      await removeTrackedPath(resolved.installPath, baselinePath);
    }
    updatedState = {
      ...updatedState,
      managedBaselinePaths: [],
    };

    const statePath = getStatePath(resolved.installPath);
    if (await pathExists(statePath)) {
      await removeTrackedPath(resolved.installPath, statePath);
    }
  } else {
    updatedState = appendHistory(updatedState, "uninstall", `Removed ${report.removedSkills.length} skill(s)`);
    await saveInstallState(resolved.installPath, updatedState);
  }
}

async function installOrSyncTarget(
  repoRoot: string,
  request: InstallRequest,
  resolved: ResolvedTargetPath,
  report: TargetOperationReport,
  catalog: SkillCatalog,
): Promise<void> {
  await installBaseline(repoRoot, resolved.installPath, request.configFile);

  const rawState = (await loadInstallState(resolved.installPath)) ||
    createEmptyState({
      installerVersion: catalog.version,
      target: resolved.target,
      scope: resolved.scope,
      projectPath: resolved.projectPath,
    });
  const existingState = reconcileLegacyManagedSkills(rawState, catalog);
  const selections = resolveInstallSelections(catalog, request.skillSelections, request.skills);
  const selectedSkillIds = selections.map((selection) => selection.skillId);

  const removeUnselected = request.operation === "sync" || Boolean(request.removeUnselected);
  const delta = computePlannerDelta(selectedSkillIds, existingState, removeUnselected);

  const skillsDir = path.join(resolved.installPath, "skills");
  await ensureDir(skillsDir);

  const nextManagedSkills = [...existingState.managedSkills].filter((item) => !delta.toRemove.includes(item.skillId || item.name));

  for (const skillId of delta.toRemove) {
    const tracked = existingState.managedSkills.find((managed) => (managed.skillId || managed.name) === skillId);
    if (tracked) {
      await removeTrackedPath(resolved.installPath, tracked.destinationPath);
      report.removedSkills.push(skillId);
    }
  }

  const selectedNames = new Set<string>();
  for (const skillId of delta.toInstall) {
    const skill = findSkillById(catalog, skillId);
    if (!skill) {
      report.skippedSkills.push(skillId);
      pushWarning(report, "UNKNOWN_SKILL", `Unknown skill '${skillId}' was skipped.`);
      continue;
    }

    if (selectedNames.has(skill.skillName)) {
      report.skippedSkills.push(skill.skillId);
      pushWarning(
        report,
        "DUPLICATE_SKILL_NAME",
        `Skipped '${skill.skillId}' because skill name '${skill.skillName}' is already selected from another source.`,
      );
      continue;
    }
    selectedNames.add(skill.skillName);

    const destination = path.join(skillsDir, skill.name);
    await removePath(destination);
    const expectedDigest = verifySkillSourceIntegrity(skill, report);

    let effectiveMode = request.mode;
    if (request.mode === "symlink") {
      try {
        await trySymlinkDirectory(skill.sourcePath, destination);
      } catch (error) {
        effectiveMode = "copy";
        await copyPath(skill.sourcePath, destination);
        pushWarning(report, "SYMLINK_FALLBACK", `Symlink failed for '${skill.name}', fell back to copy mode.`);
      }
    } else {
      await copyPath(skill.sourcePath, destination);
    }

    if (effectiveMode === "copy") {
      verifyInstalledSkillIntegrity(destination, expectedDigest);
    }

    const managed: ManagedSkillState = {
      name: skill.name,
      skillName: skill.skillName,
      skillId: skill.skillId,
      sourceId: skill.sourceId,
      sourceUrl: skill.sourceUrl,
      sourceRevision: catalog.sources.find((source) => source.id === skill.sourceId)?.revision,
      sourceContentDigest: expectedDigest,
      orphaned: false,
      installMode: request.mode,
      effectiveMode,
      destinationPath: destination,
      sourcePath: skill.sourcePath,
    };

    nextManagedSkills.push(managed);
    report.appliedSkills.push(skill.skillId);
  }

  for (const already of delta.alreadyInstalled) {
    report.skippedSkills.push(already);
  }

  const managedBaselinePaths = buildBaselinePaths(resolved.installPath);

  if (resolved.target === "claude" && request.installClaudeIntegration !== false) {
    await applyClaudeIntegration({
      repoRoot,
      installPath: resolved.installPath,
      scope: resolved.scope,
      projectPath: resolved.projectPath,
      agentDirName: request.agentDirName || TARGET_HOME_DIR.claude,
    });

    managedBaselinePaths.push(
      path.join(resolved.installPath, "modes"),
      path.join(resolved.installPath, "hooks"),
      path.join(resolved.installPath, "settings.json"),
    );
  }

  if (resolved.target === "claude" && request.installClaudeIntegration !== false && request.mcpConfigFile) {
    await mergeMcpConfig(request.mcpConfigFile, request.envFile);
  }

  const state = appendHistory(
    {
      ...existingState,
      installerVersion: catalog.version,
      target: resolved.target,
      scope: resolved.scope,
      projectPath: resolved.projectPath,
      managedSkills: nextManagedSkills.sort((a, b) => (a.skillId || a.name).localeCompare(b.skillId || b.name)),
      managedBaselinePaths: Array.from(new Set(managedBaselinePaths)),
    },
    request.operation,
    `Applied ${report.appliedSkills.length}, removed ${report.removedSkills.length}, skipped ${report.skippedSkills.length}`,
  );

  await saveInstallState(resolved.installPath, state);
}

function defaultTargetReport(target: TargetPlatform, installPath: string, operation: InstallRequest["operation"]): TargetOperationReport {
  return {
    target,
    installPath,
    operation,
    appliedSkills: [],
    removedSkills: [],
    skippedSkills: [],
    warnings: [],
    errors: [],
  };
}

export async function executeOperation(repoRoot: string, request: InstallRequest, options: ExecuteOperationOptions = {}): Promise<OperationReport> {
  const startedAt = new Date().toISOString();
  const catalog = await loadCatalogFromSources(repoRoot, true);
  const targets = request.targets.length > 0 ? request.targets : parseTargets(undefined);
  if (targets.length === 0) {
    throw new Error("No targets were specified or discovered");
  }

  const resolvedTargets = resolveTargetPaths(targets, request.scope, request.projectPath, request.agentDirName);

  const reports: TargetOperationReport[] = [];

  for (const resolved of resolvedTargets) {
    const report = defaultTargetReport(resolved.target, resolved.installPath, request.operation);
    reports.push(report);

    try {
      if (request.operation === "uninstall") {
        await uninstallTarget(request, resolved, report, catalog);
      } else {
        await options.hooks?.onBeforeInstall?.({
          repoRoot,
          request,
          resolvedTarget: resolved,
        });
        await installOrSyncTarget(repoRoot, request, resolved, report, catalog);
        await options.hooks?.onAfterInstall?.({
          repoRoot,
          request,
          resolvedTarget: resolved,
          report,
        });
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
