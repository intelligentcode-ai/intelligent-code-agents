import { AgentCapabilities, RuntimeTarget } from "../types";
import { probeBinary } from "./common";
import { AgentAdapter, StageCommandContract } from "./types";

const manifest: AgentCapabilities = {
  auth_modes: ["api_key", "oauth_callback"],
  supports_headless: true,
  requires_browser_callback_for_oauth: false,
  token_mount_supported: true,
  runtime_support: ["host"],
};

export class CursorAdapter implements AgentAdapter {
  readonly agent = "cursor";
  readonly manifest = manifest;

  async probe(runtime: RuntimeTarget) {
    return probeBinary({
      agent: this.agent,
      binary: "cursor",
      runtime,
      versionArgs: ["--version"],
      capability: manifest,
    });
  }

  buildStageCommand(args: { stage: "plan" | "execute" | "test"; model: string; prompt: string }): StageCommandContract {
    return {
      candidates: [
        {
          command: "cursor",
          argv: ["agent", "run", "--model", args.model, "--stage", args.stage],
          stdin: args.prompt,
        },
        {
          command: "cursor",
          argv: ["--model", args.model],
          stdin: args.prompt,
        },
      ],
    };
  }
}
