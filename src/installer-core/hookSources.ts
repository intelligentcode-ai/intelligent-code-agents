import path from "node:path";
import { ensureDir, pathExists, readText, writeText } from "./fs";
import { redactSensitive, stripUrlCredentials } from "./security";
import { getIcaStateRoot } from "./sources";
import { SourceTransport } from "./types";

export interface HookSource {
  id: string;
  name: string;
  repoUrl: string;
  transport: SourceTransport;
  official: boolean;
  enabled: boolean;
  hooksRoot: string;
  credentialRef?: string;
  removable: boolean;
  lastSyncAt?: string;
  lastError?: string;
  localPath?: string;
  localHooksPath?: string;
  revision?: string;
}

interface AddOrUpdateHookSourceInput {
  id?: string;
  name?: string;
  repoUrl: string;
  transport?: SourceTransport;
  official?: boolean;
  enabled?: boolean;
  hooksRoot?: string;
  credentialRef?: string;
  removable?: boolean;
}

export const OFFICIAL_HOOK_SOURCE_ID = "official-hooks";
export const OFFICIAL_HOOK_SOURCE_NAME = "official-hooks";
export const OFFICIAL_HOOK_SOURCE_URL = "https://github.com/intelligentcode-ai/hooks.git";
export const DEFAULT_HOOKS_ROOT = "/hooks";

function normalizeHooksRoot(hooksRoot?: string): string {
  const next = (hooksRoot || DEFAULT_HOOKS_ROOT).trim();
  if (!next.startsWith("/")) {
    throw new Error(`hooksRoot must be absolute inside repository (example: '/hooks'). Received: '${hooksRoot || ""}'`);
  }
  return next.replace(/\/+$/, "") || "/";
}

function detectTransport(repoUrl: string): SourceTransport {
  if (repoUrl.startsWith("git@") || repoUrl.startsWith("ssh://")) {
    return "ssh";
  }
  return "https";
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
}

function hookSourceIdFromInput(input: AddOrUpdateHookSourceInput): string {
  if (input.id && input.id.trim()) {
    return slug(input.id);
  }

  const fromName = input.name ? slug(input.name) : "";
  if (fromName) return fromName;

  const fromRepo = slug(input.repoUrl.replace(/^https?:\/\//, "").replace(/^ssh:\/\//, "").replace(/^git@/, ""));
  return fromRepo || `hook-source-${Date.now()}`;
}

function uniqueHookSourceId(baseId: string, existing: Set<string>): string {
  if (!existing.has(baseId)) return baseId;
  let counter = 2;
  while (existing.has(`${baseId}-${counter}`)) {
    counter += 1;
  }
  return `${baseId}-${counter}`;
}

function defaultHookSource(source?: Partial<HookSource>): HookSource {
  return {
    id: source?.id || OFFICIAL_HOOK_SOURCE_ID,
    name: source?.name || OFFICIAL_HOOK_SOURCE_NAME,
    repoUrl: source?.repoUrl || OFFICIAL_HOOK_SOURCE_URL,
    transport: source?.transport || detectTransport(source?.repoUrl || OFFICIAL_HOOK_SOURCE_URL),
    official: source?.official ?? true,
    enabled: source?.enabled ?? true,
    hooksRoot: normalizeHooksRoot(source?.hooksRoot),
    credentialRef: source?.credentialRef,
    removable: source?.removable ?? true,
    lastSyncAt: source?.lastSyncAt,
    lastError: source?.lastError,
    localPath: source?.localPath,
    localHooksPath: source?.localHooksPath,
    revision: source?.revision,
  };
}

export function getHookSourcesFilePath(): string {
  return path.join(getIcaStateRoot(), "hook-sources.json");
}

export function getHookSourceCacheRoot(): string {
  return path.join(getIcaStateRoot(), "hook-source-cache");
}

export function getHookSourceRoot(sourceId: string): string {
  return path.join(getIcaStateRoot(), sourceId);
}

export function getHookSourceRepoPath(sourceId: string): string {
  return path.join(getHookSourceCacheRoot(), sourceId, "repo");
}

export function getHookSourceHooksPath(sourceId: string): string {
  return path.join(getHookSourceRoot(sourceId), "hooks");
}

function normalizeHookSource(source: HookSource): HookSource {
  const cleanRepoUrl = stripUrlCredentials(source.repoUrl.trim());
  return {
    ...source,
    id: slug(source.id),
    name: source.name?.trim() || source.id,
    repoUrl: cleanRepoUrl,
    transport: source.transport || detectTransport(source.repoUrl),
    hooksRoot: normalizeHooksRoot(source.hooksRoot),
    official: Boolean(source.official),
    enabled: source.enabled !== false,
    removable: source.removable !== false,
    credentialRef: source.credentialRef?.trim() || undefined,
    lastSyncAt: source.lastSyncAt,
    lastError: source.lastError ? redactSensitive(source.lastError) : undefined,
    localPath: source.localPath,
    localHooksPath: source.localHooksPath,
    revision: source.revision,
  };
}

export async function loadHookSources(): Promise<HookSource[]> {
  const sourceFile = getHookSourcesFilePath();
  if (!(await pathExists(sourceFile))) {
    return [defaultHookSource()];
  }

  try {
    const raw = JSON.parse(await readText(sourceFile)) as { sources?: HookSource[] };
    const parsed = Array.isArray(raw.sources) ? raw.sources : [];
    const normalized = parsed.map((source) => normalizeHookSource(source));
    if (!normalized.find((source) => source.official)) {
      normalized.unshift(defaultHookSource());
    }
    return normalized;
  } catch (error) {
    throw new Error(`Failed to read hook source registry (${sourceFile}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveHookSources(sources: HookSource[]): Promise<void> {
  const normalized = sources.map((source) => normalizeHookSource(source));
  await ensureDir(path.dirname(getHookSourcesFilePath()));
  await writeText(getHookSourcesFilePath(), `${JSON.stringify({ sources: normalized }, null, 2)}\n`);
}

export async function addHookSource(input: AddOrUpdateHookSourceInput): Promise<HookSource> {
  const sources = await loadHookSources();
  const existingIds = new Set(sources.map((source) => source.id));

  const baseId = hookSourceIdFromInput(input);
  const id = uniqueHookSourceId(baseId, existingIds);

  const source = normalizeHookSource({
    id,
    name: input.name || id,
    repoUrl: input.repoUrl,
    transport: input.transport || detectTransport(input.repoUrl),
    official: input.official ?? false,
    enabled: input.enabled ?? true,
    hooksRoot: normalizeHooksRoot(input.hooksRoot),
    credentialRef: input.credentialRef,
    removable: input.removable ?? true,
  });

  sources.push(source);
  await saveHookSources(sources);
  return source;
}

export async function updateHookSource(sourceId: string, patch: Partial<AddOrUpdateHookSourceInput>): Promise<HookSource> {
  const sources = await loadHookSources();
  const idx = sources.findIndex((source) => source.id === sourceId);
  if (idx === -1) {
    throw new Error(`Unknown hook source '${sourceId}'`);
  }

  const current = sources[idx];
  const next: HookSource = normalizeHookSource({
    ...current,
    name: patch.name ?? current.name,
    repoUrl: patch.repoUrl ?? current.repoUrl,
    transport: patch.transport ?? current.transport,
    enabled: patch.enabled ?? current.enabled,
    hooksRoot: patch.hooksRoot ?? current.hooksRoot,
    credentialRef: patch.credentialRef ?? current.credentialRef,
    removable: patch.removable ?? current.removable,
    official: patch.official ?? current.official,
  });

  sources[idx] = next;
  await saveHookSources(sources);
  return next;
}

export async function removeHookSource(sourceId: string): Promise<HookSource> {
  const sources = await loadHookSources();
  const idx = sources.findIndex((source) => source.id === sourceId);
  if (idx === -1) {
    throw new Error(`Unknown hook source '${sourceId}'`);
  }

  const source = sources[idx];
  if (!source.removable) {
    throw new Error(`Hook source '${sourceId}' cannot be removed.`);
  }

  sources.splice(idx, 1);
  await saveHookSources(sources);
  return source;
}

export async function setHookSourceSyncStatus(
  sourceId: string,
  status: { lastSyncAt?: string; lastError?: string; localPath?: string; localHooksPath?: string; revision?: string },
): Promise<void> {
  const sources = await loadHookSources();
  const idx = sources.findIndex((source) => source.id === sourceId);
  if (idx === -1) return;

  const source = sources[idx];
  const nextError = typeof status.lastError === "string" ? redactSensitive(status.lastError) : status.lastError;
  const next: HookSource = {
    ...source,
    lastSyncAt: status.lastSyncAt ?? source.lastSyncAt,
    lastError: nextError,
    localPath: status.localPath ?? source.localPath,
    localHooksPath: status.localHooksPath ?? source.localHooksPath,
    revision: status.revision ?? source.revision,
  };
  sources[idx] = normalizeHookSource(next);
  await saveHookSources(sources);
}

export async function ensureHookSourceRegistry(): Promise<HookSource[]> {
  const sources = await loadHookSources();
  await saveHookSources(sources);
  return sources;
}
