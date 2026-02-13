import fs from "node:fs";
import path from "node:path";
import { createCredentialProvider } from "./credentials";
import { ensureHookSourceRegistry, HookSource, setHookSourceSyncStatus } from "./hookSources";
import { syncHookSource } from "./hookSync";
import { TargetPlatform } from "./types";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

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
  compatibleTargets: Array<Extract<TargetPlatform, "claude" | "gemini">>;
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
  const hookFile = path.join(hookDir, "HOOK.md");
  const statPath = fs.existsSync(hookFile) ? hookFile : hookDir;
  const stat = fs.statSync(statPath);

  let frontmatter: Record<string, string> = {};
  if (fs.existsSync(hookFile)) {
    const content = fs.readFileSync(hookFile, "utf8");
    frontmatter = parseFrontmatter(content);
  }

  const hookName = frontmatter.name || path.basename(hookDir);
  const hookId = `${source.id}/${hookName}`;

  return {
    hookId,
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: source.repoUrl,
    hookName,
    name: hookName,
    description: frontmatter.description || "",
    sourcePath: hookDir,
    version: frontmatter.version,
    updatedAt: stat.mtime.toISOString(),
    compatibleTargets: ["claude", "gemini"],
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
      const message = error instanceof Error ? error.message : String(error);
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
