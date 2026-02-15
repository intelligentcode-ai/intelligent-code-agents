import path from "node:path";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CredentialProvider } from "./credentials";
import { copyPath, ensureDir, pathExists, removePath } from "./fs";
import { safeErrorMessage } from "./security";
import { withHttpsCredential } from "./sourceAuth";
import { getHookSourceHooksPath, getHookSourceRepoPath, HookSource, setHookSourceSyncStatus } from "./hookSources";

const execFileAsync = promisify(execFile);
const hookSourceSyncLocks = new Map<string, Promise<void>>();

export interface HookSourceSyncResult {
  source: HookSource;
  localPath: string;
  hooksPath: string;
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

async function withHookSourceSyncLock<T>(sourceId: string, task: () => Promise<T>): Promise<T> {
  const previous = hookSourceSyncLocks.get(sourceId) || Promise.resolve();
  let releaseLock = () => {};
  const lock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const chain = previous.then(() => lock);
  hookSourceSyncLocks.set(sourceId, chain);

  await previous;
  try {
    return await task();
  } finally {
    releaseLock();
    if (hookSourceSyncLocks.get(sourceId) === chain) {
      hookSourceSyncLocks.delete(sourceId);
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

  throw new Error("Unable to determine hook source default branch from origin.");
}

async function setOriginUrl(repoPath: string, repoUrl: string): Promise<void> {
  await runGitWithLockRetry(["remote", "set-url", "origin", repoUrl], repoPath);
}

function buildRemoteUrl(source: HookSource, token: string | null): string {
  if (source.transport === "https" && token) {
    return withHttpsCredential(source.repoUrl, token);
  }
  return source.repoUrl;
}

function hasHookMarker(repoRoot: string, hookDirName: string): Promise<boolean> {
  const hookDir = path.join(repoRoot, hookDirName);
  const candidate = path.join(hookDir, "HOOK.md");
  return pathExists(candidate);
}

async function findHookRootWithFallback(source: HookSource, repoPath: string): Promise<string> {
  const configuredRoot = path.join(repoPath, source.hooksRoot.replace(/^\/+/, ""));
  if (await pathExists(configuredRoot)) {
    return configuredRoot;
  }

  // Compatibility fallback: when /hooks is absent, allow repo-root hooks.
  const entries = await fsp.readdir(repoPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    if (await hasHookMarker(repoPath, entry.name)) {
      return repoPath;
    }

    // Optional HOOK.md structure: if absent, still allow directories that contain regular files.
    const dirEntries = await fsp.readdir(path.join(repoPath, entry.name), { withFileTypes: true });
    if (dirEntries.some((item) => item.isFile() || item.isSymbolicLink())) {
      return repoPath;
    }
  }

  throw new Error(`Hook source '${source.id}' is invalid: missing required hooks root '${source.hooksRoot}'.`);
}

async function mirrorHooksToStateStore(source: HookSource, repoPath: string): Promise<string> {
  const repoHooksRoot = await findHookRootWithFallback(source, repoPath);
  const destinationRoot = getHookSourceHooksPath(source.id);
  await removePath(destinationRoot);
  await ensureDir(destinationRoot);

  const entries = await fsp.readdir(repoHooksRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git") {
      continue;
    }
    const from = path.join(repoHooksRoot, entry.name);
    const to = path.join(destinationRoot, entry.name);
    await copyPath(from, to);
  }

  return destinationRoot;
}

export async function syncHookSource(source: HookSource, credentials: CredentialProvider): Promise<HookSourceSyncResult> {
  return withHookSourceSyncLock(source.id, async () => {
    const repoPath = getHookSourceRepoPath(source.id);
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
      const hooksPath = await mirrorHooksToStateStore(source, repoPath);

      await setHookSourceSyncStatus(source.id, {
        lastSyncAt: new Date().toISOString(),
        lastError: undefined,
        localPath: repoPath,
        localHooksPath: hooksPath,
        revision,
      });

      return {
        source,
        localPath: repoPath,
        hooksPath,
        revision,
      };
    } catch (error) {
      const message = safeErrorMessage(error, "Hook source sync failed.");
      await setHookSourceSyncStatus(source.id, {
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
