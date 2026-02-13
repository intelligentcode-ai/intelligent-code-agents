import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CredentialProvider } from "./credentials";
import { safeErrorMessage, stripUrlCredentials } from "./security";
import { SourceTransport } from "./types";

const execFileAsync = promisify(execFile);

export interface SourceAuthCheckResult {
  ok: boolean;
  requiresCredential: boolean;
  message: string;
}

export interface AuthCheckSource {
  id: string;
  repoUrl: string;
  transport: SourceTransport;
}

export function withHttpsCredential(repoUrl: string, token: string): string {
  const parsed = new URL(stripUrlCredentials(repoUrl));
  parsed.username = "oauth2";
  parsed.password = token;
  return parsed.toString();
}

async function runGitLsRemote(repoUrl: string): Promise<void> {
  await execFileAsync("git", ["ls-remote", "--heads", repoUrl], {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

export async function checkSourceAuth(source: AuthCheckSource, credentials: CredentialProvider): Promise<SourceAuthCheckResult> {
  let token: string | null = null;
  if (source.transport === "https") {
    token = await credentials.get(source.id);
  }

  const candidateUrls = source.transport === "https" && token ? [withHttpsCredential(source.repoUrl, token), source.repoUrl] : [source.repoUrl];

  for (const candidate of candidateUrls) {
    try {
      await runGitLsRemote(candidate);
      return { ok: true, requiresCredential: false, message: "Repository access verified." };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const likelyAuth = /(authentication|auth|permission denied|could not read|terminal prompts disabled|access denied)/i.test(rawMessage);
      if (likelyAuth && source.transport === "https" && !token) {
        return { ok: false, requiresCredential: true, message: "Authentication required: provide a token/API key for this HTTPS source." };
      }
      if (candidate === candidateUrls[candidateUrls.length - 1]) {
        return {
          ok: false,
          requiresCredential: source.transport === "https" && !token,
          message: `Repository access failed: ${safeErrorMessage(error)}`,
        };
      }
    }
  }

  return {
    ok: false,
    requiresCredential: source.transport === "https" && !token,
    message: "Repository access failed.",
  };
}
