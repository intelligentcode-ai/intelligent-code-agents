import fs from "node:fs";
import path from "node:path";
import { antigravityWorkflowPath, workflowNameFromSkillName } from "./antigravity";
import { loadInstallState, reconcileLegacyManagedSkills } from "./state";
import { InstallState, ResolvedTargetPath, SkillCatalog } from "./types";

export interface InstallationSkillView {
  name: string;
  skillId?: string;
  sourceId?: string;
  installMode: string;
  effectiveMode: string;
  orphaned?: boolean;
}

export interface InstallationWorkflowView {
  name: string;
  skillId?: string;
  sourceId?: string;
  installMode: string;
  effectiveMode: string;
}

export interface InstallationRow {
  target: ResolvedTargetPath["target"];
  installPath: string;
  scope: ResolvedTargetPath["scope"];
  projectPath?: string;
  installed: boolean;
  managedSkills: InstallationSkillView[];
  managedWorkflows: InstallationWorkflowView[];
  updatedAt?: string;
}

function candidateSkillRoots(target: ResolvedTargetPath): string[] {
  const roots = [target.skillsPath];
  if (target.target === "antigravity") {
    for (const legacyBase of target.legacyInstallPaths || []) {
      roots.push(path.join(legacyBase, "skills"));
    }
  }
  return Array.from(new Set(roots));
}

function candidateWorkflowRoots(target: ResolvedTargetPath): string[] {
  const roots = [target.workflowsPath];
  if (target.target === "antigravity") {
    for (const legacyBase of target.legacyInstallPaths || []) {
      roots.push(antigravityWorkflowPath(legacyBase, target.scope));
    }
  }
  return Array.from(new Set(roots));
}

function detectLegacyInstalledSkills(roots: string[], catalogSkillNames: Set<string>): InstallationSkillView[] {
  const byName = new Map<string, InstallationSkillView>();
  for (const skillsRoot of roots) {
    if (!fs.existsSync(skillsRoot)) {
      continue;
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!catalogSkillNames.has(entry.name) || byName.has(entry.name)) {
        continue;
      }

      const skillPath = path.join(skillsRoot, entry.name);
      let looksLikeSkill = false;
      try {
        const stat = fs.lstatSync(skillPath);
        if (stat.isSymbolicLink()) {
          const resolved = fs.realpathSync(skillPath);
          looksLikeSkill = fs.existsSync(path.join(resolved, "SKILL.md"));
        } else if (stat.isDirectory()) {
          looksLikeSkill = fs.existsSync(path.join(skillPath, "SKILL.md"));
        }
      } catch {
        looksLikeSkill = false;
      }

      if (looksLikeSkill) {
        byName.set(entry.name, {
          name: entry.name,
          installMode: "unknown",
          effectiveMode: "unknown",
        });
      }
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function detectMatchedInstalledWorkflows(roots: string[], allowedWorkflowNames: Set<string>): InstallationWorkflowView[] {
  const byName = new Map<string, InstallationWorkflowView>();
  for (const workflowsRoot of roots) {
    if (!fs.existsSync(workflowsRoot)) {
      continue;
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(workflowsRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      const workflowName = entry.name.replace(/\.md$/i, "");
      if (!allowedWorkflowNames.has(workflowName) || byName.has(workflowName)) {
        continue;
      }
      byName.set(workflowName, {
        name: workflowName,
        installMode: "unknown",
        effectiveMode: "unknown",
      });
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadPreferredInstallState(
  target: ResolvedTargetPath,
  catalog: SkillCatalog,
): Promise<{ state: InstallState | null; installPath: string }> {
  const candidates = Array.from(new Set([target.installPath, ...(target.legacyInstallPaths || [])]));
  for (const installPath of candidates) {
    const state = await loadInstallState(installPath);
    if (state) {
      return {
        state: reconcileLegacyManagedSkills(state, catalog),
        installPath,
      };
    }
  }

  return {
    state: null,
    installPath: target.installPath,
  };
}

export async function inspectInstallation(target: ResolvedTargetPath, catalog: SkillCatalog): Promise<InstallationRow> {
  const catalogSkillNames = new Set(catalog.skills.flatMap((skill) => [skill.name, skill.skillName]));
  const activeSourceIds = new Set(catalog.sources.map((source) => source.id));
  const { state, installPath } = await loadPreferredInstallState(target, catalog);

  const managedSkills: InstallationSkillView[] =
    state?.managedSkills.map((skill) => ({
      name: skill.name,
      skillId: skill.skillId,
      sourceId: skill.sourceId,
      installMode: skill.installMode,
      effectiveMode: skill.effectiveMode,
      orphaned: skill.orphaned || (skill.sourceId ? !activeSourceIds.has(skill.sourceId) : false),
    })) || [];
  const detectedSkills = detectLegacyInstalledSkills(candidateSkillRoots(target), catalogSkillNames);
  const skillsByName = new Map(managedSkills.map((skill) => [skill.name, skill]));
  for (const skill of detectedSkills) {
    if (!skillsByName.has(skill.name)) {
      skillsByName.set(skill.name, skill);
    }
  }
  const combinedSkills = Array.from(skillsByName.values()).sort((a, b) => a.name.localeCompare(b.name));

  const managedWorkflows: InstallationWorkflowView[] =
    state?.managedWorkflows.map((workflow) => ({
      name: workflow.name,
      skillId: workflow.skillId,
      sourceId: workflow.sourceId,
      installMode: workflow.installMode,
      effectiveMode: workflow.effectiveMode,
    })) || [];
  const allowedWorkflowNames = new Set(combinedSkills.map((skill) => workflowNameFromSkillName(skill.name)));
  const detectedWorkflows = detectMatchedInstalledWorkflows(candidateWorkflowRoots(target), allowedWorkflowNames);
  const workflowsByName = new Map(managedWorkflows.map((workflow) => [workflow.name, workflow]));
  for (const workflow of detectedWorkflows) {
    if (!workflowsByName.has(workflow.name)) {
      workflowsByName.set(workflow.name, workflow);
    }
  }
  const combinedWorkflows = Array.from(workflowsByName.values()).sort((a, b) => a.name.localeCompare(b.name));

  return {
    target: target.target,
    installPath,
    scope: target.scope,
    projectPath: target.projectPath,
    installed: Boolean(state) || combinedSkills.length > 0 || combinedWorkflows.length > 0,
    managedSkills: combinedSkills,
    managedWorkflows: combinedWorkflows,
    updatedAt: state?.updatedAt,
  };
}

export async function inspectInstallations(targets: ResolvedTargetPath[], catalog: SkillCatalog): Promise<InstallationRow[]> {
  return Promise.all(targets.map((target) => inspectInstallation(target, catalog)));
}
