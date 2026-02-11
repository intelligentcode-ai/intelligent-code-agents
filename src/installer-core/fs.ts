import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath: string): Promise<void> {
  await fsp.mkdir(targetPath, { recursive: true });
}

export async function readText(targetPath: string): Promise<string> {
  return fsp.readFile(targetPath, "utf8");
}

export async function writeText(targetPath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  await fsp.writeFile(targetPath, content, "utf8");
}

export async function removePath(targetPath: string): Promise<void> {
  await fsp.rm(targetPath, { recursive: true, force: true });
}

export async function copyPath(source: string, destination: string): Promise<void> {
  const stat = await fsp.lstat(source);
  if (stat.isSymbolicLink()) {
    const link = await fsp.readlink(source);
    await ensureDir(path.dirname(destination));
    await fsp.symlink(link, destination);
    return;
  }

  if (stat.isDirectory()) {
    await ensureDir(destination);
    const entries = await fsp.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      const from = path.join(source, entry.name);
      const to = path.join(destination, entry.name);
      await copyPath(from, to);
    }
    return;
  }

  await ensureDir(path.dirname(destination));
  await fsp.copyFile(source, destination);
}

export async function trySymlinkDirectory(source: string, destination: string): Promise<void> {
  await ensureDir(path.dirname(destination));
  await fsp.symlink(source, destination, "dir");
}

export function listDirectories(sourcePath: string): string[] {
  if (!fs.existsSync(sourcePath)) {
    return [];
  }
  return fs
    .readdirSync(sourcePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
