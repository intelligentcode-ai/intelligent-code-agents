import { AgentCapabilities, RuntimeTarget } from "../types";
import { probeBinary } from "./common";
import { AgentAdapter, StageCommandContract } from "./types";

const manifest: AgentCapabilities = {
  auth_modes: ["api_key"],
  supports_headless: true,
  requires_browser_callback_for_oauth: false,
  token_mount_supported: false,
  runtime_support: ["host"],
};

export class AntigravityAdapter implements AgentAdapter {
  readonly agent = "antigravity";
  readonly manifest = manifest;

  async probe(runtime: RuntimeTarget) {
    return probeBinary({
      agent: this.agent,
      binary: "antigravity",
      runtime,
      versionArgs: ["--version"],
      capability: manifest,
    });
  }

  buildStageCommand(args: { stage: "plan" | "execute" | "test"; model: string; prompt: string }): StageCommandContract {
    return {
      candidates: [
        {
          command: "antigravity",
          argv: ["run", "--model", args.model, "--stage", args.stage],
          stdin: args.prompt,
        },
        {
          command: "antigravity",
          argv: ["--model", args.model],
          stdin: args.prompt,
        },
      ],
    };
  }
}
