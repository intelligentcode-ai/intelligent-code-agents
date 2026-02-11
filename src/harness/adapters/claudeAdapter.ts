import { AgentCapabilities, RuntimeTarget } from "../types";
import { probeBinary } from "./common";
import { AgentAdapter, StageCommandContract } from "./types";

const manifest: AgentCapabilities = {
  auth_modes: ["device_code", "api_key"],
  supports_headless: true,
  requires_browser_callback_for_oauth: false,
  token_mount_supported: false,
  runtime_support: ["host", "docker"],
};

export class ClaudeAdapter implements AgentAdapter {
  readonly agent = "claude";
  readonly manifest = manifest;

  async probe(runtime: RuntimeTarget) {
    return probeBinary({
      agent: this.agent,
      binary: "claude",
      runtime,
      versionArgs: ["--version"],
      capability: manifest,
    });
  }

  buildStageCommand(args: { stage: "plan" | "execute" | "test"; model: string; prompt: string }): StageCommandContract {
    return {
      candidates: [
        {
          command: "claude",
          argv: ["-p", args.prompt, "--model", args.model],
        },
        {
          command: "claude",
          argv: ["--print", args.prompt, "--model", args.model],
        },
        {
          command: "claude",
          argv: ["--model", args.model],
          stdin: args.prompt,
        },
      ],
    };
  }
}
