export type TargetPlatform = "claude" | "codex" | "cursor" | "gemini" | "antigravity";

export type InstallScope = "user" | "project";
export type InstallMode = "symlink" | "copy";
export type OperationKind = "install" | "uninstall" | "sync";

export interface SkillResource {
  type: "references" | "scripts" | "assets";
  path: string;
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  category: string;
  dependencies: string[];
  compatibleTargets: TargetPlatform[];
  resources: SkillResource[];
  sourcePath: string;
}

export interface SkillCatalog {
  generatedAt: string;
  source: "local-repo" | "github-release";
  version: string;
  skills: SkillCatalogEntry[];
}

export interface InstallRequest {
  operation: OperationKind;
  targets: TargetPlatform[];
  scope: InstallScope;
  projectPath?: string;
  agentDirName?: string;
  mode: InstallMode;
  skills: string[];
  removeUnselected?: boolean;
  installClaudeIntegration?: boolean;
  force?: boolean;
  configFile?: string;
  mcpConfigFile?: string;
  envFile?: string;
}

export interface ManagedSkillState {
  name: string;
  installMode: InstallMode;
  effectiveMode: InstallMode;
  destinationPath: string;
  sourcePath: string;
}

export interface InstallState {
  schemaVersion: string;
  installerVersion: string;
  target: TargetPlatform;
  scope: InstallScope;
  projectPath?: string;
  installedAt: string;
  updatedAt: string;
  managedSkills: ManagedSkillState[];
  managedBaselinePaths: string[];
  history: OperationLogEntry[];
}

export interface OperationLogEntry {
  timestamp: string;
  operation: OperationKind;
  summary: string;
}

export interface OperationWarning {
  code: string;
  message: string;
}

export interface OperationError {
  code: string;
  message: string;
}

export interface TargetOperationReport {
  target: TargetPlatform;
  installPath: string;
  operation: OperationKind;
  appliedSkills: string[];
  removedSkills: string[];
  skippedSkills: string[];
  warnings: OperationWarning[];
  errors: OperationError[];
}

export interface OperationReport {
  startedAt: string;
  completedAt: string;
  request: InstallRequest;
  targets: TargetOperationReport[];
}

export interface PlannerDelta {
  toInstall: string[];
  toRemove: string[];
  alreadyInstalled: string[];
}

export interface ResolvedTargetPath {
  target: TargetPlatform;
  installPath: string;
  scope: InstallScope;
  projectPath?: string;
}
