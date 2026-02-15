import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface DirectoryDigest {
  digest: string;
  fileCount: number;
}

function toPosixRelative(value: string): string {
  return value.split(path.sep).join("/");
}

function listDirectoryEntries(rootPath: string): Array<{ absolute: string; relative: string; kind: "file" | "symlink" }> {
  const stack: string[] = [rootPath];
  const items: Array<{ absolute: string; relative: string; kind: "file" | "symlink" }> = [];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }
      const absolute = path.join(current, entry.name);
      const relative = toPosixRelative(path.relative(rootPath, absolute));
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (entry.isSymbolicLink()) {
        items.push({ absolute, relative, kind: "symlink" });
        continue;
      }
      if (entry.isFile()) {
        items.push({ absolute, relative, kind: "file" });
      }
    }
  }

  return items.sort((a, b) => a.relative.localeCompare(b.relative));
}

export function computeDirectoryDigest(rootPath: string): DirectoryDigest {
  const hash = crypto.createHash("sha256");
  const entries = listDirectoryEntries(rootPath);

  for (const item of entries) {
    hash.update(`path:${item.relative}\n`);
    if (item.kind === "symlink") {
      const target = fs.readlinkSync(item.absolute, "utf8");
      hash.update("kind:symlink\n");
      hash.update(`target:${target}\n`);
      continue;
    }
    const content = fs.readFileSync(item.absolute);
    hash.update("kind:file\n");
    hash.update(`size:${content.byteLength}\n`);
    hash.update(content);
    hash.update("\n");
  }

  return {
    digest: `sha256:${hash.digest("hex")}`,
    fileCount: entries.length,
  };
}
