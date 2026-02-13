import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function assertPathWithin(basePath: string, candidatePath: string): void {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);
  if (resolvedCandidate !== resolvedBase && !resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error(`Path escape blocked: ${candidatePath}`);
  }
}

export function redactSensitive(input: string): string {
  let output = input;

  // Strip credentials embedded in URLs (https://user:pass@host/repo.git).
  output = output.replace(/(https?:\/\/[^/\s:@]+):[^@\s/]+@/gi, "$1:<redacted>@");
  // Strip URLs that only include a username/token segment.
  output = output.replace(/(https?:\/\/)[^@\s/]+@/gi, "$1<redacted>@");
  // Common key=value style secrets.
  output = output.replace(/(token|password|secret|api[_-]?key|key)\s*[=:]\s*[^\s,;]+/gi, "$1=<redacted>");
  // Authorization bearer token leaks.
  output = output.replace(/(authorization:\s*bearer\s+)[^\s,;]+/gi, "$1<redacted>");
  // Common token prefixes.
  output = output.replace(/\b(ghp_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|glpat-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9]{20,})\b/g, "<redacted>");

  return output;
}

export function stripUrlCredentials(repoUrl: string): string {
  if (!/^https?:\/\//i.test(repoUrl)) {
    return repoUrl;
  }

  try {
    const parsed = new URL(repoUrl);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return repoUrl.replace(/(https?:\/\/)[^@\s/]+@/i, "$1");
  }
}

export function safeErrorMessage(error: unknown, fallback = "Operation failed."): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSensitive(message).trim();
  if (!redacted) {
    return fallback;
  }
  return redacted;
}

export type CommandProbeRunner = (command: string, args: string[]) => Promise<void>;

export async function hasExecutable(
  executable: string,
  platform: NodeJS.Platform = process.platform,
  runner?: CommandProbeRunner,
): Promise<boolean> {
  const command = executable.trim();
  if (!command) return false;

  const probe = runner
    ? runner
    : async (binary: string, args: string[]) => {
        await execFileAsync(binary, args);
      };

  const checker = platform === "win32" ? "where" : "which";
  try {
    await probe(checker, [command]);
    return true;
  } catch {
    return false;
  }
}

export async function verifyChecksum(content: Buffer, expectedSha256: string): Promise<boolean> {
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  return hash.toLowerCase() === expectedSha256.toLowerCase();
}
