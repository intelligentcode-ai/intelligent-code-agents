import fs from "node:fs";
import path from "node:path";
import { buildDefaultSourceCatalog } from "../catalog";
import { findRepoRoot } from "../repo";
import { SkillCatalog } from "../types";

async function main(): Promise<void> {
  const repoRoot = findRepoRoot(__dirname);
  const versionFile = path.join(repoRoot, "VERSION");
  const version = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : "0.0.0";
  const outPath = path.join(repoRoot, "src", "catalog", "skills.catalog.json");
  let seededSkills: SkillCatalog["skills"] = [];
  if (fs.existsSync(outPath)) {
    try {
      const previous = JSON.parse(fs.readFileSync(outPath, "utf8")) as Partial<SkillCatalog>;
      if (Array.isArray(previous.skills) && previous.skills.length > 0) {
        seededSkills = previous.skills;
      }
    } catch {
      // Ignore invalid existing catalogs and regenerate from defaults.
    }
  }
  const catalog = {
    ...buildDefaultSourceCatalog(version, process.env.SOURCE_DATE_EPOCH),
    skills: seededSkills,
  } satisfies SkillCatalog;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  process.stdout.write(`Generated ${outPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`Catalog generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
