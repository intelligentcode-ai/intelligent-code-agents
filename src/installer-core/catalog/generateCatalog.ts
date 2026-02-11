import fs from "node:fs";
import path from "node:path";
import { buildLocalCatalog } from "../catalog";
import { findRepoRoot } from "../repo";

function main(): void {
  const repoRoot = findRepoRoot(__dirname);
  const versionFile = path.join(repoRoot, "VERSION");
  const version = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : "0.0.0";
  const catalog = buildLocalCatalog(repoRoot, version);

  const outPath = path.join(repoRoot, "src", "catalog", "skills.catalog.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  process.stdout.write(`Generated ${outPath}\n`);
}

main();
