import fs from "node:fs";
import path from "node:path";
import { SqliteCli, sqlValue } from "./sqlite";

export function applyMigrations(db: SqliteCli, repoRoot: string): void {
  const dir = path.join(repoRoot, "src", "harness", "db", "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  const applied = db.query<{ version: string }>("SELECT version FROM schema_migrations;").map((row) => row.version);
  const appliedSet = new Set(applied);

  for (const file of files) {
    if (appliedSet.has(file)) {
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    db.transaction([
      sql,
      `INSERT INTO schema_migrations(version, applied_at) VALUES(${sqlValue(file)}, ${sqlValue(new Date().toISOString())});`,
    ]);
  }
}
