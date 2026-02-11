import fs from "node:fs";
import path from "node:path";
import { SkillCatalog, SkillCatalogEntry, SkillResource, TargetPlatform } from "./types";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

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

  const commandSkills = new Set(["ica-version", "ica-get-setting"]);
  const enforcement = new Set(["file-placement", "branch-protection", "infrastructure-protection"]);
  const meta = new Set(["skill-creator", "skill-writer"]);

  if (roleSkills.has(skillName)) return "role";
  if (commandSkills.has(skillName)) return "command";
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

    for (const file of fs.readdirSync(location, { withFileTypes: true })) {
      resources.push({
        type: resourceType,
        path: path.join("skills", path.basename(skillDir), resourceType, file.name),
      });
    }
  }

  return resources;
}

function toCatalogEntry(skillDir: string, repoRoot: string): SkillCatalogEntry | null {
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    return null;
  }

  const content = fs.readFileSync(skillFile, "utf8");
  const frontmatter = parseFrontmatter(content);
  const name = frontmatter.name || path.basename(skillDir);
  const description = frontmatter.description || "";

  return {
    name,
    description,
    category: inferCategory(name),
    dependencies: [],
    compatibleTargets: ["claude", "codex", "cursor", "gemini", "antigravity"] satisfies TargetPlatform[],
    resources: collectResources(skillDir),
    sourcePath: path.relative(repoRoot, skillDir).replace(/\\/g, "/"),
  };
}

export function buildLocalCatalog(repoRoot: string, version: string): SkillCatalog {
  const skillsRoot = path.join(repoRoot, "src", "skills");
  const skills = fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => toCatalogEntry(path.join(skillsRoot, entry.name), repoRoot))
    .filter((entry): entry is SkillCatalogEntry => Boolean(entry))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    source: "local-repo",
    version,
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
    return {
      ...catalog,
      skills: catalog.skills.map((skill) => ({
        ...skill,
        sourcePath: path.isAbsolute(skill.sourcePath) ? skill.sourcePath : path.resolve(repoRoot, skill.sourcePath),
      })),
    };
  }

  return buildLocalCatalog(repoRoot, fallbackVersion);
}

export function findSkill(catalog: SkillCatalog, skillName: string): SkillCatalogEntry | undefined {
  return catalog.skills.find((skill) => skill.name === skillName);
}
