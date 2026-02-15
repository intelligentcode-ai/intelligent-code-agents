import { CredentialProvider } from "./credentials";
import { HookSource } from "./hookSources";
import { HookSourceSyncResult } from "./hookSync";
import { SkillSource } from "./types";
import { SourceSyncResult } from "./sourceSync";
import { safeErrorMessage } from "./security";

export interface RefreshEntryResult {
  sourceId: string;
  skills?: { revision?: string; localPath?: string; error?: string };
  hooks?: { revision?: string; localPath?: string; error?: string };
}

interface RefreshDependencies {
  credentials: CredentialProvider;
  loadSources: () => Promise<SkillSource[]>;
  loadHookSources: () => Promise<HookSource[]>;
  syncSource: (source: SkillSource, credentials: CredentialProvider) => Promise<SourceSyncResult>;
  syncHookSource: (source: HookSource, credentials: CredentialProvider) => Promise<HookSourceSyncResult>;
}

function createSourceMap(skillSources: SkillSource[], hookSources: HookSource[]): Map<string, { skills?: SkillSource; hooks?: HookSource }> {
  const byId = new Map<string, { skills?: SkillSource; hooks?: HookSource }>();
  for (const source of skillSources) {
    byId.set(source.id, { ...(byId.get(source.id) || {}), skills: source });
  }
  for (const source of hookSources) {
    byId.set(source.id, { ...(byId.get(source.id) || {}), hooks: source });
  }
  return byId;
}

export async function refreshSourcesAndHooks(
  deps: RefreshDependencies,
  options: { sourceId?: string; onlyEnabled?: boolean } = {},
): Promise<{ refreshed: RefreshEntryResult[]; matched: boolean }> {
  const onlyEnabled = options.onlyEnabled !== false;
  const allSkills = await deps.loadSources();
  const allHooks = await deps.loadHookSources();
  const skillSources = onlyEnabled ? allSkills.filter((source) => source.enabled) : allSkills;
  const hookSources = onlyEnabled ? allHooks.filter((source) => source.enabled) : allHooks;
  const byId = createSourceMap(skillSources, hookSources);

  const sourceId = options.sourceId?.trim();
  const targetEntries: Array<[string, { skills?: SkillSource; hooks?: HookSource } | undefined]> = sourceId
    ? [[sourceId, byId.get(sourceId)]]
    : Array.from(byId.entries());
  const refreshed: RefreshEntryResult[] = [];
  for (const [id, entry] of targetEntries) {
    if (!entry) {
      continue;
    }
    const result: RefreshEntryResult = { sourceId: id };
    if (entry.skills) {
      try {
        const sync = await deps.syncSource(entry.skills, deps.credentials);
        result.skills = { revision: sync.revision, localPath: sync.localPath };
      } catch (error) {
        result.skills = { error: safeErrorMessage(error, "Skill source refresh failed.") };
      }
    }
    if (entry.hooks) {
      try {
        const sync = await deps.syncHookSource(entry.hooks, deps.credentials);
        result.hooks = { revision: sync.revision, localPath: sync.localPath };
      } catch (error) {
        result.hooks = { error: safeErrorMessage(error, "Hook source refresh failed.") };
      }
    }
    refreshed.push(result);
  }

  return {
    refreshed,
    matched: sourceId ? refreshed.length > 0 : refreshed.length > 0 || byId.size === 0,
  };
}
