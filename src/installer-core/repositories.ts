import { CredentialProvider } from "./credentials";
import { addHookSource, HookSource, loadHookSources, updateHookSource } from "./hookSources";
import { syncHookSource } from "./hookSync";
import { addSource, loadSources, updateSource } from "./sources";
import { SkillSource } from "./types";
import { SourceTransport } from "./types";
import { syncSource } from "./sourceSync";

export interface RepositoryRegistrationInput {
  id?: string;
  name?: string;
  repoUrl: string;
  transport?: SourceTransport;
  enabled?: boolean;
  removable?: boolean;
  official?: boolean;
  skillsRoot?: string;
  hooksRoot?: string;
  token?: string;
}

export interface RepositorySyncResult {
  ok: boolean;
  revision?: string;
  localPath?: string;
  error?: string;
}

export interface RepositoryRegistrationResult {
  skillSource: SkillSource;
  hookSource: HookSource;
  sync: {
    skills: RepositorySyncResult;
    hooks: RepositorySyncResult;
  };
}

function sourceTransport(input: RepositoryRegistrationInput): SourceTransport {
  if (input.transport) return input.transport;
  if (input.repoUrl.startsWith("git@") || input.repoUrl.startsWith("ssh://")) {
    return "ssh";
  }
  return "https";
}

async function upsertSkillSource(input: RepositoryRegistrationInput): Promise<SkillSource> {
  const id = input.id?.trim();
  if (id) {
    const existing = (await loadSources()).find((source) => source.id === id);
    if (existing) {
      return updateSource(id, {
        name: input.name,
        repoUrl: input.repoUrl,
        transport: sourceTransport(input),
        enabled: input.enabled,
        skillsRoot: input.skillsRoot,
        removable: input.removable,
        official: input.official,
      });
    }
  }

  return addSource({
    id: input.id,
    name: input.name,
    repoUrl: input.repoUrl,
    transport: sourceTransport(input),
    enabled: input.enabled,
    skillsRoot: input.skillsRoot,
    removable: input.removable,
    official: input.official,
  });
}

async function upsertHookSource(input: RepositoryRegistrationInput): Promise<HookSource> {
  const id = input.id?.trim();
  if (id) {
    const existing = (await loadHookSources()).find((source) => source.id === id);
    if (existing) {
      return updateHookSource(id, {
        name: input.name,
        repoUrl: input.repoUrl,
        transport: sourceTransport(input),
        enabled: input.enabled,
        hooksRoot: input.hooksRoot,
        removable: input.removable,
        official: input.official,
      });
    }
  }

  return addHookSource({
    id: input.id,
    name: input.name,
    repoUrl: input.repoUrl,
    transport: sourceTransport(input),
    enabled: input.enabled,
    hooksRoot: input.hooksRoot,
    removable: input.removable,
    official: input.official,
  });
}

export async function registerRepository(
  input: RepositoryRegistrationInput,
  credentials: CredentialProvider,
): Promise<RepositoryRegistrationResult> {
  const skillSource = await upsertSkillSource(input);
  const hookSource = await upsertHookSource({
    ...input,
    id: input.id || skillSource.id,
    name: input.name || skillSource.name,
  });

  const token = input.token?.trim();
  if (token && sourceTransport(input) === "https") {
    await credentials.store(skillSource.id, token);
    if (hookSource.id !== skillSource.id) {
      await credentials.store(hookSource.id, token);
    }
  }

  let skillSync: RepositorySyncResult = { ok: false, error: "Not synced." };
  let hookSync: RepositorySyncResult = { ok: false, error: "Not synced." };

  try {
    const sync = await syncSource(skillSource, credentials);
    skillSync = {
      ok: true,
      revision: sync.revision,
      localPath: sync.localPath,
    };
  } catch (error) {
    skillSync = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const sync = await syncHookSource(hookSource, credentials);
    hookSync = {
      ok: true,
      revision: sync.revision,
      localPath: sync.localPath,
    };
  } catch (error) {
    hookSync = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    skillSource,
    hookSource,
    sync: {
      skills: skillSync,
      hooks: hookSync,
    },
  };
}
