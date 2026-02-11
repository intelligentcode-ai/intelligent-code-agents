import path from "node:path";
import { OAuthBroker } from "../auth/broker";
import { NativeAuthManager } from "../auth/native";
import { HarnessStore } from "../db/store";
import { StageRunner } from "../runtime/executor";
import { syncQueueItem } from "../queue/projection";
import { AgentRegistry } from "../adapters/registry";
import { Complexity, HarnessConfig, RuntimeAuthMount, RuntimeTarget, Stage, WorkItem } from "../types";
import { buildGuardedStagePrompt, evaluatePromptInjection } from "../security/prompt-guard";

function resolveComplexity(item: WorkItem): Complexity {
  const score = item.priority + Math.ceil(item.body_md.length / 1000);
  if (item.kind === "finding" || score <= 3) {
    return "simple";
  }
  if (score <= 8) {
    return "medium";
  }
  return "complex";
}

function buildPrompt(item: WorkItem, stage: Stage): string {
  const stageDirective: Record<Stage, string> = {
    plan: "Produce a concise actionable plan with acceptance criteria.",
    execute: "Implement the plan and summarize changes.",
    test: "Run verification and list findings. Include [[finding]] marker for blocking issues.",
  };

  const base = buildGuardedStagePrompt({
    workItemId: item.id,
    kind: item.kind,
    title: item.title,
    body: item.body_md || item.body_html || "(empty)",
    stage,
  });

  return `${base}\n\nSTAGE_DIRECTIVE:\n${stageDirective[stage]}`;
}

function mapAuthProvider(agent: string): "gemini" | "codex" | "claude" | null {
  if (agent === "gemini" || agent === "codex" || agent === "claude") {
    return agent;
  }
  return null;
}

function hasProviderEnvCredential(provider: "gemini" | "codex" | "claude"): boolean {
  if (provider === "codex") {
    return Boolean(process.env.OPENAI_API_KEY);
  }
  if (provider === "claude") {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  }
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

function authEnvForProvider(provider: "gemini" | "codex" | "claude", token: string): Record<string, string> {
  if (provider === "codex") {
    return { OPENAI_API_KEY: token };
  }
  if (provider === "claude") {
    return { ANTHROPIC_API_KEY: token };
  }
  return {
    GEMINI_API_KEY: token,
    GOOGLE_API_KEY: token,
  };
}

export class DispatcherLoop {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly store: HarnessStore,
    private readonly runner: StageRunner,
    private readonly registry: AgentRegistry,
    private readonly broker: OAuthBroker,
    private readonly nativeAuth: NativeAuthManager,
    private readonly config: HarnessConfig,
  ) {}

  start(): { running: boolean; pollMs: number } {
    if (this.timer) {
      return { running: true, pollMs: this.config.dispatcherPollMs };
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.dispatcherPollMs);
    return { running: true, pollMs: this.config.dispatcherPollMs };
  }

  stop(): { running: boolean } {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return { running: false };
  }

  status(): { running: boolean; inFlight: boolean; pollMs: number } {
    return {
      running: Boolean(this.timer),
      inFlight: this.inFlight,
      pollMs: this.config.dispatcherPollMs,
    };
  }

  async runOnce(): Promise<{ claimed: number | null }> {
    const item = this.store.claimNextWorkItem();
    if (!item) {
      return { claimed: null };
    }
    await this.process(item);
    return { claimed: item.id };
  }

  async runSpecific(workItemId: number): Promise<{ claimed: number | null }> {
    if (this.inFlight) {
      return { claimed: null };
    }

    const item = this.store.getWorkItem(workItemId);
    if (!item) {
      return { claimed: null };
    }

    this.inFlight = true;
    try {
      await this.process(item);
      return { claimed: item.id };
    } finally {
      this.inFlight = false;
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.store.addEvent("dispatcher_tick_failed", "dispatcher", 0, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight = false;
    }
  }

  private validateAuth(item: WorkItem, stage: Stage, profile: { runtime: string; auth_mode: string; agent: string }): string | null {
    const provider = mapAuthProvider(profile.agent);
    if (!provider) {
      return null;
    }

    if (profile.auth_mode === "api_key") {
      if (this.broker.hasStoredToken(provider) || hasProviderEnvCredential(provider)) {
        return null;
      }
      const native = this.nativeAuth.resolveRuntime(provider, profile.runtime as RuntimeTarget);
      if (native.ok) {
        this.store.addEvent("auth_fallback_native", "work_item", item.id, {
          provider,
          stage,
          runtime: profile.runtime,
        });
        return null;
      }
      return `No API key configured for ${provider}, and native auth is unavailable. Add a provider credential in Harness > Authentication.`;
    }

    if (profile.auth_mode !== "oauth_callback") {
      if (profile.auth_mode === "device_code") {
        const resolved = this.nativeAuth.resolveRuntime(provider, profile.runtime as RuntimeTarget);
        if (!resolved.ok) {
          return resolved.message || `${provider} native auth is not available.`;
        }
      }
      return null;
    }

    const adapter = this.registry.getAdapter(profile.agent);
    if (!adapter) {
      return `No adapter found for ${profile.agent}.`;
    }

    if (!adapter.manifest.requires_browser_callback_for_oauth) {
      return null;
    }

    if (!this.broker.hasStoredToken(provider)) {
      return `OAuth token for ${provider} is missing. Start a broker session from dashboard before running ${stage}.`;
    }

    this.store.addEvent("oauth_token_validated", "work_item", item.id, {
      stage,
      agent: profile.agent,
      runtime: profile.runtime,
    });
    return null;
  }

  private async process(item: WorkItem): Promise<void> {
    let current = item;

    const injection = evaluatePromptInjection(
      `${current.title}\n${current.body_md}\n${current.body_html}`,
      this.config.promptInjectionMode,
    );
    if (injection.findings.length > 0) {
      this.store.addEvent("prompt_injection_detected", "work_item", current.id, {
        mode: this.config.promptInjectionMode,
        findings: injection.findings,
      });
    }
    if (injection.blocked) {
      current = this.store.updateWorkItem(current.id, { status: "blocked" });
      syncQueueItem(current);
      return;
    }

    if (current.status !== "planned") {
      current = this.store.updateWorkItem(current.id, { status: "planned" });
      syncQueueItem(current);
    }

    const complexity = resolveComplexity(current);
    const stages: Stage[] = ["plan", "execute", "test"];

    for (const stage of stages) {
      const profile = this.store.getExecutionProfile(complexity, stage);
      if (!profile) {
        current = this.store.updateWorkItem(current.id, { status: "needs_input" });
        syncQueueItem(current);
        this.store.addEvent("profile_missing", "work_item", current.id, { complexity, stage });
        return;
      }

      if (stage === "execute") {
        current = this.store.updateWorkItem(current.id, { status: "executing" });
        syncQueueItem(current);
      }
      if (stage === "test") {
        current = this.store.updateWorkItem(current.id, { status: "verifying" });
        syncQueueItem(current);
      }

      const authError = this.validateAuth(current, stage, profile);
      if (authError) {
        current = this.store.updateWorkItem(current.id, { status: "needs_input" });
        syncQueueItem(current);
        this.store.addEvent("auth_validation_failed", "work_item", current.id, {
          stage,
          message: authError,
        });
        return;
      }

      const runLogPath = path.join(this.config.logsPath, `${current.id}-${stage}-${Date.now()}.log`);
      const artifactDir = path.join(this.config.artifactsPath, String(current.id), stage, String(Date.now()));

      const run = this.store.createRun({
        workItemId: current.id,
        stage,
        profileId: profile.id,
        logPath: runLogPath,
        artifactDir,
      });

      const prompt = buildPrompt(current, stage);
      const provider = mapAuthProvider(profile.agent);
      let authEnv: Record<string, string> | undefined;
      let authMounts: RuntimeAuthMount[] | undefined;

      if (provider && profile.auth_mode === "device_code") {
        const resolved = this.nativeAuth.resolveRuntime(provider, profile.runtime as RuntimeTarget);
        authMounts = resolved.mounts;
      } else if (provider && profile.auth_mode === "api_key") {
        const token = this.broker.getAccessToken(provider);
        if (token) {
          authEnv = authEnvForProvider(provider, token);
        } else {
          const native = this.nativeAuth.resolveRuntime(provider, profile.runtime as RuntimeTarget);
          authMounts = native.mounts;
        }
      } else if (provider) {
        const token = this.broker.getAccessToken(provider);
        authEnv = token ? authEnvForProvider(provider, token) : undefined;
      }

      const stageResult = await this.runner.runStage({
        workItem: current,
        stage,
        profile,
        runId: run.id,
        prompt,
        authEnv,
        authMounts,
        logPath: runLogPath,
        artifactDir,
      });

      this.store.completeRun(run.id, {
        status: stageResult.status,
        exitCode: stageResult.exitCode,
        errorText: stageResult.errorText,
      });

      if (stage === "test" && stageResult.status !== "passed") {
        const child = this.store.createWorkItem({
          kind: "finding",
          title: `Follow-up finding for #${current.id}`,
          bodyMd: stageResult.errorText || "Blocking finding generated during verification.",
          parentId: current.id,
          priority: Math.max(1, current.priority - 1),
          status: "new",
          projectPath: current.project_path,
          acceptanceCriteria: ["Root cause fixed", "Tests pass", "No blocking findings"],
        });

        this.store.linkWorkItems(current.id, child.id, "spawned_from");
        this.store.addFinding({
          workItemId: current.id,
          runId: run.id,
          severity: "high",
          title: `Blocking finding from verification run ${run.id}`,
          detailsMd: stageResult.errorText || "Verification stage failed.",
          blocking: true,
          childWorkItemId: child.id,
        });

        current = this.store.updateWorkItem(current.id, { status: "blocked" });
        syncQueueItem(child);
        syncQueueItem(current);
        return;
      }

      if (stageResult.status !== "passed") {
        current = this.store.updateWorkItem(current.id, {
          status: stageResult.status === "needs_input" ? "needs_input" : "failed",
        });
        syncQueueItem(current);
        return;
      }
    }

    this.store.resolveFindingsForWorkItem(current.id);
    this.store.resolveFindingsByChildWorkItem(current.id);
    current = this.store.updateWorkItem(current.id, { status: "completed" });
    syncQueueItem(current);
    await this.tryUnblockParents(current.parent_id);
  }

  private async tryUnblockParents(parentId: number | null): Promise<void> {
    let cursor = parentId;

    while (cursor) {
      const parent = this.store.getWorkItem(cursor);
      if (!parent) {
        return;
      }

      if (!this.store.hasOpenBlockingFindings(parent.id) && parent.status !== "completed") {
        const next = this.store.updateWorkItem(parent.id, { status: "planned" });
        syncQueueItem(next);
      }

      cursor = parent.parent_id;
    }
  }
}
