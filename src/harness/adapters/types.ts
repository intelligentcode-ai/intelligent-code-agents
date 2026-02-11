import { AgentCapabilities, DiscoveryResult, RuntimeTarget } from "../types";

export interface StageCommandCandidate {
  command: string;
  argv: string[];
  stdin?: string;
  env?: Record<string, string>;
}

export interface StageCommandContract {
  candidates: StageCommandCandidate[];
}

export interface AgentAdapter {
  readonly agent: string;
  readonly manifest: AgentCapabilities;
  probe(runtime: RuntimeTarget): Promise<DiscoveryResult>;
  buildStageCommand(args: {
    stage: "plan" | "execute" | "test";
    model: string;
    prompt: string;
  }): StageCommandContract;
}
