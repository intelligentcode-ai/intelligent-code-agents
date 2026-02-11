import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { AuthProvider, RuntimeAuthMount, RuntimeTarget } from "../types";

type SessionStatus = "running" | "completed" | "failed";

interface NativeAuthSpec {
  provider: AuthProvider;
  checkCommand?: { command: string; args: string[]; successPattern?: RegExp };
  startCommand: { command: string; args: string[] };
  dockerMounts?: Array<{ hostPath: string; containerPath: string; requiredFiles?: string[] }>;
  hostOnly?: boolean;
  docsUrl?: string;
}

export interface NativeAuthState {
  provider: AuthProvider;
  status: "authenticated" | "missing" | "unknown";
  message: string;
  supportsDockerMount: boolean;
  startCommand: string;
  docsUrl?: string;
}

export interface NativeAuthSession {
  id: number;
  provider: AuthProvider;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
  command: string;
  pid: number | null;
  exitCode: number | null;
  output: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function shellCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function runWithTimeout(spec: { command: string; args: string[]; timeoutMs: number }): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let output = "";
    child.stdout.on("data", (buf) => {
      output += buf.toString();
    });
    child.stderr.on("data", (buf) => {
      output += buf.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: 124, output: `${output}\nTimed out after ${spec.timeoutMs}ms` });
    }, spec.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, output: `${output}\n${error.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: typeof code === "number" ? code : 1,
        output,
      });
    });
  });
}

export class NativeAuthManager {
  private readonly repoRoot: string;
  private readonly homeDir: string;
  private readonly sessions = new Map<number, NativeAuthSession>();
  private nextSessionId = 1;

  constructor(repoRoot: string, homeDir = os.homedir()) {
    this.repoRoot = repoRoot;
    this.homeDir = homeDir;
  }

  private specs(): Record<AuthProvider, NativeAuthSpec> {
    return {
      codex: {
        provider: "codex",
        checkCommand: {
          command: "codex",
          args: ["login", "status"],
          successPattern: /logged in/i,
        },
        startCommand: {
          command: "codex",
          args: ["login", "--device-auth"],
        },
        dockerMounts: [
          {
            hostPath: path.join(this.homeDir, ".codex"),
            containerPath: "/root/.codex",
            requiredFiles: ["auth.json"],
          },
        ],
        docsUrl: "https://developers.openai.com/codex/auth/",
      },
      claude: {
        provider: "claude",
        startCommand: {
          command: "claude",
          args: ["setup-token"],
        },
        hostOnly: true,
      },
      gemini: {
        provider: "gemini",
        startCommand: {
          command: "gemini",
          args: [],
        },
        dockerMounts: [
          {
            hostPath: path.join(this.homeDir, ".gemini"),
            containerPath: "/root/.gemini",
            requiredFiles: ["oauth_creds.json"],
          },
        ],
      },
    };
  }

  private spec(provider: AuthProvider): NativeAuthSpec {
    return this.specs()[provider];
  }

  private heuristic(provider: AuthProvider): NativeAuthState {
    const spec = this.spec(provider);
    const startCommand = shellCommand(spec.startCommand.command, spec.startCommand.args);

    if (provider === "claude") {
      return {
        provider,
        status: "unknown",
        message: "Claude native auth status cannot be inferred from files. Use setup-token to refresh login.",
        supportsDockerMount: false,
        startCommand,
        docsUrl: spec.docsUrl,
      };
    }

    const mount = spec.dockerMounts?.[0];
    if (!mount) {
      return {
        provider,
        status: "unknown",
        message: "Native auth mount configuration is unavailable.",
        supportsDockerMount: false,
        startCommand,
        docsUrl: spec.docsUrl,
      };
    }

    if (!fs.existsSync(mount.hostPath)) {
      return {
        provider,
        status: "missing",
        message: `Native auth directory missing: ${mount.hostPath}`,
        supportsDockerMount: false,
        startCommand,
        docsUrl: spec.docsUrl,
      };
    }

    const required = mount.requiredFiles || [];
    const missing = required.filter((file) => !fs.existsSync(path.join(mount.hostPath, file)));
    if (missing.length > 0) {
      return {
        provider,
        status: "missing",
        message: `Missing native auth files in ${mount.hostPath}: ${missing.join(", ")}`,
        supportsDockerMount: false,
        startCommand,
        docsUrl: spec.docsUrl,
      };
    }

    return {
      provider,
      status: "authenticated",
      message: `Native credentials available at ${mount.hostPath}.`,
      supportsDockerMount: true,
      startCommand,
      docsUrl: spec.docsUrl,
    };
  }

  nativeState(provider: AuthProvider): NativeAuthState {
    return this.heuristic(provider);
  }

  async check(provider: AuthProvider): Promise<NativeAuthState> {
    const spec = this.spec(provider);
    const state = this.heuristic(provider);

    if (!spec.checkCommand) {
      return state;
    }

    const result = await runWithTimeout({
      command: spec.checkCommand.command,
      args: spec.checkCommand.args,
      timeoutMs: 20_000,
    });

    const pattern = spec.checkCommand.successPattern || /ok/i;
    if (result.code === 0 && pattern.test(result.output)) {
      return {
        ...state,
        status: "authenticated",
        message: result.output.trim() || "Native auth check passed.",
      };
    }

    return {
      ...state,
      status: "missing",
      message: result.output.trim() || "Native auth check failed.",
    };
  }

  start(provider: AuthProvider): NativeAuthSession {
    const spec = this.spec(provider);
    const child = spawn(spec.startCommand.command, spec.startCommand.args, {
      cwd: this.repoRoot,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session: NativeAuthSession = {
      id: this.nextSessionId++,
      provider,
      status: "running",
      startedAt: nowIso(),
      endedAt: null,
      command: shellCommand(spec.startCommand.command, spec.startCommand.args),
      pid: child.pid || null,
      exitCode: null,
      output: "",
    };
    this.sessions.set(session.id, session);

    const append = (chunk: Buffer): void => {
      const prior = session.output;
      const next = `${prior}${chunk.toString()}`;
      session.output = next.length > 20_000 ? next.slice(next.length - 20_000) : next;
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      session.status = "failed";
      session.endedAt = nowIso();
      session.output = `${session.output}\n${error.message}`.trim();
      session.exitCode = 127;
    });
    child.on("close", (code) => {
      session.status = typeof code === "number" && code === 0 ? "completed" : "failed";
      session.endedAt = nowIso();
      session.exitCode = typeof code === "number" ? code : 1;
    });

    return session;
  }

  getSession(id: number): NativeAuthSession | null {
    return this.sessions.get(id) || null;
  }

  stopSession(id: number): NativeAuthSession | null {
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }
    if (session.status === "running" && session.pid) {
      try {
        process.kill(session.pid, "SIGTERM");
      } catch {
        // no-op
      }
    }
    return session;
  }

  resolveRuntime(provider: AuthProvider, runtime: RuntimeTarget): { ok: boolean; message?: string; mounts?: RuntimeAuthMount[] } {
    const spec = this.spec(provider);
    const state = this.heuristic(provider);

    if (runtime === "host") {
      if (provider === "claude") {
        return { ok: true };
      }
      if (state.status !== "authenticated") {
        return {
          ok: false,
          message: `${provider} native auth is missing. Run: ${state.startCommand}`,
        };
      }
      return { ok: true };
    }

    if (spec.hostOnly) {
      return {
        ok: false,
        message: `${provider} native auth is host-only. Use runtime=host for this profile or switch auth mode.`,
      };
    }

    if (state.status !== "authenticated") {
      return {
        ok: false,
        message: `${provider} native auth credentials not found for Docker runtime. Run: ${state.startCommand}`,
      };
    }

    const mounts = (spec.dockerMounts || []).filter((mount) => fs.existsSync(mount.hostPath)).map((mount) => ({
      hostPath: mount.hostPath,
      containerPath: mount.containerPath,
      readOnly: true,
    }));

    if (mounts.length === 0) {
      return {
        ok: false,
        message: `${provider} native auth mount path missing.`,
      };
    }

    return {
      ok: true,
      mounts,
    };
  }
}
