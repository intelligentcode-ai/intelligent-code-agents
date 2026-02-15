import fs from "node:fs";
import path from "node:path";
import { SkillCatalog, SkillCatalogEntry, SkillResource, TargetPlatform } from "./types";
import { buildMultiSourceCatalog } from "./catalogMultiSource";
import { isSkillBlocked } from "./skillBlocklist";
import { DEFAULT_PUBLISH_MODE, DEFAULT_SKILLS_ROOT, OFFICIAL_SOURCE_ID, OFFICIAL_SOURCE_NAME, OFFICIAL_SOURCE_URL } from "./sources";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
interface LocalCatalogEntry {
  name: string;
  description: string;
  category: string;
  dependencies: string[];
  compatibleTargets: TargetPlatform[];
  resources: SkillResource[];
  sourcePath: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return {};
  }

  const map: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) {
      map[key] = value;
    }
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

function collectResources(skillDir: string): SkillResource[] {
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
      const resourceType: SkillResource["type"] =
        topLevel === "references" || topLevel === "scripts" || topLevel === "assets" ? topLevel : "other";
      resources.push({
        type: resourceType,
        path: path.join("skills", path.basename(skillDir), relative).replace(/\\/g, "/"),
      });
    }
  };
  walk(skillDir);
  resources.sort((a, b) => a.path.localeCompare(b.path));

  return resources;
}

function toCatalogEntry(skillDir: string, repoRoot: string): LocalCatalogEntry | null {
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    return null;
  }

  const content = fs.readFileSync(skillFile, "utf8");
  const frontmatter = parseFrontmatter(content);
  const name = frontmatter.name || path.basename(skillDir);
  if (isSkillBlocked(name)) {
    return null;
  }
  const description = frontmatter.description || "";
  const explicitCategory = (frontmatter.category || "").trim().toLowerCase();

  return {
    name,
    description,
    category: explicitCategory || inferCategory(name),
    dependencies: [],
    compatibleTargets: ["claude", "codex", "cursor", "gemini", "antigravity"] satisfies TargetPlatform[],
    resources: collectResources(skillDir),
    sourcePath: path.relative(repoRoot, skillDir).replace(/\\/g, "/"),
  };
}

function resolveGeneratedAt(sourceDateEpoch?: string): string {
  if (sourceDateEpoch && /^\d+$/.test(sourceDateEpoch)) {
    return new Date(Number(sourceDateEpoch) * 1000).toISOString();
  }

  // Stable default to keep generated artifacts reproducible across rebuilds.
  return "1970-01-01T00:00:00.000Z";
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
        publishDefaultMode: DEFAULT_PUBLISH_MODE,
        defaultBaseBranch: "dev",
        providerHint: "github",
        officialContributionEnabled: true,
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
    const normalized: SkillCatalog = {
      ...catalog,
      sources: catalog.sources || [],
      skills: catalog.skills.map((skill) => ({
        ...skill,
        skillId: skill.skillId || `${skill.sourceId || "local"}/${skill.skillName || skill.name}`,
        sourceId: skill.sourceId || "local",
        sourceName: skill.sourceName || skill.sourceId || "local",
        sourceUrl: skill.sourceUrl || "",
        skillName: skill.skillName || skill.name,
        sourcePath: path.isAbsolute(skill.sourcePath) ? skill.sourcePath : path.resolve(repoRoot, skill.sourcePath),
      })),
    };
    if (normalized.skills.length > 0) {
      return normalized;
    }
  }

  return buildLocalCatalog(repoRoot, fallbackVersion);
}

export async function loadCatalogFromSources(repoRoot: string, refresh = false): Promise<SkillCatalog> {
  const versionFile = path.join(repoRoot, "VERSION");
  const version = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : "0.0.0";
  const multi = await buildMultiSourceCatalog({
    repoVersion: version,
    refresh,
  });
  if (multi.skills.length > 0) {
    return multi;
  }
  const fallback = loadCatalog(repoRoot, version);
  return {
    ...fallback,
    source: multi.sources.length > 0 ? "multi-source" : fallback.source,
    sources: multi.sources.length > 0 ? multi.sources : fallback.sources,
  };
}

export function findSkill(catalog: SkillCatalog, skillNameOrId: string): SkillCatalogEntry | undefined {
  return catalog.skills.find((skill) => skill.skillId === skillNameOrId || skill.name === skillNameOrId);
}
