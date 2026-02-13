import path from "node:path";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CredentialProvider } from "./credentials";
import { copyPath, ensureDir, pathExists, removePath } from "./fs";
import { withHttpsCredential } from "./sourceAuth";
import { getSourceRepoPath, getSourceSkillsPath, setSourceSyncStatus } from "./sources";
import { SkillSource } from "./types";

const execFileAsync = promisify(execFile);
const sourceSyncLocks = new Map<string, Promise<void>>();

export interface SourceSyncResult {
  source: SkillSource;
  localPath: string;
  skillsPath: string;
  revision: string;
}

async function runGit(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return (result.stdout || "").trim();
}

function isConfigLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /could not lock config file/i.test(message);
}

async function runGitWithLockRetry(args: string[], cwd?: string, maxAttempts = 5): Promise<string> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await runGit(args, cwd);
    } catch (error) {
      if (!isConfigLockError(error) || attempt >= maxAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 120 * attempt));
    }
  }
  throw new Error("git command failed unexpectedly");
}

async function withSourceSyncLock<T>(sourceId: string, task: () => Promise<T>): Promise<T> {
  const previous = sourceSyncLocks.get(sourceId) || Promise.resolve();
  let releaseLock = () => {};
  const lock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const chain = previous.then(() => lock);
  sourceSyncLocks.set(sourceId, chain);

  await previous;
  try {
    return await task();
  } finally {
    releaseLock();
    if (sourceSyncLocks.get(sourceId) === chain) {
      sourceSyncLocks.delete(sourceId);
    }
  }
}

async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const value = await runGit(["rev-parse", "--abbrev-ref", "origin/HEAD"], repoPath);
    if (value.startsWith("origin/")) {
      return value.slice("origin/".length);
    }
  } catch {
    // Fall through to common defaults.
  }

  try {
    await runGit(["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"], repoPath);
    return "main";
  } catch {
    return "master";
  }
}

async function setOriginUrl(repoPath: string, repoUrl: string): Promise<void> {
  await runGitWithLockRetry(["remote", "set-url", "origin", repoUrl], repoPath);
}

function buildRemoteUrl(source: SkillSource, token: string | null): string {
  if (source.transport === "https" && token) {
    return withHttpsCredential(source.repoUrl, token);
  }
  return source.repoUrl;
}

async function mirrorSkillsToStateStore(source: SkillSource, repoPath: string): Promise<string> {
  const configuredSkillsRoot = path.join(repoPath, source.skillsRoot.replace(/^\/+/, ""));
  let repoSkillsRoot = configuredSkillsRoot;
  if (!(await pathExists(repoSkillsRoot))) {
    // Compatibility fallback: if the configured root is missing, allow repo-root skills.
    const entries = await fsp.readdir(repoPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git") {
        continue;
      }
      const hasSkill = await pathExists(path.join(repoPath, entry.name, "SKILL.md"));
      if (hasSkill) {
        repoSkillsRoot = repoPath;
        break;
      }
    }
  }
  if (!(await pathExists(repoSkillsRoot))) {
    throw new Error(`Source '${source.id}' is invalid: missing required skills root '${source.skillsRoot}'.`);
  }

  const destinationRoot = getSourceSkillsPath(source.id);
  await removePath(destinationRoot);
  await ensureDir(destinationRoot);

  const entries = await fsp.readdir(repoSkillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const from = path.join(repoSkillsRoot, entry.name);
    if (!(await pathExists(path.join(from, "SKILL.md")))) {
      continue;
    }
    const to = path.join(destinationRoot, entry.name);
    await copyPath(from, to);
  }

  return destinationRoot;
}

export async function syncSource(source: SkillSource, credentials: CredentialProvider): Promise<SourceSyncResult> {
  return withSourceSyncLock(source.id, async () => {
    const repoPath = getSourceRepoPath(source.id);
    const sourceRoot = path.dirname(repoPath);
    await ensureDir(sourceRoot);

    const token = source.transport === "https" ? await credentials.get(source.id) : null;
    const remoteUrl = buildRemoteUrl(source, token);
    const hasGitRepo = await pathExists(path.join(repoPath, ".git"));
    const plainRemote = source.repoUrl;

    try {
      if (!hasGitRepo) {
        await runGit(["clone", "--depth", "1", remoteUrl, repoPath], sourceRoot);
        await setOriginUrl(repoPath, plainRemote);
      } else {
        await setOriginUrl(repoPath, remoteUrl);
        await runGit(["fetch", "--all", "--prune"], repoPath);
        await setOriginUrl(repoPath, plainRemote);
      }

      const branch = await detectDefaultBranch(repoPath);
      await runGit(["checkout", "-f", branch], repoPath);
      await runGit(["reset", "--hard", `origin/${branch}`], repoPath);
      const revision = await runGit(["rev-parse", "HEAD"], repoPath);
      const skillsPath = await mirrorSkillsToStateStore(source, repoPath);

      await setSourceSyncStatus(source.id, {
        lastSyncAt: new Date().toISOString(),
        lastError: undefined,
        localPath: repoPath,
        localSkillsPath: skillsPath,
        revision,
      });

      return {
        source,
        localPath: repoPath,
        skillsPath,
        revision,
      };
    } catch (error) {
      await setSourceSyncStatus(source.id, {
        lastError: error instanceof Error ? error.message : String(error),
        localPath: repoPath,
      });
      throw error;
    } finally {
      if (hasGitRepo) {
        try {
          await setOriginUrl(repoPath, plainRemote);
        } catch {
          // Ignore fallback reset failures.
        }
      }
    }
  });
}
