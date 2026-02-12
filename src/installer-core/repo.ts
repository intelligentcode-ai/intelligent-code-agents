import fs from "node:fs";
import path from "node:path";

export function findRepoRoot(startDir: string): string {
  let current = path.resolve(startDir);

  while (true) {
    const hasVersion = fs.existsSync(path.join(current, "VERSION"));
    const hasInstallerCore = fs.existsSync(path.join(current, "src", "installer-core"));
    if (hasVersion && hasInstallerCore) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not resolve repository root from ${startDir}`);
    }
    current = parent;
  }
}
