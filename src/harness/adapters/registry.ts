import { DiscoveryResult, RuntimeTarget } from "../types";
import { AgentAdapter } from "./types";
import { CodexAdapter } from "./codexAdapter";
import { ClaudeAdapter } from "./claudeAdapter";
import { GeminiAdapter } from "./geminiAdapter";
import { CursorAdapter } from "./cursorAdapter";
import { AntigravityAdapter } from "./antigravityAdapter";

export class AgentRegistry {
  private readonly adapters: AgentAdapter[];

  constructor() {
    this.adapters = [
      new CodexAdapter(),
      new ClaudeAdapter(),
      new GeminiAdapter(),
      new CursorAdapter(),
      new AntigravityAdapter(),
    ];
  }

  getAdapter(agent: string): AgentAdapter | null {
    return this.adapters.find((item) => item.agent === agent) || null;
  }

  async discover(runtime: RuntimeTarget): Promise<DiscoveryResult[]> {
    return Promise.all(this.adapters.map((adapter) => adapter.probe(runtime)));
  }

  list(): AgentAdapter[] {
    return [...this.adapters];
  }
}
