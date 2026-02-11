import { AgentCapabilities, RuntimeTarget } from "../types";
import { probeBinary } from "./common";
import { AgentAdapter, StageCommandContract } from "./types";

const manifest: AgentCapabilities = {
  auth_modes: ["device_code", "api_key"],
  supports_headless: true,
  requires_browser_callback_for_oauth: false,
  token_mount_supported: true,
  runtime_support: ["host", "docker"],
};

export class CodexAdapter implements AgentAdapter {
  readonly agent = "codex";
  readonly manifest = manifest;

  async probe(runtime: RuntimeTarget) {
    return probeBinary({
      agent: this.agent,
      binary: "codex",
      runtime,
      versionArgs: ["--version"],
      capability: manifest,
    });
  }

  buildStageCommand(args: { stage: "plan" | "execute" | "test"; model: string; prompt: string }): StageCommandContract {
    return {
      candidates: [
        {
          command: "codex",
          argv: ["run", "--model", args.model, "--non-interactive", "--stage", args.stage],
          stdin: args.prompt,
        },
        {
          command: "codex",
          argv: ["exec", "--model", args.model, "--stage", args.stage],
          stdin: args.prompt,
        },
        {
          command: "codex",
          argv: ["--model", args.model],
          stdin: args.prompt,
        },
      ],
    };
  }
}
