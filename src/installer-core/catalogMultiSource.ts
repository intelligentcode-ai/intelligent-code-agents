import fs from "node:fs";
import path from "node:path";
import { createCredentialProvider } from "./credentials";
import { safeErrorMessage } from "./security";
import { setSourceSyncStatus, ensureSourceRegistry, OFFICIAL_SOURCE_ID } from "./sources";
import { syncSource } from "./sourceSync";
import { CatalogSkill, InstallSelection, SkillCatalog, SkillResource, SkillSource, TargetPlatform } from "./types";
import { isSkillBlocked } from "./skillBlocklist";
import { frontmatterList, frontmatterString, parseFrontmatter } from "./skillMetadata";

interface CatalogOptions {
  repoVersion: string;
  refresh: boolean;
}

interface SkillIndexEntry {
  skillName?: string;
  name?: string;
  description?: string;
  category?: string;
  scope?: string;
  subcategory?: string;
  tags?: string[] | string;
  version?: string;
  author?: string;
  "contact-email"?: string;
  contactEmail?: string;
  website?: string;
}

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

function collectResources(skillDir: string, skillName: string): SkillResource[] {
  const resources: SkillResource[] = [];
  const directories: Array<SkillResource["type"]> = ["references", "scripts", "assets"];
  for (const type of directories) {
    const base = path.join(skillDir, type);
    if (!fs.existsSync(base)) continue;

    const files = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const file of files) {
      resources.push({
        type,
        path: path.join("skills", skillName, type, file.name).replace(/\\/g, "/"),
      });
    }
  }
  return resources;
}

function skillRootPath(source: SkillSource, localRepoPath: string): string {
  if (source.localSkillsPath && fs.existsSync(source.localSkillsPath)) {
    return source.localSkillsPath;
  }
  const relativeRoot = source.skillsRoot.replace(/^\/+/, "");
  return path.join(localRepoPath, relativeRoot);
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function loadSkillIndexEntries(localRepoPath: string, root: string): SkillIndexEntry[] | null {
  const candidates = [path.join(localRepoPath, "skills.index.json"), path.join(root, "skills.index.json")];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, "utf8")) as { skills?: SkillIndexEntry[] } | SkillIndexEntry[];
      if (Array.isArray(raw)) {
        return raw;
      }
      if (raw && Array.isArray(raw.skills)) {
        return raw.skills;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function toCatalogSkill(source: SkillSource, skillDir: string): CatalogSkill | null {
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) return null;
  const content = fs.readFileSync(skillFile, "utf8");
  const frontmatter = parseFrontmatter(content);
  const skillName = frontmatterString(frontmatter, "name") || path.basename(skillDir);
  if (isSkillBlocked(skillName)) {
    return null;
  }
  const skillId = `${source.id}/${skillName}`;
  const stat = fs.statSync(skillFile);
  const explicitCategory = (frontmatterString(frontmatter, "category") || "").trim().toLowerCase();
  const scope = (frontmatterString(frontmatter, "scope") || "").trim().toLowerCase() || undefined;
  const subcategory = (frontmatterString(frontmatter, "subcategory") || "").trim().toLowerCase() || undefined;
  const tags = frontmatterList(frontmatter, "tags");
  const author = frontmatterString(frontmatter, "author");
  const contactEmail = frontmatterString(frontmatter, "contact-email") || frontmatterString(frontmatter, "contactEmail");
  const website = frontmatterString(frontmatter, "website");

  return {
    skillId,
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: source.repoUrl,
    skillName,
    name: skillName,
    description: frontmatterString(frontmatter, "description") || "",
    category: explicitCategory || inferCategory(skillName),
    scope,
    subcategory,
    tags: tags.length > 0 ? tags : undefined,
    author,
    contactEmail,
    website,
    dependencies: [],
    compatibleTargets: ["claude", "codex", "cursor", "gemini", "antigravity"] satisfies TargetPlatform[],
    resources: collectResources(skillDir, skillName),
    sourcePath: skillDir,
    version: frontmatterString(frontmatter, "version"),
    updatedAt: stat.mtime.toISOString(),
  };
}

function toCatalogSkillFromIndex(source: SkillSource, root: string, entry: SkillIndexEntry): CatalogSkill | null {
  const skillName = (entry.skillName || entry.name || "").trim();
  if (!skillName || isSkillBlocked(skillName)) {
    return null;
  }

  const skillDir = path.join(root, skillName);
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    return null;
  }
  const stat = fs.statSync(skillFile);
  const explicitCategory = (entry.category || "").trim().toLowerCase();
  const scope = (entry.scope || "").trim().toLowerCase() || undefined;
  const subcategory = (entry.subcategory || "").trim().toLowerCase() || undefined;
  const tags = normalizeTags(entry.tags);

  return {
    skillId: `${source.id}/${skillName}`,
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: source.repoUrl,
    skillName,
    name: skillName,
    description: (entry.description || "").trim(),
    category: explicitCategory || inferCategory(skillName),
    scope,
    subcategory,
    tags: tags.length > 0 ? tags : undefined,
    author: entry.author?.trim() || undefined,
    contactEmail: entry.contactEmail?.trim() || entry["contact-email"]?.trim() || undefined,
    website: entry.website?.trim() || undefined,
    dependencies: [],
    compatibleTargets: ["claude", "codex", "cursor", "gemini", "antigravity"] satisfies TargetPlatform[],
    resources: collectResources(skillDir, skillName),
    sourcePath: skillDir,
    version: entry.version?.trim() || undefined,
    updatedAt: stat.mtime.toISOString(),
  };
}

function skillNameFromIndexEntry(entry: SkillIndexEntry): string {
  return (entry.skillName || entry.name || "").trim();
}

function loadSkillIndexMap(localRepoPath: string, root: string): Map<string, SkillIndexEntry> | null {
  const entries = loadSkillIndexEntries(localRepoPath, root);
  if (!entries) return null;

  const map = new Map<string, SkillIndexEntry>();
  for (const entry of entries) {
    const name = skillNameFromIndexEntry(entry);
    if (!name) continue;
    map.set(name, entry);
  }
  return map;
}

function applyIndexMetadata(skill: CatalogSkill, entry: SkillIndexEntry): CatalogSkill {
  const explicitCategory = (entry.category || "").trim().toLowerCase();
  const scope = (entry.scope || "").trim().toLowerCase() || undefined;
  const subcategory = (entry.subcategory || "").trim().toLowerCase() || undefined;
  const tags = normalizeTags(entry.tags);

  return {
    ...skill,
    description: (entry.description || "").trim() || skill.description,
    category: explicitCategory || skill.category,
    scope: scope || skill.scope,
    subcategory: subcategory || skill.subcategory,
    tags: tags.length > 0 ? tags : skill.tags,
    author: entry.author?.trim() || skill.author,
    contactEmail: entry.contactEmail?.trim() || entry["contact-email"]?.trim() || skill.contactEmail,
    website: entry.website?.trim() || skill.website,
    version: entry.version?.trim() || skill.version,
  };
}

async function syncIfNeeded(source: SkillSource, refresh: boolean): Promise<SkillSource> {
  if (!source.enabled) return source;
  if (
    !refresh &&
    source.localPath &&
    source.localSkillsPath &&
    fs.existsSync(path.join(source.localPath, ".git")) &&
    fs.existsSync(source.localSkillsPath)
  ) {
    return source;
  }

  const provider = createCredentialProvider();
  const synced = await syncSource(source, provider);
  return {
    ...source,
    localPath: synced.localPath,
    localSkillsPath: synced.skillsPath,
    revision: synced.revision,
    lastSyncAt: new Date().toISOString(),
    lastError: undefined,
  };
}

function sortCatalogSkills(skills: CatalogSkill[]): CatalogSkill[] {
  return skills.sort((a, b) => a.skillId.localeCompare(b.skillId));
}

export async function buildMultiSourceCatalog(options: CatalogOptions): Promise<SkillCatalog> {
  const sources = await ensureSourceRegistry();
  const hydratedSources: SkillSource[] = [];
  const catalogSkills: CatalogSkill[] = [];

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
        throw new Error(`Source '${source.id}' has no local checkout path.`);
      }

      const root = skillRootPath(hydrated, localRepoPath);
      if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw new Error(`Source '${source.id}' is invalid: missing skills root '${hydrated.skillsRoot}'.`);
      }

      const indexMap = loadSkillIndexMap(localRepoPath, root);

      const skillDirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name))
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

      const seenSkillNames = new Set<string>();
      for (const skillDir of skillDirs) {
        const discovered = toCatalogSkill(hydrated, skillDir);
        if (!discovered) continue;
        seenSkillNames.add(discovered.skillName);
        const indexEntry = indexMap?.get(discovered.skillName);
        catalogSkills.push(indexEntry ? applyIndexMetadata(discovered, indexEntry) : discovered);
      }

      if (indexMap) {
        for (const [skillName, entry] of indexMap.entries()) {
          if (seenSkillNames.has(skillName)) continue;
          const fromIndex = toCatalogSkillFromIndex(hydrated, root, entry);
          if (fromIndex) catalogSkills.push(fromIndex);
        }
      }
    } catch (error) {
      const message = safeErrorMessage(error, "Source refresh failed.");
      hydratedSources.push({
        ...source,
        lastError: message,
      });
      await setSourceSyncStatus(source.id, { lastError: message });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "multi-source",
    version: options.repoVersion,
    sources: hydratedSources,
    skills: sortCatalogSkills(catalogSkills),
  };
}

export function findSkillById(catalog: SkillCatalog, skillId: string): CatalogSkill | undefined {
  return catalog.skills.find((skill) => skill.skillId === skillId);
}

export function findSkillBySourceAndName(catalog: SkillCatalog, sourceId: string, skillName: string): CatalogSkill | undefined {
  return catalog.skills.find((skill) => skill.sourceId === sourceId && skill.skillName === skillName);
}

export function resolveInstallSelections(catalog: SkillCatalog, selections: InstallSelection[] | undefined, legacySkills: string[]): InstallSelection[] {
  if (Array.isArray(selections) && selections.length > 0) {
    return selections.map((selection) => ({
      sourceId: selection.sourceId,
      skillName: selection.skillName,
      skillId: selection.skillId || `${selection.sourceId}/${selection.skillName}`,
    }));
  }

  const resolved: InstallSelection[] = [];
  for (const raw of legacySkills) {
    const token = raw.trim();
    if (!token) continue;
    const slashIndex = token.indexOf("/");
    if (slashIndex > 0) {
      const sourceId = token.slice(0, slashIndex);
      const skillName = token.slice(slashIndex + 1);
      resolved.push({
        sourceId,
        skillName,
        skillId: `${sourceId}/${skillName}`,
      });
      continue;
    }

    const official = findSkillBySourceAndName(catalog, OFFICIAL_SOURCE_ID, token);
    if (!official) {
      throw new Error(
        `Legacy skill '${token}' was not found in official source '${OFFICIAL_SOURCE_ID}'. Use source-qualified format '<source>/<skill>'.`,
      );
    }

    resolved.push({
      sourceId: official.sourceId,
      skillName: official.skillName,
      skillId: official.skillId,
    });
  }
  return resolved;
}
