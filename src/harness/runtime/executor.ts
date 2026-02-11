import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { AgentRegistry } from "../adapters/registry";
import { StageCommandCandidate } from "../adapters/types";
import { HarnessConfig, RunResult, RuntimeTarget, StageExecutionContext } from "../types";

interface ProcessSpec {
  command: string;
  argv: string[];
  timeoutMs: number;
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
}

interface ProcessResult {
  code: number;
  output: string;
}

function looksLikeContractError(output: string): boolean {
  const text = output.toLowerCase();
  return (
    text.includes("unknown option") ||
    text.includes("unknown command") ||
    text.includes("invalid choice") ||
    text.includes("unrecognized") ||
    text.includes("usage:")
  );
}

function defaultDockerImage(agent: string): string {
  const key = `ICA_HARNESS_DOCKER_IMAGE_${agent.toUpperCase()}`;
  return process.env[key] || `ghcr.io/intelligentcode-ai/ica-${agent}-cli:latest`;
}

function dockerizeCandidate(
  candidate: StageCommandCandidate,
  ctx: StageExecutionContext,
  config: HarnessConfig,
  env: Record<string, string>,
): StageCommandCandidate {
  const image = defaultDockerImage(ctx.profile.agent);
  const dockerEnvArgs = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  const dockerMountArgs = (ctx.authMounts || []).flatMap((mount) => [
    "-v",
    `${mount.hostPath}:${mount.containerPath}${mount.readOnly ? ":ro" : ""}`,
  ]);
  return {
    command: "docker",
    argv: [
      "run",
      "--rm",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-w",
      "/workspace",
      "-v",
      `${ctx.workItem.project_path}:/workspace`,
      "-v",
      `${config.authPath}:/harness-auth`,
      "-v",
      `${config.artifactsPath}:/harness-artifacts`,
      "-v",
      `${config.uploadsPath}:/harness-uploads`,
      ...dockerMountArgs,
      ...dockerEnvArgs,
      "-e",
      "ICA_HARNESS_RUNTIME=docker",
      image,
      candidate.command,
      ...candidate.argv,
    ],
    stdin: candidate.stdin,
    env: candidate.env,
  };
}

async function runProcess(spec: ProcessSpec): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.argv, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(spec.env || {}) },
      cwd: spec.cwd,
    });

    let output = "";
    child.stdout.on("data", (buf) => {
      output += buf.toString();
    });
    child.stderr.on("data", (buf) => {
      output += buf.toString();
    });

    if (spec.stdin) {
      child.stdin.write(spec.stdin);
    }
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ code: 124, output: `${output}\nTimed out after ${spec.timeoutMs}ms` });
    }, spec.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, output: `${output}\n${err.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: typeof code === "number" ? code : 1, output });
    });
  });
}

export class StageRunner {
  private readonly config: HarnessConfig;
  private readonly registry: AgentRegistry;
  private readonly processRunner: (spec: ProcessSpec) => Promise<ProcessResult>;

  constructor(
    config: HarnessConfig,
    registry: AgentRegistry,
    processRunner: (spec: ProcessSpec) => Promise<ProcessResult> = runProcess,
  ) {
    this.config = config;
    this.registry = registry;
    this.processRunner = processRunner;
  }

  async runStage(ctx: StageExecutionContext & { artifactDir: string; logPath: string }): Promise<{
    status: RunResult["status"];
    exitCode: number;
    errorText: string | null;
    output: string;
  }> {
    fs.mkdirSync(path.dirname(ctx.logPath), { recursive: true });
    fs.mkdirSync(ctx.artifactDir, { recursive: true });

    const adapter = this.registry.getAdapter(ctx.profile.agent);
    if (!adapter) {
      const message = `No adapter registered for agent ${ctx.profile.agent}.`;
      fs.writeFileSync(ctx.logPath, message);
      return { status: "failed", exitCode: 1, errorText: message, output: message };
    }

    const contract = adapter.buildStageCommand({
      stage: ctx.stage,
      model: ctx.profile.model,
      prompt: ctx.prompt,
    });

    const timeoutMs = Math.max(1, ctx.profile.timeout_s || 900) * 1000;
    const started = new Date().toISOString();
    const stageEnv = { ...(ctx.authEnv || {}) };

    let finalCommand = "";
    let finalArgs: string[] = [];
    let finalResult: ProcessResult = { code: 1, output: "No command candidates were produced." };

    for (const baseCandidate of contract.candidates) {
      const mergedEnv = { ...(baseCandidate.env || {}), ...stageEnv };
      const candidate =
        (ctx.profile.runtime as RuntimeTarget) === "docker"
          ? dockerizeCandidate(baseCandidate, ctx, this.config, mergedEnv)
          : { ...baseCandidate, env: mergedEnv };

      finalCommand = candidate.command;
      finalArgs = candidate.argv;

      const result = await this.processRunner({
        command: candidate.command,
        argv: candidate.argv,
        stdin: candidate.stdin,
        env: candidate.env,
        timeoutMs,
        cwd: ctx.workItem.project_path,
      });

      finalResult = result;
      if (result.code === 0) {
        break;
      }

      if (!looksLikeContractError(result.output)) {
        break;
      }
    }

    const ended = new Date().toISOString();

    const log = [
      `stage=${ctx.stage}`,
      `agent=${ctx.profile.agent}`,
      `model=${ctx.profile.model}`,
      `runtime=${ctx.profile.runtime}`,
      `started_at=${started}`,
      `ended_at=${ended}`,
      `exit_code=${finalResult.code}`,
      `command=${finalCommand} ${finalArgs.join(" ")}`,
      "--- output ---",
      finalResult.output,
    ].join("\n");
    fs.writeFileSync(ctx.logPath, log);

    const simulatedFinding = ctx.stage === "test" && /\[\[finding\]\]/i.test(ctx.prompt);
    if (simulatedFinding) {
      return {
        status: "failed",
        exitCode: 2,
        errorText: "Verifier emitted blocking findings.",
        output: `${finalResult.output}\nBlocking findings detected from prompt marker [[finding]].`,
      };
    }

    if (finalResult.code !== 0) {
      return {
        status: finalResult.code === 124 ? "needs_input" : "failed",
        exitCode: finalResult.code,
        errorText: finalResult.output.trim() || "Command failed",
        output: finalResult.output,
      };
    }

    return {
      status: "passed",
      exitCode: 0,
      errorText: null,
      output: finalResult.output,
    };
  }
}
