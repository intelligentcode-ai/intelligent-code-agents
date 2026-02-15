import fs from "node:fs";
import path from "node:path";
import { createCredentialProvider } from "./credentials";
import { ensureHookSourceRegistry, HookSource, setHookSourceSyncStatus } from "./hookSources";
import { safeErrorMessage } from "./security";
import { syncHookSource } from "./hookSync";
import { TargetPlatform } from "./types";
import { computeDirectoryDigest } from "./contentDigest";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const HOOK_TARGETS = ["claude", "gemini"] as const;
type HookTargetPlatform = (typeof HOOK_TARGETS)[number];

interface HookRegistration {
  event: string;
  matcher?: string;
  command?: string;
}

interface HookManifest {
  name?: string;
  description?: string;
  version?: string;
  compatibleTargets?: HookTargetPlatform[];
  registrations?: Partial<Record<HookTargetPlatform, HookRegistration[]>>;
}

export interface CatalogHook {
  hookId: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  hookName: string;
  name: string;
  description: string;
  sourcePath: string;
  version?: string;
  updatedAt?: string;
  contentDigest?: string;
  contentFileCount?: number;
  compatibleTargets: Array<Extract<TargetPlatform, "claude" | "gemini">>;
  metadataFormat?: "json" | "markdown" | "directory";
  registrations?: Partial<Record<HookTargetPlatform, HookRegistration[]>>;
}

export interface HookCatalog {
  generatedAt: string;
  source: "multi-source";
  version: string;
  sources: HookSource[];
  hooks: CatalogHook[];
}

export interface HookInstallSelection {
  sourceId: string;
  hookName: string;
  hookId: string;
}

interface CatalogOptions {
  repoVersion: string;
  refresh: boolean;
}

function isHookTarget(value: string): value is HookTargetPlatform {
  return HOOK_TARGETS.includes(value as HookTargetPlatform);
}

function normalizeTargets(values: string[]): HookTargetPlatform[] {
  const filtered = values.map((value) => value.trim()).filter((value) => value.length > 0).filter(isHookTarget);
  return Array.from(new Set(filtered));
}

function parseFrontmatterList(raw: string | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.replace(/^["']|["']$/g, "").trim())
      .filter((item) => item.length > 0);
  }
  return trimmed
    .split(",")
    .map((item) => item.replace(/^["']|["']$/g, "").trim())
    .filter((item) => item.length > 0);
}

function normalizeRegistrations(value: unknown): Partial<Record<HookTargetPlatform, HookRegistration[]>> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const normalized: Partial<Record<HookTargetPlatform, HookRegistration[]>> = {};

  for (const target of HOOK_TARGETS) {
    const entries = input[target];
    if (!Array.isArray(entries)) continue;
    const parsed: HookRegistration[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const event = typeof item.event === "string" ? item.event.trim() : "";
      if (!event) continue;
      parsed.push({
        event,
        matcher: typeof item.matcher === "string" ? item.matcher : undefined,
        command: typeof item.command === "string" ? item.command : undefined,
      });
    }

    if (parsed.length > 0) {
      normalized[target] = parsed;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function parseHookManifest(hookDir: string): HookManifest {
  const hookJsonPath = path.join(hookDir, "HOOK.json");
  const hookMdPath = path.join(hookDir, "HOOK.md");
  let frontmatter: Record<string, string> = {};

  if (fs.existsSync(hookMdPath)) {
    const content = fs.readFileSync(hookMdPath, "utf8");
    frontmatter = parseFrontmatter(content);
  }

  if (fs.existsSync(hookJsonPath)) {
    const parsed = JSON.parse(fs.readFileSync(hookJsonPath, "utf8")) as Record<string, unknown>;
    const targetsFromJson = Array.isArray(parsed.compatibleTargets)
      ? normalizeTargets(parsed.compatibleTargets.filter((item): item is string => typeof item === "string"))
      : [];
    const targetsFromMd = normalizeTargets(parseFrontmatterList(frontmatter.targets));
    const compatibleTargets = targetsFromJson.length > 0 ? targetsFromJson : (targetsFromMd.length > 0 ? targetsFromMd : [...HOOK_TARGETS]);

    return {
      name: typeof parsed.name === "string" ? parsed.name : frontmatter.name,
      description: typeof parsed.description === "string" ? parsed.description : (frontmatter.description || ""),
      version: typeof parsed.version === "string" ? parsed.version : frontmatter.version,
      compatibleTargets,
      registrations: normalizeRegistrations(parsed.registrations),
    };
  }

  const compatibleTargets = normalizeTargets(parseFrontmatterList(frontmatter.targets));
  return {
    name: frontmatter.name,
    description: frontmatter.description || "",
    version: frontmatter.version,
    compatibleTargets: compatibleTargets.length > 0 ? compatibleTargets : [...HOOK_TARGETS],
  };
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return {};
  const map: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) map[key] = value;
  }
  return map;
}

function hookRootPath(source: HookSource, localRepoPath: string): string {
  if (source.localHooksPath && fs.existsSync(source.localHooksPath)) {
    return source.localHooksPath;
  }
  const relativeRoot = source.hooksRoot.replace(/^\/+/, "");
  return path.join(localRepoPath, relativeRoot);
}

function toCatalogHook(source: HookSource, hookDir: string): CatalogHook | null {
  const hookMdFile = path.join(hookDir, "HOOK.md");
  const hookJsonFile = path.join(hookDir, "HOOK.json");
  const statPath = fs.existsSync(hookJsonFile) ? hookJsonFile : (fs.existsSync(hookMdFile) ? hookMdFile : hookDir);
  const stat = fs.statSync(statPath);
  const manifest = parseHookManifest(hookDir);
  const hookName = manifest.name || path.basename(hookDir);
  const hookId = `${source.id}/${hookName}`;
  const digest = computeDirectoryDigest(hookDir);
  const metadataFormat = fs.existsSync(hookJsonFile) ? "json" : (fs.existsSync(hookMdFile) ? "markdown" : "directory");

  return {
    hookId,
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: source.repoUrl,
    hookName,
    name: hookName,
    description: manifest.description || "",
    sourcePath: hookDir,
    version: manifest.version,
    updatedAt: stat.mtime.toISOString(),
    contentDigest: digest.digest,
    contentFileCount: digest.fileCount,
    compatibleTargets: manifest.compatibleTargets || [...HOOK_TARGETS],
    metadataFormat,
    registrations: manifest.registrations,
  };
}

async function syncIfNeeded(source: HookSource, refresh: boolean): Promise<HookSource> {
  if (!source.enabled) return source;
  if (
    !refresh &&
    source.localPath &&
    source.localHooksPath &&
    fs.existsSync(path.join(source.localPath, ".git")) &&
    fs.existsSync(source.localHooksPath)
  ) {
    return source;
  }

  const provider = createCredentialProvider();
  const synced = await syncHookSource(source, provider);
  return {
    ...source,
    localPath: synced.localPath,
    localHooksPath: synced.hooksPath,
    revision: synced.revision,
    lastSyncAt: new Date().toISOString(),
    lastError: undefined,
  };
}

function sortCatalogHooks(hooks: CatalogHook[]): CatalogHook[] {
  return hooks.sort((a, b) => a.hookId.localeCompare(b.hookId));
}

async function buildMultiSourceHookCatalog(options: CatalogOptions): Promise<HookCatalog> {
  const sources = await ensureHookSourceRegistry();
  const hydratedSources: HookSource[] = [];
  const catalogHooks: CatalogHook[] = [];

  for (const source of sources) {
    if (!source.enabled) {
      hydratedSources.push(source);
      continue;
    }

    try {
      const hydrated = await syncIfNeeded(source, options.refresh);
      hydratedSources.push(hydrated);

      const localRepoPath = hydrated.localPath;
      if (!localRepoPath) {
        throw new Error(`Hook source '${source.id}' has no local checkout path.`);
      }

      const root = hookRootPath(hydrated, localRepoPath);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw new Error(`Hook source '${source.id}' is invalid: missing hooks root '${hydrated.hooksRoot}'.`);
      }

      const hookDirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name))
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

      for (const hookDir of hookDirs) {
        const item = toCatalogHook(hydrated, hookDir);
        if (item) catalogHooks.push(item);
      }
    } catch (error) {
      const message = safeErrorMessage(error, "Hook source refresh failed.");
      hydratedSources.push({
        ...source,
        lastError: message,
      });
      await setHookSourceSyncStatus(source.id, { lastError: message });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "multi-source",
    version: options.repoVersion,
    sources: hydratedSources,
    hooks: sortCatalogHooks(catalogHooks),
  };
}

export async function loadHookCatalogFromSources(repoRoot: string, refresh = false): Promise<HookCatalog> {
  const versionFile = path.join(repoRoot, "VERSION");
  const version = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : "0.0.0";
  return buildMultiSourceHookCatalog({
    repoVersion: version,
    refresh,
  });
}

export function findHookById(catalog: HookCatalog, hookId: string): CatalogHook | undefined {
  return catalog.hooks.find((hook) => hook.hookId === hookId);
}

export function findHookBySourceAndName(catalog: HookCatalog, sourceId: string, hookName: string): CatalogHook | undefined {
  return catalog.hooks.find((hook) => hook.sourceId === sourceId && hook.hookName === hookName);
}

export function resolveHookSelections(
  catalog: HookCatalog,
  selections: HookInstallSelection[] | undefined,
  legacyHooks: string[],
): HookInstallSelection[] {
  if (Array.isArray(selections) && selections.length > 0) {
    return selections.map((selection) => ({
      sourceId: selection.sourceId,
      hookName: selection.hookName,
      hookId: selection.hookId || `${selection.sourceId}/${selection.hookName}`,
    }));
  }

  const resolved: HookInstallSelection[] = [];
  for (const raw of legacyHooks) {
    const token = raw.trim();
    if (!token) continue;
    const slashIndex = token.indexOf("/");
    if (slashIndex > 0) {
      const sourceId = token.slice(0, slashIndex);
      const hookName = token.slice(slashIndex + 1);
      resolved.push({
        sourceId,
        hookName,
        hookId: `${sourceId}/${hookName}`,
      });
      continue;
    }

    const matches = catalog.hooks.filter((hook) => hook.hookName === token);
    if (matches.length !== 1) {
      throw new Error(`Legacy hook '${token}' is ambiguous or missing. Use source-qualified format '<source>/<hook>'.`);
    }

    resolved.push({
      sourceId: matches[0].sourceId,
      hookName: matches[0].hookName,
      hookId: matches[0].hookId,
    });
  }
  return resolved;
}
