export type TargetPlatform = "claude" | "codex" | "cursor" | "gemini" | "antigravity";

export type InstallScope = "user" | "project";
export type InstallMode = "symlink" | "copy";
export type OperationKind = "install" | "uninstall" | "sync";
export type SourceTransport = "https" | "ssh";
export type SkillIdentifier = string;
export type PublishMode = "direct-push" | "branch-only" | "branch-pr";
export type ValidationProfile = "personal" | "official";
export type GitProvider = "github" | "gitlab" | "bitbucket" | "unknown";

export interface SkillResource {
  type: "references" | "scripts" | "assets" | "other";
  path: string;
}

export interface SkillSource {
  id: string;
  name: string;
  repoUrl: string;
  transport: SourceTransport;
  official: boolean;
  enabled: boolean;
  skillsRoot: string;
  publishDefaultMode: PublishMode;
  defaultBaseBranch?: string;
  providerHint: GitProvider;
  officialContributionEnabled: boolean;
  credentialRef?: string;
  removable: boolean;
  lastSyncAt?: string;
  lastError?: string;
  localPath?: string;
  localSkillsPath?: string;
  revision?: string;
}

export interface CatalogSkill {
  skillId: SkillIdentifier;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  skillName: string;
  // Backward-compatible field used by existing CLI/UI code.
  name: string;
  description: string;
  category: string;
  scope?: string;
  tags?: string[];
  dependencies: string[];
  compatibleTargets: TargetPlatform[];
  resources: SkillResource[];
  sourcePath: string;
  version?: string;
  updatedAt?: string;
}

export interface SkillCatalog {
  generatedAt: string;
  source: "local-repo" | "github-release" | "multi-source";
  version: string;
  sources: SkillSource[];
  skills: CatalogSkill[];
}

export type SkillCatalogEntry = CatalogSkill;

export interface InstallSelection {
  sourceId: string;
  skillName: string;
  skillId: SkillIdentifier;
}

export interface SkillBundleInput {
  localPath: string;
  skillName?: string;
}

export interface PublishRequest {
  sourceId: string;
  bundle: SkillBundleInput;
  commitMessage?: string;
  overrideMode?: PublishMode;
  overrideBaseBranch?: string;
}

export interface PublishResult {
  mode: PublishMode;
  branch: string;
  commitSha: string;
  pushedRemote: string;
  prUrl?: string;
  compareUrl?: string;
}

export interface ValidationResult {
  profile: ValidationProfile;
  errors: string[];
  warnings: string[];
  detectedFiles: string[];
}

export interface InstallRequest {
  operation: OperationKind;
  targets: TargetPlatform[];
  scope: InstallScope;
  projectPath?: string;
  agentDirName?: string;
  mode: InstallMode;
  // Legacy selector, still supported for compatibility.
  skills: string[];
  // Preferred source-pinned selector.
  skillSelections?: InstallSelection[];
  removeUnselected?: boolean;
  installClaudeIntegration?: boolean;
  force?: boolean;
  configFile?: string;
  mcpConfigFile?: string;
  envFile?: string;
}

export interface ManagedSkillState {
  name: string;
  skillName?: string;
  skillId: SkillIdentifier;
  sourceId: string;
  sourceUrl: string;
  sourceRevision?: string;
  orphaned?: boolean;
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
