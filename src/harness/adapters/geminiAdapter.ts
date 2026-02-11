import { AgentCapabilities, RuntimeTarget } from "../types";
import { probeBinary } from "./common";
import { AgentAdapter, StageCommandContract } from "./types";

const manifest: AgentCapabilities = {
  auth_modes: ["oauth_callback", "device_code", "api_key", "adc"],
  supports_headless: true,
  requires_browser_callback_for_oauth: true,
  token_mount_supported: true,
  runtime_support: ["host", "docker"],
};

export class GeminiAdapter implements AgentAdapter {
  readonly agent = "gemini";
  readonly manifest = manifest;

  async probe(runtime: RuntimeTarget) {
    return probeBinary({
      agent: this.agent,
      binary: "gemini",
      runtime,
      versionArgs: ["--version"],
      capability: manifest,
    });
  }

  buildStageCommand(args: { stage: "plan" | "execute" | "test"; model: string; prompt: string }): StageCommandContract {
    return {
      candidates: [
        {
          command: "gemini",
          argv: ["--model", args.model, "--prompt", args.prompt],
        },
        {
          command: "gemini",
          argv: ["-m", args.model],
          stdin: args.prompt,
        },
      ],
    };
  }
}
