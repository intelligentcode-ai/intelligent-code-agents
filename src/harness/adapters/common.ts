import { spawnSync } from "node:child_process";
import { AgentCapabilities, DiscoveryResult, RuntimeTarget } from "../types";

export function probeBinary(args: {
  agent: string;
  binary: string;
  runtime: RuntimeTarget;
  versionArgs?: string[];
  capability: AgentCapabilities;
}): DiscoveryResult {
  const versionArgs = args.versionArgs || ["--version"];
  const whichResult = spawnSync("which", [args.binary], { encoding: "utf8" });

  if (whichResult.status !== 0) {
    return {
      agent: args.agent,
      status: "missing",
      runtime: args.runtime,
      location: "",
      version: "",
      capabilities: args.capability,
      notes: [`Binary ${args.binary} not found on PATH.`],
    };
  }

  const location = whichResult.stdout.trim();
  const versionResult = spawnSync(args.binary, versionArgs, { encoding: "utf8" });
  const versionOut = `${versionResult.stdout || ""}\n${versionResult.stderr || ""}`.trim();

  return {
    agent: args.agent,
    status: versionResult.status === 0 ? "ready" : "degraded",
    runtime: args.runtime,
    location,
    version: versionOut.split("\n")[0] || "unknown",
    capabilities: args.capability,
    notes: versionResult.status === 0 ? [] : ["Version command failed; runtime may still work."],
  };
}

export function echoCommand(binary: string, stage: string, model: string, prompt: string): { command: string; argv: string[] } {
  const snippet = prompt.slice(0, 3000);
  return {
    command: binary,
    argv: ["run", "--model", model, "--stage", stage, "--prompt", snippet],
  };
}
