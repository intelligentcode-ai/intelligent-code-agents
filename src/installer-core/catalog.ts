import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { SkillCatalog, SkillCatalogEntry, SkillResource, TargetPlatform } from "./types";
import { buildMultiSourceCatalog } from "./catalogMultiSource";
import { isSkillBlocked } from "./skillBlocklist";
import { DEFAULT_SKILLS_ROOT, OFFICIAL_SOURCE_ID, OFFICIAL_SOURCE_NAME, OFFICIAL_SOURCE_URL, getIcaStateRoot } from "./sources";
import { frontmatterList, frontmatterString, parseFrontmatter } from "./skillMetadata";
import { pathExists, writeText } from "./fs";
import { computeDirectoryDigest } from "./contentDigest";

interface LocalCatalogEntry {
  name: string;
  description: string;
  category: string;
  scope?: string;
  subcategory?: string;
  tags?: string[];
  author?: string;
  contactEmail?: string;
  website?: string;
  dependencies: string[];
  compatibleTargets: TargetPlatform[];
  resources: SkillResource[];
  sourcePath: string;
  contentDigest?: string;
  contentFileCount?: number;
}

interface CacheRecord {
  catalog: SkillCatalog;
  savedAtMs: number;
}

export const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;
const CATALOG_CACHE_RELATIVE_PATH = path.join("catalog", "skills.catalog.json");

function inferCategory(skillName: string): string {
  const roleSkills = new Set([
    "pm",
    "architect",
    "developer",
    "system-engineer",
    "devops-engineer",
    "database-engineer",
    "security-engineer",
    "ai-engineer",
    "web-designer",
    "qa-engineer",
    "backend-tester",
    "requirements-engineer",
    "user-tester",
    "reviewer",
  ]);

  const enforcement = new Set(["file-placement", "branch-protection", "infrastructure-protection"]);
  const meta = new Set(["skill-creator", "skill-writer"]);

  if (roleSkills.has(skillName)) return "role";
  if (enforcement.has(skillName)) return "enforcement";
  if (meta.has(skillName)) return "meta";
  return "process";
}

function collectResources(skillDir: string): SkillResource[] {
  const resources: SkillResource[] = [];
  const directories: Array<SkillResource["type"]> = ["references", "scripts", "assets"];

  for (const resourceType of directories) {
    const location = path.join(skillDir, resourceType);
    if (!fs.existsSync(location)) continue;

    for (const file of fs
      .readdirSync(location, { withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name))) {
      resources.push({
        type: resourceType,
        path: path.join("skills", path.basename(skillDir), resourceType, file.name),
      });
    }
  }

  return resources;
}

function toCatalogEntry(skillDir: string, repoRoot: string): LocalCatalogEntry | null {
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    return null;
  }

  const content = fs.readFileSync(skillFile, "utf8");
  const frontmatter = parseFrontmatter(content);
  const name = frontmatterString(frontmatter, "name") || path.basename(skillDir);
  if (isSkillBlocked(name)) {
    return null;
  }
  const description = frontmatterString(frontmatter, "description") || "";
  const explicitCategory = (frontmatterString(frontmatter, "category") || "").trim().toLowerCase();
  const scope = (frontmatterString(frontmatter, "scope") || "").trim().toLowerCase() || undefined;
  const subcategory = (frontmatterString(frontmatter, "subcategory") || "").trim().toLowerCase() || undefined;
  const tags = frontmatterList(frontmatter, "tags");
  const author = frontmatterString(frontmatter, "author");
  const contactEmail = frontmatterString(frontmatter, "contact-email") || frontmatterString(frontmatter, "contactEmail");
  const website = frontmatterString(frontmatter, "website");
  const digest = computeDirectoryDigest(skillDir);

  return {
    name,
    description,
    category: explicitCategory || inferCategory(name),
    scope,
    subcategory,
    tags: tags.length > 0 ? tags : undefined,
    author,
    contactEmail,
    website,
    dependencies: [],
    compatibleTargets: ["claude", "codex", "cursor", "gemini", "antigravity"] satisfies TargetPlatform[],
    resources: collectResources(skillDir),
    sourcePath: path.relative(repoRoot, skillDir).replace(/\\/g, "/"),
    contentDigest: digest.digest,
    contentFileCount: digest.fileCount,
  };
}

function resolveGeneratedAt(sourceDateEpoch?: string): string {
  if (sourceDateEpoch && /^\d+$/.test(sourceDateEpoch)) {
    return new Date(Number(sourceDateEpoch) * 1000).toISOString();
  }

  // Stable default to keep generated artifacts reproducible across rebuilds.
  return "1970-01-01T00:00:00.000Z";
}

function normalizeCatalog(repoRoot: string, catalog: SkillCatalog): SkillCatalog {
  return {
    ...catalog,
    sources: catalog.sources || [],
    skills: (catalog.skills || []).map((skill) => ({
      ...skill,
      skillId: skill.skillId || `${skill.sourceId || "local"}/${skill.skillName || skill.name}`,
      sourceId: skill.sourceId || "local",
      sourceName: skill.sourceName || skill.sourceId || "local",
      sourceUrl: skill.sourceUrl || "",
      skillName: skill.skillName || skill.name,
      sourcePath: path.isAbsolute(skill.sourcePath || "") ? (skill.sourcePath || "") : path.resolve(repoRoot, skill.sourcePath || ""),
    })),
  };
}

function withLiveDiagnostics(catalog: SkillCatalog): SkillCatalog {
  return {
    ...catalog,
    stale: false,
    catalogSource: "live",
    staleReason: undefined,
    cacheAgeSeconds: undefined,
    nextRefreshAt: undefined,
  };
}

function withSnapshotDiagnostics(catalog: SkillCatalog, staleReason: string): SkillCatalog {
  return {
    ...catalog,
    stale: true,
    catalogSource: "snapshot",
    staleReason,
    cacheAgeSeconds: undefined,
    nextRefreshAt: undefined,
  };
}

function withCacheDiagnostics(catalog: SkillCatalog, savedAtMs: number, nowMs: number, staleReason?: string): SkillCatalog {
  const cacheAgeSeconds = Math.max(0, Math.floor((nowMs - savedAtMs) / 1000));
  const nextRefreshAt = new Date(savedAtMs + CATALOG_CACHE_TTL_MS).toISOString();
  const ttlExpired = nowMs >= savedAtMs + CATALOG_CACHE_TTL_MS;
  const stale = Boolean(staleReason) || ttlExpired;

  return {
    ...catalog,
    stale,
    catalogSource: "cache",
    staleReason: staleReason || (stale ? "Cached catalog is older than refresh TTL." : undefined),
    cacheAgeSeconds,
    nextRefreshAt,
  };
}

function liveUnavailableReason(catalog: SkillCatalog): string {
  const failures = catalog.sources.filter((source) => source.enabled !== false && source.lastError).map((source) => `${source.id}: ${source.lastError}`);
  if (failures.length > 0) {
    return `Live catalog refresh failed (${failures.join("; ")}).`;
  }

  const hasEnabledSource = catalog.sources.some((source) => source.enabled !== false);
  if (!hasEnabledSource) {
    return "No enabled skill sources are configured; serving fallback catalog.";
  }

  return "Live catalog returned zero skills; serving fallback catalog.";
}

function shouldAttemptLiveRefresh(refresh: boolean, cache: CacheRecord | null, nowMs: number): boolean {
  if (refresh) return true;
  if (!cache) return true;
  return nowMs >= cache.savedAtMs + CATALOG_CACHE_TTL_MS;
}

function cachePath(): string {
  return path.join(getIcaStateRoot(), CATALOG_CACHE_RELATIVE_PATH);
}

async function loadCatalogCache(repoRoot: string): Promise<CacheRecord | null> {
  const targetPath = cachePath();
  if (!(await pathExists(targetPath))) {
    return null;
  }

  try {
    const raw = await fsp.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw) as SkillCatalog;
    const stat = await fsp.stat(targetPath);
    return {
      catalog: normalizeCatalog(repoRoot, parsed),
      savedAtMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

async function saveCatalogCache(catalog: SkillCatalog): Promise<void> {
  const payload: SkillCatalog = {
    ...catalog,
    stale: undefined,
    catalogSource: undefined,
    staleReason: undefined,
    cacheAgeSeconds: undefined,
    nextRefreshAt: undefined,
  };
  await writeText(cachePath(), `${JSON.stringify(payload, null, 2)}\n`);
}

export function buildDefaultSourceCatalog(version: string, sourceDateEpoch?: string): SkillCatalog {
  return {
    generatedAt: resolveGeneratedAt(sourceDateEpoch),
    source: "multi-source",
    version,
    sources: [
      {
        id: OFFICIAL_SOURCE_ID,
        name: OFFICIAL_SOURCE_NAME,
        repoUrl: OFFICIAL_SOURCE_URL,
        transport: "https",
        official: true,
        enabled: true,
        skillsRoot: DEFAULT_SKILLS_ROOT,
        removable: true,
      },
    ],
    // Skills are discovered at runtime from configured sources.
    skills: [],
  };
}

export function buildLocalCatalog(repoRoot: string, version: string, sourceDateEpoch?: string): SkillCatalog {
  const skillsRoot = path.join(repoRoot, "src", "skills");
  const skills = fs.existsSync(skillsRoot)
    ? fs
        .readdirSync(skillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => toCatalogEntry(path.join(skillsRoot, entry.name), repoRoot))
        .filter((entry): entry is LocalCatalogEntry => Boolean(entry))
        .map((entry) => ({
          ...entry,
          skillId: `local/${entry.name}`,
          sourceId: "local",
          sourceName: "local",
          sourceUrl: "",
          skillName: entry.name,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return {
    generatedAt: resolveGeneratedAt(sourceDateEpoch),
    source: "local-repo",
    version,
    sources: [],
    skills,
  };
}

export function loadCatalogFromFile(catalogPath: string): SkillCatalog {
  const content = fs.readFileSync(catalogPath, "utf8");
  return JSON.parse(content) as SkillCatalog;
}

export function loadCatalog(repoRoot: string, fallbackVersion = "0.0.0"): SkillCatalog {
  const catalogPath = path.join(repoRoot, "src", "catalog", "skills.catalog.json");
  if (fs.existsSync(catalogPath)) {
    const catalog = loadCatalogFromFile(catalogPath);
    const normalized = normalizeCatalog(repoRoot, catalog);
    if (normalized.skills.length > 0) {
      return normalized;
    }
  }

  return buildLocalCatalog(repoRoot, fallbackVersion);
}

export async function loadCatalogFromSources(repoRoot: string, refresh = false): Promise<SkillCatalog> {
  const versionFile = path.join(repoRoot, "VERSION");
  const version = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : "0.0.0";
  const snapshot = loadCatalog(repoRoot, version);
  const cache = await loadCatalogCache(repoRoot);
  const nowMs = Date.now();
  let liveFailureReason: string | undefined;

  if (!shouldAttemptLiveRefresh(refresh, cache, nowMs) && cache) {
    return withCacheDiagnostics(cache.catalog, cache.savedAtMs, nowMs);
  }

  let multi: SkillCatalog;
  try {
    multi = await buildMultiSourceCatalog({
      repoVersion: version,
      refresh,
    });
  } catch {
    liveFailureReason = "Live catalog refresh failed unexpectedly; serving fallback catalog.";
    multi = {
      generatedAt: new Date().toISOString(),
      source: "multi-source",
      version,
      sources: [],
      skills: [],
    };
  }
  if (multi.skills.length > 0) {
    const live = withLiveDiagnostics(multi);
    try {
      await saveCatalogCache(live);
    } catch {
      // Cache persistence is best-effort; live catalog should still be returned.
    }
    return live;
  }

  const reason = liveFailureReason || liveUnavailableReason(multi);
  if (cache) {
    return withCacheDiagnostics(cache.catalog, cache.savedAtMs, nowMs, reason);
  }

  const fallback: SkillCatalog = {
    ...snapshot,
    source: multi.sources.length > 0 ? "multi-source" : snapshot.source,
    sources: multi.sources.length > 0 ? multi.sources : snapshot.sources,
  };
  return withSnapshotDiagnostics(fallback, `${reason} Serving bundled snapshot catalog.`);
}

export function findSkill(catalog: SkillCatalog, skillNameOrId: string): SkillCatalogEntry | undefined {
  return catalog.skills.find((skill) => skill.skillId === skillNameOrId || skill.name === skillNameOrId);
}
