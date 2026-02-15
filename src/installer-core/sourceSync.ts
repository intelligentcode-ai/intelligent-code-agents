import path from "node:path";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CredentialProvider } from "./credentials";
import { copyPath, ensureDir, pathExists, removePath } from "./fs";
import { safeErrorMessage } from "./security";
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

async function hasRemoteBranch(repoPath: string, branch: string): Promise<boolean> {
  try {
    await runGit(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], repoPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureOriginFetchRefspec(repoPath: string): Promise<void> {
  const wildcardRefspec = "+refs/heads/*:refs/remotes/origin/*";
  const configured = await runGit(["config", "--get-all", "remote.origin.fetch"], repoPath).catch(() => "");
  const current = configured
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (current.length === 1 && current[0] === wildcardRefspec) {
    return;
  }

  if (current.length > 0) {
    await runGitWithLockRetry(["config", "--unset-all", "remote.origin.fetch"], repoPath);
  }
  await runGitWithLockRetry(["config", "--add", "remote.origin.fetch", wildcardRefspec], repoPath);
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
    const symRef = await runGit(["ls-remote", "--symref", "origin", "HEAD"], repoPath);
    const match = symRef.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/i);
    if (match?.[1]) {
      return match[1];
    }
  } catch {
    // Fall through to local remote-tracking refs.
  }

  try {
    const value = await runGit(["rev-parse", "--abbrev-ref", "origin/HEAD"], repoPath);
    if (value.startsWith("origin/")) {
      return value.slice("origin/".length);
    }
  } catch {
    // Fall through to common defaults.
  }

  const preferred = ["main", "master"];
  for (const branch of preferred) {
    if (await hasRemoteBranch(repoPath, branch)) {
      return branch;
    }
  }

  const discovered = await runGit(["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], repoPath).catch(() => "");
  for (const ref of discovered.split(/\r?\n/)) {
    const trimmed = ref.trim();
    if (!trimmed || trimmed === "origin/HEAD" || !trimmed.startsWith("origin/")) {
      continue;
    }
    return trimmed.slice("origin/".length);
  }

  throw new Error("Unable to determine source default branch from origin.");
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
        await ensureOriginFetchRefspec(repoPath);
        await runGit(["fetch", "origin", "--prune"], repoPath);
        await setOriginUrl(repoPath, plainRemote);
      } else {
        await setOriginUrl(repoPath, remoteUrl);
        await ensureOriginFetchRefspec(repoPath);
        await runGit(["fetch", "origin", "--prune"], repoPath);
        await setOriginUrl(repoPath, plainRemote);
      }

      const branch = await detectDefaultBranch(repoPath);
      await runGit(["checkout", "-f", "-B", branch, `origin/${branch}`], repoPath);
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
      const message = safeErrorMessage(error, "Source sync failed.");
      await setSourceSyncStatus(source.id, {
        lastError: message,
        localPath: repoPath,
      });
      throw new Error(message);
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
