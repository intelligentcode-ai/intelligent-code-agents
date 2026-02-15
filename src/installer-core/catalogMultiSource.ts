import fs from "node:fs";
import path from "node:path";
import { createCredentialProvider } from "./credentials";
import { setSourceSyncStatus, ensureSourceRegistry, OFFICIAL_SOURCE_ID } from "./sources";
import { syncSource } from "./sourceSync";
import { CatalogSkill, InstallSelection, SkillCatalog, SkillResource, SkillSource, TargetPlatform } from "./types";
import { isSkillBlocked } from "./skillBlocklist";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

interface CatalogOptions {
  repoVersion: string;
  refresh: boolean;
}

interface ParsedFrontmatter {
  values: Record<string, string>;
  lists: Record<string, string[]>;
}

function cleanFrontmatterValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { values: {}, lists: {} };
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let currentListKey: string | null = null;

  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      const key = keyMatch[1].trim();
      const rawValue = keyMatch[2].trim();
      if (!key) {
        currentListKey = null;
        continue;
      }

      if (rawValue.length === 0) {
        currentListKey = key;
        if (!lists[key]) lists[key] = [];
        continue;
      }

      if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
        const entries = rawValue
          .slice(1, -1)
          .split(",")
          .map((entry) => cleanFrontmatterValue(entry))
          .filter(Boolean);
        if (entries.length > 0) {
          lists[key] = entries;
        }
      } else {
        values[key] = cleanFrontmatterValue(rawValue);
      }
      currentListKey = null;
      continue;
    }

    const listMatch = line.match(/^\s*-\s*(.+)$/);
    if (currentListKey && listMatch) {
      const value = cleanFrontmatterValue(listMatch[1]);
      if (value) {
        if (!lists[currentListKey]) lists[currentListKey] = [];
        lists[currentListKey].push(value);
      }
      continue;
    }

    if (line.trim()) {
      currentListKey = null;
    }
  }

  return { values, lists };
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
  const walk = (current: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!(entry.isFile() || entry.isSymbolicLink())) continue;
      if (entry.name === "SKILL.md") continue;

      const relative = path.relative(skillDir, absolute).replace(/\\/g, "/");
      const topLevel = relative.split("/", 1)[0];
      const type: SkillResource["type"] =
        topLevel === "references" || topLevel === "scripts" || topLevel === "assets" ? topLevel : "other";
      resources.push({
        type,
        path: path.join("skills", skillName, relative).replace(/\\/g, "/"),
      });
    }
  };
  walk(skillDir);
  resources.sort((a, b) => a.path.localeCompare(b.path));
  return resources;
}

function skillRootPath(source: SkillSource, localRepoPath: string): string {
  if (source.localSkillsPath && fs.existsSync(source.localSkillsPath)) {
    return source.localSkillsPath;
  }
  const relativeRoot = source.skillsRoot.replace(/^\/+/, "");
  return path.join(localRepoPath, relativeRoot);
}

function toCatalogSkill(source: SkillSource, skillDir: string): CatalogSkill | null {
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) return null;
  const content = fs.readFileSync(skillFile, "utf8");
  const parsedFrontmatter = parseFrontmatter(content);
  const frontmatter = parsedFrontmatter.values;
  const skillName = frontmatter.name || path.basename(skillDir);
  if (isSkillBlocked(skillName)) {
    return null;
  }
  const skillId = `${source.id}/${skillName}`;
  const stat = fs.statSync(skillFile);
  const explicitCategory = (frontmatter.category || "").trim().toLowerCase();
  const explicitScope = (frontmatter.scope || "").trim().toLowerCase();
  const tags = Array.from(
    new Set(
      (parsedFrontmatter.lists.tags || [])
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  return {
    skillId,
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: source.repoUrl,
    skillName,
    name: skillName,
    description: frontmatter.description || "",
    category: explicitCategory || inferCategory(skillName),
    scope: explicitScope || undefined,
    tags: tags.length > 0 ? tags : undefined,
    dependencies: [],
    compatibleTargets: ["claude", "codex", "cursor", "gemini", "antigravity"] satisfies TargetPlatform[],
    resources: collectResources(skillDir, skillName),
    sourcePath: skillDir,
    version: frontmatter.version,
    updatedAt: stat.mtime.toISOString(),
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

      const skillDirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(root, entry.name))
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

      for (const skillDir of skillDirs) {
        const item = toCatalogSkill(hydrated, skillDir);
        if (item) catalogSkills.push(item);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
