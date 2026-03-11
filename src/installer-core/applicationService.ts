import fs from "node:fs";
import path from "node:path";
import { executeOperation, ExecuteOperationHooks } from "./executor";
import { loadCatalogFromSources } from "./catalog";
import { loadHookCatalogFromSources } from "./hookCatalog";
import { createCredentialProvider } from "./credentials";
import { checkSourceAuth as checkSourceAuthInternal, SourceAuthCheckResult } from "./sourceAuth";
import { loadSources as loadSourcesRecord, removeSource as removeSourceRecord, setSourceSyncStatus, updateSource as updateSourceRecord } from "./sources";
import {
  loadHookSources as loadHookSourcesRecord,
  removeHookSource as removeHookSourceRecord,
  updateHookSource as updateHookSourceRecord,
} from "./hookSources";
import { loadHookInstallState } from "./hookState";
import { loadInstallState } from "./state";
import { resolveTargetPaths } from "./targets";
import { checkForAppUpdate } from "./updateCheck";
import { redactSensitive } from "./security";
import { refreshSourcesAndHooks, RefreshEntryResult } from "./sourceRefresh";
import { registerRepository, RepositoryRegistrationResult } from "./repositories";
import { syncSource } from "./sourceSync";
import { syncHookSource } from "./hookSync";
import {
  contributeOfficialSkillBundle as contributeOfficialSkillBundleInternal,
  publishSkillBundle as publishSkillBundleInternal,
  validateSkillBundle as validateSkillBundleInternal,
} from "./skillPublish";
import { pickDirectoryNative } from "../installer-helper/server";
import {
  InstallRequest,
  InstallScope,
  PublishMode,
  TargetPlatform,
  TargetOperationReport,
  OperationReport,
  SourceTransport,
  ValidationProfile,
  ValidationResult,
  PublishResult,
  SkillSource,
} from "./types";

export interface InstallationSkillView {
  name: string;
  skillId?: string;
  sourceId?: string;
  installMode: string;
  effectiveMode: string;
  orphaned?: boolean;
}

export interface InstallationHookView {
  name: string;
  hookId?: string;
  sourceId?: string;
  installMode: string;
  effectiveMode: string;
  orphaned?: boolean;
}

export interface InstallationRow {
  target: TargetPlatform;
  installPath: string;
  scope: InstallScope;
  projectPath?: string;
  installed: boolean;
  managedSkills: InstallationSkillView[];
  updatedAt?: string;
}

export interface HookInstallationRow {
  target: TargetPlatform;
  installPath: string;
  scope: InstallScope;
  projectPath?: string;
  installed: boolean;
  managedHooks: InstallationHookView[];
  updatedAt?: string;
}

export interface PublicSourceView {
  id: string;
  name: string;
  repoUrl: string;
  transport: SourceTransport;
  official: boolean;
  enabled: boolean;
  skillsRoot?: string;
  hooksRoot?: string;
  publishDefaultMode?: PublishMode;
  defaultBaseBranch?: string;
  providerHint?: "github" | "gitlab" | "bitbucket" | "unknown";
  officialContributionEnabled?: boolean;
  credentialRef?: string;
  removable: boolean;
  lastSyncAt?: string;
  lastError?: string;
  revision?: string;
}

export interface InstallationInspectionQuery {
  scope: InstallScope;
  projectPath?: string;
  targets: TargetPlatform[];
  agentDirName?: string;
}

export interface RegisterSourceInput {
  id?: string;
  name?: string;
  repoUrl: string;
  transport?: SourceTransport;
  skillsRoot?: string;
  hooksRoot?: string;
  publishDefaultMode?: PublishMode;
  defaultBaseBranch?: string;
  providerHint?: "github" | "gitlab" | "bitbucket" | "unknown";
  officialContributionEnabled?: boolean;
  enabled?: boolean;
  removable?: boolean;
  official?: boolean;
  token?: string;
}

export interface UpdateSourceInput {
  sourceId: string;
  name?: string;
  repoUrl?: string;
  transport?: SourceTransport;
  skillsRoot?: string;
  hooksRoot?: string;
  publishDefaultMode?: PublishMode;
  defaultBaseBranch?: string;
  providerHint?: "github" | "gitlab" | "bitbucket" | "unknown";
  officialContributionEnabled?: boolean;
  enabled?: boolean;
  credentialRef?: string;
  removable?: boolean;
  official?: boolean;
  token?: string;
}

export interface SourceAuthCheckInput {
  sourceId: string;
  token?: string;
}

export interface SourceRefreshInput {
  sourceId?: string;
  onlyEnabled?: boolean;
}

export interface ValidateSkillBundleInput {
  localPath: string;
  skillName?: string;
  profile: ValidationProfile;
}

export interface PublishSkillBundleInput {
  sourceId: string;
  localPath: string;
  skillName?: string;
  commitMessage?: string;
  overrideMode?: PublishMode;
  overrideBaseBranch?: string;
}

export interface ContributeOfficialSkillBundleInput {
  sourceId?: string;
  localPath: string;
  skillName?: string;
  commitMessage?: string;
}

export interface RegisterSourceResult {
  source: SkillSource;
  sync: RepositoryRegistrationResult["sync"];
  auth: SourceAuthCheckResult;
}

export interface InstallerApplicationService {
  listInstallations(input: InstallationInspectionQuery): Promise<{ installations: InstallationRow[] }>;
  listHookInstallations(input: InstallationInspectionQuery): Promise<{ installations: HookInstallationRow[] }>;
  listSources(): Promise<{ sources: PublicSourceView[] }>;
  executeInstallOperation(request: InstallRequest): Promise<OperationReport>;
  executeUninstallOperation(request: InstallRequest): Promise<OperationReport>;
  executeSyncOperation(request: InstallRequest): Promise<OperationReport>;
  checkForUpdate(installerVersion: string): Promise<Awaited<ReturnType<typeof checkForAppUpdate>>>;
  pickProjectDirectory(initialPath?: string): Promise<{ path: string }>;
  registerSource(input: RegisterSourceInput): Promise<RegisterSourceResult>;
  updateSource(input: UpdateSourceInput): Promise<{ source: SkillSource }>;
  removeSource(sourceId: string): Promise<{ source: SkillSource | { id: string } }>;
  checkSourceAuth(input: SourceAuthCheckInput): Promise<SourceAuthCheckResult>;
  refreshSources(input?: SourceRefreshInput): Promise<{ refreshed: RefreshEntryResult[]; matched: boolean }>;
  validateSkillBundle(input: ValidateSkillBundleInput): Promise<ValidationResult>;
  publishSkillBundle(input: PublishSkillBundleInput): Promise<PublishResult>;
  contributeOfficialSkillBundle(input: ContributeOfficialSkillBundleInput): Promise<PublishResult>;
}

interface InstallerApplicationServiceDependencies {
  executeOperation: typeof executeOperation;
  loadCatalogFromSources: typeof loadCatalogFromSources;
  loadHookCatalogFromSources: typeof loadHookCatalogFromSources;
  loadSources: typeof loadSourcesRecord;
  loadHookSources: typeof loadHookSourcesRecord;
  syncSource: typeof syncSource;
  syncHookSource: typeof syncHookSource;
  checkForAppUpdate: typeof checkForAppUpdate;
  pickProjectDirectory: (initialPath: string) => Promise<string>;
}

export interface CreateInstallerApplicationServiceOptions {
  repoRoot: string;
  installHooks?: ExecuteOperationHooks;
  dependencies?: Partial<InstallerApplicationServiceDependencies>;
}

function detectLegacyInstalledSkills(installPath: string, catalogSkillNames: Set<string>): InstallationSkillView[] {
  const skillsRoot = path.join(installPath, "skills");
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const detected: InstallationSkillView[] = [];
  for (const entry of entries) {
    if (!catalogSkillNames.has(entry.name)) {
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
      detected.push({
        name: entry.name,
        installMode: "unknown",
        effectiveMode: "unknown",
      });
    }
  }

  return detected.sort((a, b) => a.name.localeCompare(b.name));
}

function detectLegacyInstalledHooks(installPath: string, catalogHookNames: Set<string>): InstallationHookView[] {
  const hooksRoot = path.join(installPath, "hooks");
  if (!fs.existsSync(hooksRoot)) {
    return [];
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(hooksRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const detected: InstallationHookView[] = [];
  for (const entry of entries) {
    if (!catalogHookNames.has(entry.name)) {
      continue;
    }

    const hookPath = path.join(hooksRoot, entry.name);
    let looksLikeHook = false;
    try {
      const stat = fs.lstatSync(hookPath);
      if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(hookPath);
        looksLikeHook = fs.existsSync(path.join(resolved, "HOOK.md")) || fs.readdirSync(resolved, { withFileTypes: true }).length > 0;
      } else if (stat.isDirectory()) {
        looksLikeHook = fs.existsSync(path.join(hookPath, "HOOK.md")) || fs.readdirSync(hookPath, { withFileTypes: true }).length > 0;
      }
    } catch {
      looksLikeHook = false;
    }

    if (looksLikeHook) {
      detected.push({
        name: entry.name,
        installMode: "unknown",
        effectiveMode: "unknown",
      });
    }
  }

  return detected.sort((a, b) => a.name.localeCompare(b.name));
}

function toPublicSource(source: PublicSourceView): PublicSourceView {
  return {
    ...source,
    lastError: source.lastError ? redactSensitive(source.lastError) : undefined,
  };
}

function normalizeTargetRows(targets: TargetPlatform[]): TargetPlatform[] {
  return Array.from(new Set(targets));
}

function normalizePathForMatch(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function looksLikeOfficialSkillPath(localPath: string): boolean {
  return normalizePathForMatch(localPath).includes("/official-skills/");
}

export function createInstallerApplicationService(
  options: CreateInstallerApplicationServiceOptions,
): InstallerApplicationService {
  const deps: InstallerApplicationServiceDependencies = {
    executeOperation,
    loadCatalogFromSources,
    loadHookCatalogFromSources,
    loadSources: loadSourcesRecord,
    loadHookSources: loadHookSourcesRecord,
    syncSource,
    syncHookSource,
    checkForAppUpdate,
    pickProjectDirectory: pickDirectoryNative,
    ...options.dependencies,
  };

  return {
    async listInstallations(input) {
      const resolved = resolveTargetPaths(normalizeTargetRows(input.targets), input.scope, input.projectPath, input.agentDirName);
      const catalog = await deps.loadCatalogFromSources(options.repoRoot, false);
      const catalogSkillNames = new Set(catalog.skills.map((skill) => skill.skillName));
      const activeSourceIds = new Set(catalog.sources.map((source) => source.id));

      const installations = await Promise.all(
        resolved.map(async (entry) => {
          const state = await loadInstallState(entry.installPath);
          const managedSkills: InstallationSkillView[] =
            state?.managedSkills.map((skill) => ({
              name: skill.name,
              skillId: skill.skillId,
              sourceId: skill.sourceId,
              installMode: skill.installMode,
              effectiveMode: skill.effectiveMode,
              orphaned: skill.orphaned || (skill.sourceId ? !activeSourceIds.has(skill.sourceId) : false),
            })) || [];
          const skillsByName = new Map(managedSkills.map((skill) => [skill.name, skill]));
          for (const skill of detectLegacyInstalledSkills(entry.installPath, catalogSkillNames)) {
            if (!skillsByName.has(skill.name)) {
              skillsByName.set(skill.name, skill);
            }
          }

          return {
            target: entry.target,
            installPath: entry.installPath,
            scope: entry.scope,
            projectPath: entry.projectPath,
            installed: Boolean(state) || skillsByName.size > 0,
            managedSkills: Array.from(skillsByName.values()).sort((a, b) => a.name.localeCompare(b.name)),
            updatedAt: state?.updatedAt,
          };
        }),
      );

      return { installations };
    },

    async listHookInstallations(input) {
      const resolved = resolveTargetPaths(normalizeTargetRows(input.targets), input.scope, input.projectPath, input.agentDirName);
      const catalog = await deps.loadHookCatalogFromSources(options.repoRoot, false);
      const catalogHookNames = new Set(catalog.hooks.map((hook) => hook.hookName));
      const activeSourceIds = new Set(catalog.sources.map((source) => source.id));

      const installations = await Promise.all(
        resolved.map(async (entry) => {
          const state = await loadHookInstallState(entry.installPath);
          const managedHooks: InstallationHookView[] =
            state?.managedHooks.map((hook) => ({
              name: hook.name,
              hookId: hook.hookId,
              sourceId: hook.sourceId,
              installMode: hook.installMode,
              effectiveMode: hook.effectiveMode,
              orphaned: hook.orphaned || (hook.sourceId ? !activeSourceIds.has(hook.sourceId) : false),
            })) || [];
          const hooksByName = new Map(managedHooks.map((hook) => [hook.name, hook]));
          for (const hook of detectLegacyInstalledHooks(entry.installPath, catalogHookNames)) {
            if (!hooksByName.has(hook.name)) {
              hooksByName.set(hook.name, hook);
            }
          }

          return {
            target: entry.target,
            installPath: entry.installPath,
            scope: entry.scope,
            projectPath: entry.projectPath,
            installed: Boolean(state) || hooksByName.size > 0,
            managedHooks: Array.from(hooksByName.values()).sort((a, b) => a.name.localeCompare(b.name)),
            updatedAt: state?.updatedAt,
          };
        }),
      );

      return { installations };
    },

    async listSources() {
      const skillSources = await deps.loadSources();
      const hookSources = await deps.loadHookSources();
      const byId = new Map<string, PublicSourceView>();

      for (const source of skillSources) {
        byId.set(source.id, {
          ...(byId.get(source.id) || {
            id: source.id,
            name: source.name,
            repoUrl: source.repoUrl,
            transport: source.transport,
            official: source.official,
            enabled: source.enabled,
            removable: source.removable,
          }),
          id: source.id,
          name: source.name,
          repoUrl: source.repoUrl,
          transport: source.transport,
          official: source.official,
          enabled: source.enabled,
          skillsRoot: source.skillsRoot,
          publishDefaultMode: source.publishDefaultMode,
          defaultBaseBranch: source.defaultBaseBranch,
          providerHint: source.providerHint,
          officialContributionEnabled: source.officialContributionEnabled,
          credentialRef: source.credentialRef,
          removable: source.removable,
          lastSyncAt: source.lastSyncAt || byId.get(source.id)?.lastSyncAt,
          lastError: source.lastError || byId.get(source.id)?.lastError,
          revision: source.revision || byId.get(source.id)?.revision,
        });
      }

      for (const source of hookSources) {
        byId.set(source.id, {
          ...(byId.get(source.id) || {
            id: source.id,
            name: source.name,
            repoUrl: source.repoUrl,
            transport: source.transport,
            official: source.official,
            enabled: source.enabled,
            removable: source.removable,
          }),
          id: source.id,
          name: source.name,
          repoUrl: source.repoUrl,
          transport: source.transport,
          official: source.official,
          enabled: (byId.get(source.id)?.enabled ?? false) || source.enabled,
          hooksRoot: source.hooksRoot,
          publishDefaultMode: byId.get(source.id)?.publishDefaultMode,
          defaultBaseBranch: byId.get(source.id)?.defaultBaseBranch,
          providerHint: byId.get(source.id)?.providerHint,
          officialContributionEnabled: byId.get(source.id)?.officialContributionEnabled,
          credentialRef: source.credentialRef || byId.get(source.id)?.credentialRef,
          removable: (byId.get(source.id)?.removable ?? true) && source.removable,
          lastSyncAt: byId.get(source.id)?.lastSyncAt || source.lastSyncAt,
          lastError: byId.get(source.id)?.lastError || source.lastError,
          revision: byId.get(source.id)?.revision || source.revision,
        });
      }

      return {
        sources: Array.from(byId.values())
          .map((source) => toPublicSource(source))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    },

    executeInstallOperation(request) {
      return deps.executeOperation(options.repoRoot, request, { hooks: options.installHooks });
    },

    executeUninstallOperation(request) {
      return deps.executeOperation(options.repoRoot, request, { hooks: options.installHooks });
    },

    executeSyncOperation(request) {
      return deps.executeOperation(options.repoRoot, request, { hooks: options.installHooks });
    },

    checkForUpdate(installerVersion) {
      return deps.checkForAppUpdate(installerVersion);
    },

    async pickProjectDirectory(initialPath) {
      return {
        path: await deps.pickProjectDirectory(initialPath || process.cwd()),
      };
    },

    async registerSource(input) {
      const credentialProvider = createCredentialProvider();
      const registration = await registerRepository(
        {
          id: input.id,
          name: input.name,
          repoUrl: input.repoUrl,
          transport: input.transport,
          skillsRoot: input.skillsRoot,
          hooksRoot: input.hooksRoot,
          publishDefaultMode: input.publishDefaultMode,
          defaultBaseBranch: input.defaultBaseBranch,
          providerHint: input.providerHint,
          officialContributionEnabled: input.officialContributionEnabled,
          enabled: input.enabled,
          removable: input.removable,
          official: input.official,
          token: input.token,
        },
        credentialProvider,
      );
      const source = registration.skillSource;
      const auth = await checkSourceAuthInternal(
        {
          id: source.id,
          repoUrl: source.repoUrl,
          transport: source.transport,
        },
        credentialProvider,
      );
      if (!auth.ok) {
        await setSourceSyncStatus(source.id, { lastError: auth.message });
      }

      return {
        source,
        sync: registration.sync,
        auth,
      };
    },

    async updateSource(input) {
      const source = await updateSourceRecord(input.sourceId, {
        name: input.name,
        repoUrl: input.repoUrl,
        transport: input.transport,
        skillsRoot: input.skillsRoot,
        publishDefaultMode: input.publishDefaultMode,
        defaultBaseBranch: input.defaultBaseBranch,
        providerHint: input.providerHint,
        officialContributionEnabled: input.officialContributionEnabled,
        enabled: input.enabled,
        credentialRef: input.credentialRef,
        removable: input.removable,
        official: input.official,
      });
      try {
        await updateHookSourceRecord(input.sourceId, {
          name: input.name,
          repoUrl: input.repoUrl,
          transport: input.transport,
          hooksRoot: input.hooksRoot,
          enabled: input.enabled,
          credentialRef: input.credentialRef,
          removable: input.removable,
          official: input.official,
        });
      } catch {
        // Older environments may still have only skill sources configured.
      }

      const token = input.token?.trim() || "";
      if (token) {
        const credentialProvider = createCredentialProvider();
        await credentialProvider.store(input.sourceId, token);
        await updateSourceRecord(input.sourceId, { credentialRef: `${input.sourceId}:stored` });
        try {
          await updateHookSourceRecord(input.sourceId, { credentialRef: `${input.sourceId}:stored` });
        } catch {
          // ignore missing hook mirror
        }
      }

      return { source };
    },

    async removeSource(sourceId) {
      let removed: SkillSource | null = null;
      try {
        removed = await removeSourceRecord(sourceId);
      } catch {
        // allow hook-only removals in older setups
      }
      try {
        await removeHookSourceRecord(sourceId);
      } catch {
        // hooks mirror may not exist; ignore.
      }
      const credentialProvider = createCredentialProvider();
      await credentialProvider.delete(sourceId);
      return {
        source: removed || { id: sourceId },
      };
    },

    async checkSourceAuth(input) {
      const source =
        (await loadSourcesRecord()).find((item) => item.id === input.sourceId) ||
        (await loadHookSourcesRecord()).find((item) => item.id === input.sourceId);
      if (!source) {
        throw new Error(`Unknown source '${input.sourceId}'.`);
      }

      const credentialProvider = createCredentialProvider();
      const token = input.token?.trim() || "";
      if (token) {
        await credentialProvider.store(source.id, token);
        try {
          await updateSourceRecord(source.id, { credentialRef: `${source.id}:stored` });
        } catch {
          // ignore missing skill mirror
        }
        try {
          await updateHookSourceRecord(source.id, { credentialRef: `${source.id}:stored` });
        } catch {
          // ignore missing hook mirror
        }
      }

      return checkSourceAuthInternal(
        {
          id: source.id,
          repoUrl: source.repoUrl,
          transport: source.transport,
        },
        credentialProvider,
      );
    },

    async refreshSources(input = {}) {
      return refreshSourcesAndHooks(
        {
          credentials: createCredentialProvider(),
          loadSources: deps.loadSources,
          loadHookSources: deps.loadHookSources,
          syncSource: deps.syncSource,
          syncHookSource: deps.syncHookSource,
        },
        {
          sourceId: input.sourceId,
          onlyEnabled: input.onlyEnabled,
        },
      );
    },

    validateSkillBundle(input) {
      return validateSkillBundleInternal(
        {
          localPath: input.localPath,
          skillName: input.skillName,
        },
        input.profile,
      );
    },

    async publishSkillBundle(input) {
      const sources = await loadSourcesRecord();
      const targetSource = sources.find((source) => source.id === input.sourceId);
      if (!targetSource) {
        throw new Error(`Unknown source '${input.sourceId}'.`);
      }

      const catalog = await deps.loadCatalogFromSources(options.repoRoot, false);
      const normalizedLocalPath = normalizePathForMatch(input.localPath);
      const matchedSkill = catalog.skills.find((skill) => normalizePathForMatch(skill.sourcePath || "") === normalizedLocalPath);
      const matchedSource = matchedSkill ? sources.find((source) => source.id === matchedSkill.sourceId) : undefined;
      const officialBundle = Boolean(matchedSource?.official) || looksLikeOfficialSkillPath(input.localPath);
      if (officialBundle && !targetSource.official) {
        throw new Error("Official skills can only be published to official sources.");
      }

      return publishSkillBundleInternal(
        {
          sourceId: input.sourceId,
          bundle: {
            localPath: input.localPath,
            skillName: input.skillName,
          },
          commitMessage: input.commitMessage,
          overrideMode: input.overrideMode,
          overrideBaseBranch: input.overrideBaseBranch,
        },
        createCredentialProvider(),
      );
    },

    contributeOfficialSkillBundle(input) {
      return contributeOfficialSkillBundleInternal(
        {
          sourceId: input.sourceId,
          bundle: {
            localPath: input.localPath,
            skillName: input.skillName,
          },
          commitMessage: input.commitMessage,
        },
        createCredentialProvider(),
      );
    },
  };
}

export function withInstallerApplicationService(
  service: InstallerApplicationService,
  overrides?: Partial<InstallerApplicationService>,
): InstallerApplicationService {
  return {
    ...service,
    ...overrides,
  };
}
