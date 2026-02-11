import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function sqlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (typeof value === "object") {
    return quote(JSON.stringify(value));
  }
  return quote(String(value));
}

export class SqliteCli {
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    if (!fs.existsSync(dbPath)) {
      fs.closeSync(fs.openSync(dbPath, "a"));
    }
  }

  exec(sql: string): void {
    execFileSync("sqlite3", [this.dbPath, `PRAGMA foreign_keys=ON; ${sql}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  query<T>(sql: string): T[] {
    const output = execFileSync("sqlite3", ["-json", this.dbPath, `PRAGMA foreign_keys=ON; ${sql}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

    if (!output) {
      return [];
    }

    try {
      const parsed = JSON.parse(output) as T[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  first<T>(sql: string): T | null {
    const normalized = sql.trim().replace(/;+$/g, "");
    const rows = this.query<T>(`${normalized} LIMIT 1;`);
    return rows.length > 0 ? rows[0] : null;
  }

  transaction(statements: string[]): void {
    const script = [`BEGIN IMMEDIATE;`, ...statements, `COMMIT;`].join("\n");
    this.exec(script);
  }

  static quote = quote;
}
