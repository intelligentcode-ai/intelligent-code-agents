import os from "node:os";
import path from "node:path";
import { ensureDir, pathExists, readText, writeText } from "./fs";
import { SourceTransport, SkillSource } from "./types";

export const OFFICIAL_SOURCE_ID = "official-skills";
export const OFFICIAL_SOURCE_NAME = "official";
export const OFFICIAL_SOURCE_URL = "https://github.com/intelligentcode-ai/skills.git";
export const DEFAULT_SKILLS_ROOT = "/skills";

interface AddOrUpdateSourceInput {
  id?: string;
  name?: string;
  repoUrl: string;
  transport?: SourceTransport;
  official?: boolean;
  enabled?: boolean;
  skillsRoot?: string;
  credentialRef?: string;
  removable?: boolean;
}

function normalizeSkillsRoot(skillsRoot?: string): string {
  const next = (skillsRoot || DEFAULT_SKILLS_ROOT).trim();
  if (!next.startsWith("/")) {
    throw new Error(`skillsRoot must be absolute inside repository (example: '/skills'). Received: '${skillsRoot || ""}'`);
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

function sourceIdFromInput(input: AddOrUpdateSourceInput): string {
  if (input.id && input.id.trim()) {
    return slug(input.id);
  }

  const fromName = input.name ? slug(input.name) : "";
  if (fromName) return fromName;

  const fromRepo = slug(input.repoUrl.replace(/^https?:\/\//, "").replace(/^ssh:\/\//, "").replace(/^git@/, ""));
  return fromRepo || `source-${Date.now()}`;
}

function uniqueSourceId(baseId: string, existing: Set<string>): string {
  if (!existing.has(baseId)) return baseId;
  let counter = 2;
  while (existing.has(`${baseId}-${counter}`)) {
    counter += 1;
  }
  return `${baseId}-${counter}`;
}

function defaultSource(source?: Partial<SkillSource>): SkillSource {
  return {
    id: source?.id || OFFICIAL_SOURCE_ID,
    name: source?.name || OFFICIAL_SOURCE_NAME,
    repoUrl: source?.repoUrl || OFFICIAL_SOURCE_URL,
    transport: source?.transport || detectTransport(source?.repoUrl || OFFICIAL_SOURCE_URL),
    official: source?.official ?? true,
    enabled: source?.enabled ?? true,
    skillsRoot: normalizeSkillsRoot(source?.skillsRoot),
    credentialRef: source?.credentialRef,
    removable: source?.removable ?? true,
    lastSyncAt: source?.lastSyncAt,
    lastError: source?.lastError,
    localPath: source?.localPath,
    revision: source?.revision,
  };
}

export function getIcaStateRoot(): string {
  const envOverride = process.env.ICA_STATE_HOME || process.env.ICA_GLOBAL_HOME;
  if (envOverride && envOverride.trim()) {
    return path.resolve(envOverride);
  }
  return path.join(os.homedir(), ".ica");
}

export function getSourcesFilePath(): string {
  return path.join(getIcaStateRoot(), "sources.json");
}

export function getSourceCacheRoot(): string {
  return path.join(getIcaStateRoot(), "source-cache");
}

export function getSourceRoot(sourceId: string): string {
  return path.join(getIcaStateRoot(), sourceId);
}

export function getSourceRepoPath(sourceId: string): string {
  return path.join(getSourceCacheRoot(), sourceId, "repo");
}

export function getSourceSkillsPath(sourceId: string): string {
  return path.join(getSourceRoot(sourceId), "skills");
}

function normalizeSource(source: SkillSource): SkillSource {
  return {
    ...source,
    id: slug(source.id),
    name: source.name?.trim() || source.id,
    repoUrl: source.repoUrl.trim(),
    transport: source.transport || detectTransport(source.repoUrl),
    skillsRoot: normalizeSkillsRoot(source.skillsRoot),
    official: Boolean(source.official),
    enabled: source.enabled !== false,
    removable: source.removable !== false,
    credentialRef: source.credentialRef?.trim() || undefined,
    lastSyncAt: source.lastSyncAt,
    lastError: source.lastError,
    localPath: source.localPath,
    localSkillsPath: source.localSkillsPath,
    revision: source.revision,
  };
}

export async function loadSources(): Promise<SkillSource[]> {
  const sourcesFile = getSourcesFilePath();
  if (!(await pathExists(sourcesFile))) {
    return [defaultSource()];
  }

  try {
    const raw = JSON.parse(await readText(sourcesFile)) as { sources?: SkillSource[] };
    const parsed = Array.isArray(raw.sources) ? raw.sources : [];
    const normalized = parsed.map((source) => normalizeSource(source));

    if (!normalized.find((source) => source.official)) {
      normalized.unshift(defaultSource());
    }
    return normalized;
  } catch (error) {
    throw new Error(`Failed to read sources registry (${sourcesFile}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function saveSources(sources: SkillSource[]): Promise<void> {
  const normalized = sources.map((source) => normalizeSource(source));
  await ensureDir(path.dirname(getSourcesFilePath()));
  await writeText(getSourcesFilePath(), `${JSON.stringify({ sources: normalized }, null, 2)}\n`);
}

export async function addSource(input: AddOrUpdateSourceInput): Promise<SkillSource> {
  const sources = await loadSources();
  const existingIds = new Set(sources.map((source) => source.id));

  const baseId = sourceIdFromInput(input);
  const id = uniqueSourceId(baseId, existingIds);

  const source = normalizeSource({
    id,
    name: input.name || id,
    repoUrl: input.repoUrl,
    transport: input.transport || detectTransport(input.repoUrl),
    official: input.official ?? false,
    enabled: input.enabled ?? true,
    skillsRoot: normalizeSkillsRoot(input.skillsRoot),
    credentialRef: input.credentialRef,
    removable: input.removable ?? true,
  });

  sources.push(source);
  await saveSources(sources);
  return source;
}

export async function updateSource(sourceId: string, patch: Partial<AddOrUpdateSourceInput>): Promise<SkillSource> {
  const sources = await loadSources();
  const idx = sources.findIndex((source) => source.id === sourceId);
  if (idx === -1) {
    throw new Error(`Unknown source '${sourceId}'`);
  }

  const current = sources[idx];
  const next: SkillSource = normalizeSource({
    ...current,
    name: patch.name ?? current.name,
    repoUrl: patch.repoUrl ?? current.repoUrl,
    transport: patch.transport ?? current.transport,
    enabled: patch.enabled ?? current.enabled,
    skillsRoot: patch.skillsRoot ?? current.skillsRoot,
    credentialRef: patch.credentialRef ?? current.credentialRef,
    removable: patch.removable ?? current.removable,
    official: patch.official ?? current.official,
  });

  sources[idx] = next;
  await saveSources(sources);
  return next;
}

export async function removeSource(sourceId: string): Promise<SkillSource> {
  const sources = await loadSources();
  const idx = sources.findIndex((source) => source.id === sourceId);
  if (idx === -1) {
    throw new Error(`Unknown source '${sourceId}'`);
  }

  const source = sources[idx];
  if (!source.removable) {
    throw new Error(`Source '${sourceId}' cannot be removed.`);
  }

  sources.splice(idx, 1);
  await saveSources(sources);
  return source;
}

export async function setSourceSyncStatus(
  sourceId: string,
  status: { lastSyncAt?: string; lastError?: string; localPath?: string; localSkillsPath?: string; revision?: string },
): Promise<void> {
  const sources = await loadSources();
  const idx = sources.findIndex((source) => source.id === sourceId);
  if (idx === -1) return;

  const source = sources[idx];
  const next: SkillSource = {
    ...source,
      lastSyncAt: status.lastSyncAt ?? source.lastSyncAt,
      lastError: status.lastError,
      localPath: status.localPath ?? source.localPath,
      localSkillsPath: status.localSkillsPath ?? source.localSkillsPath,
      revision: status.revision ?? source.revision,
    };
  sources[idx] = normalizeSource(next);
  await saveSources(sources);
}

export async function ensureSourceRegistry(): Promise<SkillSource[]> {
  const sources = await loadSources();
  await saveSources(sources);
  return sources;
}
