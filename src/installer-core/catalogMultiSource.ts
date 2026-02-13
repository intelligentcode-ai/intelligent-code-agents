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

function toCatalogSkill(source: SkillSource, skillDir: string): CatalogSkill | null {
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) return null;
  const content = fs.readFileSync(skillFile, "utf8");
  const frontmatter = parseFrontmatter(content);
  const skillName = frontmatter.name || path.basename(skillDir);
  if (isSkillBlocked(skillName)) {
    return null;
  }
  const skillId = `${source.id}/${skillName}`;
  const stat = fs.statSync(skillFile);
  const explicitCategory = (frontmatter.category || "").trim().toLowerCase();

  return {
    skillId,
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: source.repoUrl,
    skillName,
    name: skillName,
    description: frontmatter.description || "",
    category: explicitCategory || inferCategory(skillName),
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
