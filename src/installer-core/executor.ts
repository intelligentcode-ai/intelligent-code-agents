import path from "node:path";
import { BASELINE_DIRECTORIES, BASELINE_FILES, TARGET_HOME_DIR } from "./constants";
import { antigravityWorkflowPath, workflowNameFromSkillName } from "./antigravity";
import { applyClaudeIntegration } from "./claudeIntegration";
import { loadCatalogFromSources } from "./catalog";
import { findSkillById, resolveInstallSelections } from "./catalogMultiSource";
import { copyPath, ensureDir, pathExists, removePath, trySymlinkDirectory, writeText } from "./fs";
import { mergeMcpConfig } from "./mcp";
import { computePlannerDelta } from "./planner";
import { assertPathWithin, redactSensitive } from "./security";
import { appendHistory, createEmptyState, getStatePath, loadInstallState, reconcileLegacyManagedSkills, saveInstallState } from "./state";
import { computeDirectoryDigest } from "./contentDigest";
import {
  InstallRequest,
  InstallState,
  ManagedSkillState,
  ManagedWorkflowState,
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

function isAntigravityTarget(resolved: ResolvedTargetPath): boolean {
  return resolved.target === "antigravity";
}

function workflowDescriptionForSkill(skillName: string, description?: string): string {
  const normalized = (description || "").replace(/\s+/g, " ").trim();
  if (normalized.length > 0) {
    return normalized;
  }
  return `Use the ${skillName} skill`;
}

function buildAntigravityWorkflowMarkdown(skillName: string, description: string): string {
  return `---
description: ${description}
---

Use the ${skillName} skill for this task.

Follow the ${skillName} skill instructions and use its bundled resources (scripts, references, and assets) when relevant.

If ${skillName} is not a good fit, explain why and suggest the best matching skill.
`;
}

async function writeAntigravityWorkflow(
  resolved: ResolvedTargetPath,
  skillName: string,
  description: string,
): Promise<{ name: string; destinationPath: string }> {
  const workflowName = workflowNameFromSkillName(skillName);
  const destinationPath = path.join(resolved.workflowsPath, `${workflowName}.md`);
  assertPathWithin(resolved.installPath, destinationPath);
  await writeText(destinationPath, buildAntigravityWorkflowMarkdown(skillName, description));
  return { name: workflowName, destinationPath };
}

function buildBaselinePaths(resolved: ResolvedTargetPath): string[] {
  const dirs = BASELINE_DIRECTORIES.map((dirName) => path.join(resolved.installPath, dirName));
  const files = BASELINE_FILES.map((fileName) => path.join(resolved.installPath, fileName));
  const paths = [...dirs, ...files, resolved.skillsPath, path.join(resolved.installPath, "logs"), path.join(resolved.installPath, "ica.config.json")];
  if (isAntigravityTarget(resolved)) {
    paths.push(resolved.workflowsPath);
  }
  return paths;
}

async function installBaseline(repoRoot: string, resolved: ResolvedTargetPath, configFile?: string): Promise<void> {
  await ensureDir(resolved.installPath);
  await ensureDir(resolved.skillsPath);
  await ensureDir(path.join(resolved.installPath, "logs"));
  if (isAntigravityTarget(resolved)) {
    await ensureDir(resolved.workflowsPath);
  }

  for (const directory of BASELINE_DIRECTORIES) {
    const source = path.join(repoRoot, "src", directory);
    const destination = path.join(resolved.installPath, directory);
    await removePath(destination);
    await copyPath(source, destination);
  }

  const versionSource = path.join(repoRoot, "src", "VERSION");
  await copyPath(versionSource, path.join(resolved.installPath, "VERSION"));

  const defaultConfigSource = path.join(repoRoot, "ica.config.default.json");
  await copyPath(defaultConfigSource, path.join(resolved.installPath, "ica.config.default.json"));

  const defaultWorkflowSource = path.join(repoRoot, "ica.workflow.default.json");
  await copyPath(defaultWorkflowSource, path.join(resolved.installPath, "ica.workflow.default.json"));

  const targetConfig = path.join(resolved.installPath, "ica.config.json");
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

async function moveManagedPath(fromBasePath: string, toBasePath: string, fromPath: string, toPath: string): Promise<void> {
  assertPathWithin(fromBasePath, fromPath);
  assertPathWithin(toBasePath, toPath);
  if (!(await pathExists(fromPath))) {
    return;
  }
  if (await pathExists(toPath)) {
    throw new Error(`Antigravity migration conflict: '${toPath}' already exists. Resolve the conflict and rerun the operation.`);
  }
  await copyPath(fromPath, toPath);
  await removePath(fromPath);
}

interface PlannedPathMove {
  fromPath: string;
  toPath: string;
}

interface PlannedWorkflow {
  name: string;
  skillName: string;
  skillId: string;
  sourceId: string;
  destinationPath: string;
}

interface LegacyAntigravityMigrationPlan {
  legacyInstallPath: string;
  reconciledLegacyState: InstallState;
  migratedSkills: ManagedSkillState[];
  skillMoves: PlannedPathMove[];
  baselineMoves: PlannedPathMove[];
  migratedBaselinePaths: string[];
  workflows: PlannedWorkflow[];
  legacyWorkflowRemovals: string[];
}

function antigravityMigrationLabel(resolved: ResolvedTargetPath, legacyInstallPath: string): string {
  return resolved.scope === "user"
    ? `'${legacyInstallPath}' to '${resolved.installPath}'`
    : "'.agent' to '.agents'";
}

async function ensureMigrationDestinationsAvailable(resolved: ResolvedTargetPath, destinations: string[]): Promise<void> {
  for (const destinationPath of Array.from(new Set(destinations))) {
    assertPathWithin(resolved.installPath, destinationPath);
    if (await pathExists(destinationPath)) {
      throw new Error(`Antigravity migration conflict: '${destinationPath}' already exists. Resolve the conflict and rerun the operation.`);
    }
  }
}

function buildLegacyAntigravityMigrationPlan(
  resolved: ResolvedTargetPath,
  legacyInstallPath: string,
  reconciledLegacyState: InstallState,
): LegacyAntigravityMigrationPlan {
  const skillMoves: PlannedPathMove[] = [];
  const migratedSkills: ManagedSkillState[] = [];
  for (const managed of reconciledLegacyState.managedSkills) {
    const relativePath = path.relative(legacyInstallPath, managed.destinationPath);
    const destinationPath = path.join(resolved.installPath, relativePath);
    skillMoves.push({
      fromPath: managed.destinationPath,
      toPath: destinationPath,
    });
    migratedSkills.push({
      ...managed,
      destinationPath,
    });
  }

  const baselineMoves: PlannedPathMove[] = [];
  const migratedBaselinePaths: string[] = [];
  const legacySkillsRoot = path.join(legacyInstallPath, "skills");
  const legacyWorkflowsRoot = antigravityWorkflowPath(legacyInstallPath, resolved.scope);
  for (const baselinePath of reconciledLegacyState.managedBaselinePaths || []) {
    const relativePath = path.relative(legacyInstallPath, baselinePath);
    const destinationPath = path.join(resolved.installPath, relativePath);
    migratedBaselinePaths.push(destinationPath);
    if (baselinePath === legacySkillsRoot || baselinePath === legacyWorkflowsRoot) {
      continue;
    }
    baselineMoves.push({
      fromPath: baselinePath,
      toPath: destinationPath,
    });
  }

  const workflows: PlannedWorkflow[] = [];
  const legacyWorkflowRemovals = new Set<string>();
  for (const managed of migratedSkills) {
    const skillName = managed.skillName || managed.name;
    const workflowName = workflowNameFromSkillName(skillName);
    workflows.push({
      name: workflowName,
      skillName,
      skillId: managed.skillId,
      sourceId: managed.sourceId,
      destinationPath: path.join(resolved.workflowsPath, `${workflowName}.md`),
    });

    const trackedWorkflows = (reconciledLegacyState.managedWorkflows || []).filter((workflow) => workflow.skillId === managed.skillId);
    if (trackedWorkflows.length > 0) {
      for (const workflow of trackedWorkflows) {
        legacyWorkflowRemovals.add(workflow.destinationPath);
      }
    } else {
      legacyWorkflowRemovals.add(path.join(legacyWorkflowsRoot, `${workflowName}.md`));
    }
  }

  return {
    legacyInstallPath,
    reconciledLegacyState,
    migratedSkills,
    skillMoves,
    baselineMoves,
    migratedBaselinePaths,
    workflows,
    legacyWorkflowRemovals: Array.from(legacyWorkflowRemovals),
  };
}

async function migrateLegacyAntigravityInstall(
  resolved: ResolvedTargetPath,
  report: TargetOperationReport,
  catalog: SkillCatalog,
): Promise<void> {
  if (!isAntigravityTarget(resolved)) {
    return;
  }
  const legacyPaths = resolved.legacyInstallPaths || [];
  const legacyInstallPath = legacyPaths[0];
  if (!legacyInstallPath) {
    return;
  }

  const newStatePath = getStatePath(resolved.installPath);
  const hasNewState = await pathExists(newStatePath);
  const hasNewPath = await pathExists(resolved.installPath);
  const legacyPathPresence = await Promise.all(legacyPaths.map(async (legacyPath) => ({ legacyPath, exists: await pathExists(legacyPath) })));

  if (legacyPathPresence.some((entry) => entry.exists) && hasNewPath && hasNewState) {
    pushWarning(
      report,
      "LEGACY_ANTIGRAVITY_PATH_PRESENT",
      resolved.scope === "user"
        ? "Both '~/.gemini/antigravity' and legacy '~/.antigravity' paths exist. ICA uses '~/.gemini/antigravity' and leaves unknown legacy files untouched."
        : "Both '.agents' and legacy '.agent' paths exist. ICA uses '.agents' and leaves unknown legacy files untouched.",
    );
  }

  if (hasNewState) {
    return;
  }

  let sourceLegacyInstallPath: string | undefined;
  let legacyState: InstallState | null = null;
  for (const legacyPath of legacyPaths) {
    const state = await loadInstallState(legacyPath);
    if (state) {
      sourceLegacyInstallPath = legacyPath;
      legacyState = state;
      break;
    }
  }

  if (!legacyState) {
    return;
  }
  const effectiveLegacyInstallPath = sourceLegacyInstallPath || legacyInstallPath;
  const reconciledLegacyState = reconcileLegacyManagedSkills(legacyState, catalog);
  const plan = buildLegacyAntigravityMigrationPlan(resolved, effectiveLegacyInstallPath, reconciledLegacyState);
  await ensureMigrationDestinationsAvailable(
    resolved,
    [
      ...plan.skillMoves.map((move) => move.toPath),
      ...plan.baselineMoves.map((move) => move.toPath),
      ...plan.workflows.map((workflow) => workflow.destinationPath),
    ],
  );

  await ensureDir(resolved.installPath);
  await ensureDir(resolved.skillsPath);
  await ensureDir(resolved.workflowsPath);

  for (const move of plan.skillMoves) {
    await moveManagedPath(plan.legacyInstallPath, resolved.installPath, move.fromPath, move.toPath);
  }
  for (const move of plan.baselineMoves) {
    await moveManagedPath(plan.legacyInstallPath, resolved.installPath, move.fromPath, move.toPath);
  }

  const migratedWorkflows: ManagedWorkflowState[] = [];
  for (const workflowPlan of plan.workflows) {
    const catalogSkill = catalog.skills.find(
      (entry) => entry.skillId === workflowPlan.skillId || entry.skillName === workflowPlan.skillName || entry.name === workflowPlan.skillName,
    );
    const workflow = await writeAntigravityWorkflow(
      resolved,
      workflowPlan.skillName,
      workflowDescriptionForSkill(workflowPlan.skillName, catalogSkill?.description),
    );
    migratedWorkflows.push({
      name: workflow.name,
      skillName: workflowPlan.skillName,
      skillId: workflowPlan.skillId,
      sourceId: workflowPlan.sourceId,
      installMode: "copy",
      effectiveMode: "copy",
      destinationPath: workflow.destinationPath,
    });
  }
  for (const legacyWorkflowPath of plan.legacyWorkflowRemovals) {
    if (await pathExists(legacyWorkflowPath)) {
      await removeTrackedPath(plan.legacyInstallPath, legacyWorkflowPath);
    }
  }

  const migratedState = appendHistory(
    {
      ...plan.reconciledLegacyState,
      target: resolved.target,
      scope: resolved.scope,
      projectPath: resolved.projectPath,
      managedSkills: plan.migratedSkills.sort((a, b) => (a.skillId || a.name).localeCompare(b.skillId || b.name)),
      managedWorkflows: migratedWorkflows.sort((a, b) => a.name.localeCompare(b.name)),
      managedBaselinePaths: Array.from(new Set(plan.migratedBaselinePaths)),
    },
    "sync",
    `Migrated legacy Antigravity install from ${antigravityMigrationLabel(resolved, plan.legacyInstallPath)}.`,
  );
  await saveInstallState(resolved.installPath, migratedState);
  await removeTrackedPath(plan.legacyInstallPath, getStatePath(plan.legacyInstallPath));

  pushWarning(
    report,
    "ANTIGRAVITY_LEGACY_MIGRATED",
    `Migrated ICA-managed Antigravity assets from ${antigravityMigrationLabel(resolved, plan.legacyInstallPath)} and regenerated companion workflows.`,
  );
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
  const removedSkillIds = new Set<string>();
  const removedWorkflowNames = new Set<string>();

  for (const managed of state.managedSkills) {
    const managedId = managed.skillId || managed.name;
    if (!removeAll && !selected.has(managedId) && !selected.has(managed.name)) continue;
    await removeTrackedPath(resolved.installPath, managed.destinationPath);
    report.removedSkills.push(managedId);
    removedSkillIds.add(managedId);

    const trackedWorkflows = (state.managedWorkflows || []).filter((workflow) => workflow.skillId === managedId);
    for (const workflow of trackedWorkflows) {
      if (await pathExists(workflow.destinationPath)) {
        await removeTrackedPath(resolved.installPath, workflow.destinationPath);
      }
      report.removedWorkflows.push(workflow.name);
      removedWorkflowNames.add(workflow.name);
    }

    if (isAntigravityTarget(resolved) && trackedWorkflows.length === 0) {
      const fallbackWorkflowName = workflowNameFromSkillName(managed.skillName || managed.name);
      const fallbackWorkflowPath = path.join(resolved.workflowsPath, `${fallbackWorkflowName}.md`);
      if (await pathExists(fallbackWorkflowPath)) {
        await removeTrackedPath(resolved.installPath, fallbackWorkflowPath);
        report.removedWorkflows.push(fallbackWorkflowName);
        removedWorkflowNames.add(fallbackWorkflowName);
      }
    }
  }

  const removedSet = new Set(report.removedSkills);
  const remainingSkills = state.managedSkills.filter((managed) => !removedSet.has(managed.skillId || managed.name));
  const remainingWorkflows = (state.managedWorkflows || []).filter(
    (managed) => !removedSkillIds.has(managed.skillId) && !removedWorkflowNames.has(managed.name),
  );

  let updatedState: InstallState = {
    ...state,
    managedSkills: remainingSkills,
    managedWorkflows: remainingWorkflows,
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
    updatedState = appendHistory(
      updatedState,
      "uninstall",
      `Removed ${report.removedSkills.length} skill(s), ${report.removedWorkflows.length} workflow(s)`,
    );
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
  await installBaseline(repoRoot, resolved, request.configFile);

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

  const skillsDir = resolved.skillsPath;
  await ensureDir(skillsDir);
  if (isAntigravityTarget(resolved)) {
    await ensureDir(resolved.workflowsPath);
  }

  const nextManagedSkills = [...existingState.managedSkills].filter((item) => !delta.toRemove.includes(item.skillId || item.name));
  const nextManagedWorkflows = [...(existingState.managedWorkflows || [])].filter((item) => !delta.toRemove.includes(item.skillId));
  const appliedWorkflowNames = new Set<string>();
  const removedWorkflowNames = new Set<string>();

  for (const skillId of delta.toRemove) {
    const tracked = existingState.managedSkills.find((managed) => (managed.skillId || managed.name) === skillId);
    if (tracked) {
      await removeTrackedPath(resolved.installPath, tracked.destinationPath);
      report.removedSkills.push(skillId);
    }

    const trackedWorkflows = (existingState.managedWorkflows || []).filter((workflow) => workflow.skillId === skillId);
    for (const workflow of trackedWorkflows) {
      if (await pathExists(workflow.destinationPath)) {
        await removeTrackedPath(resolved.installPath, workflow.destinationPath);
      }
      if (!removedWorkflowNames.has(workflow.name)) {
        report.removedWorkflows.push(workflow.name);
        removedWorkflowNames.add(workflow.name);
      }
    }

    if (isAntigravityTarget(resolved) && trackedWorkflows.length === 0 && tracked) {
      const fallbackWorkflowName = workflowNameFromSkillName(tracked.skillName || tracked.name);
      const fallbackWorkflowPath = path.join(resolved.workflowsPath, `${fallbackWorkflowName}.md`);
      if (await pathExists(fallbackWorkflowPath)) {
        await removeTrackedPath(resolved.installPath, fallbackWorkflowPath);
        if (!removedWorkflowNames.has(fallbackWorkflowName)) {
          report.removedWorkflows.push(fallbackWorkflowName);
          removedWorkflowNames.add(fallbackWorkflowName);
        }
      }
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

    if (isAntigravityTarget(resolved)) {
      const workflow = await writeAntigravityWorkflow(
        resolved,
        skill.skillName,
        workflowDescriptionForSkill(skill.skillName, skill.description),
      );
      const nextWorkflow: ManagedWorkflowState = {
        name: workflow.name,
        skillName: skill.skillName,
        skillId: skill.skillId,
        sourceId: skill.sourceId,
        installMode: "copy",
        effectiveMode: "copy",
        destinationPath: workflow.destinationPath,
      };
      const existingIndex = nextManagedWorkflows.findIndex((item) => item.skillId === skill.skillId);
      if (existingIndex >= 0) {
        nextManagedWorkflows[existingIndex] = nextWorkflow;
      } else {
        nextManagedWorkflows.push(nextWorkflow);
      }
      if (!appliedWorkflowNames.has(workflow.name)) {
        report.appliedWorkflows.push(workflow.name);
        appliedWorkflowNames.add(workflow.name);
      }
    }
  }

  for (const already of delta.alreadyInstalled) {
    report.skippedSkills.push(already);
  }

  if (isAntigravityTarget(resolved)) {
    for (const selection of selections) {
      const existing = nextManagedSkills.find((item) => item.skillId === selection.skillId);
      const skill = findSkillById(catalog, selection.skillId);
      const skillName = existing?.skillName || existing?.name || skill?.skillName;
      if (!existing || !skillName) {
        continue;
      }
      const workflow = await writeAntigravityWorkflow(
        resolved,
        skillName,
        workflowDescriptionForSkill(skillName, skill?.description),
      );
      const nextWorkflow: ManagedWorkflowState = {
        name: workflow.name,
        skillName,
        skillId: existing.skillId,
        sourceId: existing.sourceId,
        installMode: "copy",
        effectiveMode: "copy",
        destinationPath: workflow.destinationPath,
      };
      const existingIndex = nextManagedWorkflows.findIndex((item) => item.skillId === existing.skillId);
      if (existingIndex >= 0) {
        nextManagedWorkflows[existingIndex] = nextWorkflow;
      } else {
        nextManagedWorkflows.push(nextWorkflow);
      }
      if (!appliedWorkflowNames.has(workflow.name)) {
        report.appliedWorkflows.push(workflow.name);
        appliedWorkflowNames.add(workflow.name);
      }
    }
  }

  const managedBaselinePaths = buildBaselinePaths(resolved);

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
      managedWorkflows: nextManagedWorkflows.sort((a, b) => a.name.localeCompare(b.name)),
      managedBaselinePaths: Array.from(new Set(managedBaselinePaths)),
    },
    request.operation,
    `Applied ${report.appliedSkills.length} skill(s), ${report.appliedWorkflows.length} workflow(s); removed ${report.removedSkills.length} skill(s), ${report.removedWorkflows.length} workflow(s); skipped ${report.skippedSkills.length} skill(s)`,
  );

  await saveInstallState(resolved.installPath, state);
}

function defaultTargetReport(target: TargetPlatform, installPath: string, operation: InstallRequest["operation"]): TargetOperationReport {
  return {
    target,
    installPath,
    operation,
    appliedSkills: [],
    appliedWorkflows: [],
    removedSkills: [],
    removedWorkflows: [],
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
      await migrateLegacyAntigravityInstall(resolved, report, catalog);
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
