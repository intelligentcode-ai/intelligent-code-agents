import fs from "node:fs";
import path from "node:path";
import { FastifyInstance } from "fastify";
import { AgentRegistry } from "../adapters/registry";
import { OAuthBroker } from "../auth/broker";
import { NativeAuthManager } from "../auth/native";
import { HarnessStore } from "../db/store";
import { DispatcherLoop } from "../dispatcher/loop";
import { HarnessConfig, RuntimeTarget, WorkItemInput, WorkItemPatch } from "../types";
import { evaluatePromptInjection } from "../security/prompt-guard";

function toNumber(value: string | number | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  return Number(value || "0");
}

function providerForAgent(agent: string): "gemini" | "codex" | "claude" | null {
  if (agent === "gemini" || agent === "codex" || agent === "claude") {
    return agent;
  }
  return null;
}

function parseProvider(value: string | undefined): "gemini" | "codex" | "claude" | null {
  if (value === "gemini" || value === "codex" || value === "claude") {
    return value;
  }
  return null;
}

export interface HarnessDependencies {
  config: HarnessConfig;
  store: HarnessStore;
  dispatcher: DispatcherLoop;
  registry: AgentRegistry;
  broker: OAuthBroker;
  nativeAuth: NativeAuthManager;
}

export async function registerHarnessRoutes(app: FastifyInstance, deps: HarnessDependencies): Promise<void> {
  app.get("/api/v1/harness/health", async () => {
    return {
      ok: true,
      service: "ica-harness",
      dispatcher: deps.dispatcher.status(),
      timestamp: new Date().toISOString(),
    };
  });

  app.get("/api/v1/harness/work-items", async (request) => {
    const query = request.query as { status?: string; kind?: string; limit?: string };
    const rows = deps.store.listWorkItems({
      status: query.status as any,
      kind: query.kind,
      limit: query.limit ? Number(query.limit) : 200,
    });
    return { workItems: rows };
  });

  app.post("/api/v1/harness/work-items", async (request, reply) => {
    const body = (request.body || {}) as WorkItemInput;
    if (!body.kind || !body.title) {
      return reply.code(400).send({ error: "kind and title are required." });
    }

    const injection = evaluatePromptInjection(
      `${body.title}\n${body.bodyMd || ""}\n${body.bodyHtml || ""}`,
      deps.config.promptInjectionMode,
    );
    if (injection.findings.length > 0) {
      deps.store.addEvent("prompt_injection_detected", "intake", 0, {
        mode: deps.config.promptInjectionMode,
        findings: injection.findings,
      });
    }
    if (injection.blocked) {
      return reply.code(400).send({
        error: "Prompt-injection patterns detected in work-item content. Please remove instruction-override text.",
        findings: injection.findings,
      });
    }

    const created = deps.store.createWorkItem(body);
    return { workItem: created };
  });

  app.get("/api/v1/harness/work-items/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const id = toNumber(params.id);
    const details = deps.store.getWorkItemDetails(id);
    if (!details.workItem) {
      return reply.code(404).send({ error: "Work item not found." });
    }
    return details;
  });

  app.patch("/api/v1/harness/work-items/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const body = (request.body || {}) as WorkItemPatch;
    const id = toNumber(params.id);

    const candidateText = `${body.title || ""}\n${body.bodyMd || ""}\n${body.bodyHtml || ""}`;
    if (candidateText.trim()) {
      const injection = evaluatePromptInjection(candidateText, deps.config.promptInjectionMode);
      if (injection.findings.length > 0) {
        deps.store.addEvent("prompt_injection_detected", "work_item_patch", id, {
          mode: deps.config.promptInjectionMode,
          findings: injection.findings,
        });
      }
      if (injection.blocked) {
        return reply.code(400).send({
          error: "Prompt-injection patterns detected in patch payload.",
          findings: injection.findings,
        });
      }
    }

    try {
      const updated = deps.store.updateWorkItem(id, body);
      return { workItem: updated };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/harness/work-items/:id/attachments", async (request, reply) => {
    const params = request.params as { id: string };
    const requestAny = request as any;

    try {
      if (typeof requestAny.isMultipart === "function" && requestAny.isMultipart()) {
        const part = await requestAny.file();
        if (!part) {
          return reply.code(400).send({ error: "Missing file part in multipart upload." });
        }
        const fileBuffer: Buffer = await part.toBuffer();
        const widthRaw = part.fields?.width?.value;
        const heightRaw = part.fields?.height?.value;
        const width = widthRaw === undefined ? Number.NaN : Number(widthRaw);
        const height = heightRaw === undefined ? Number.NaN : Number(heightRaw);

        const attachment = deps.store.addAttachment({
          workItemId: toNumber(params.id),
          filename: part.filename || "upload.bin",
          mimeType: part.mimetype || "application/octet-stream",
          dataBase64: fileBuffer.toString("base64"),
          width: Number.isFinite(width) ? width : undefined,
          height: Number.isFinite(height) ? height : undefined,
        });
        return { attachment };
      }

      const body = (request.body || {}) as {
        filename?: string;
        mimeType?: string;
        dataBase64?: string;
        width?: number;
        height?: number;
      };

      if (!body.filename || !body.mimeType || !body.dataBase64) {
        return reply.code(400).send({ error: "For JSON uploads: filename, mimeType, and dataBase64 are required." });
      }

      const attachment = deps.store.addAttachment({
        workItemId: toNumber(params.id),
        filename: body.filename,
        mimeType: body.mimeType,
        dataBase64: body.dataBase64,
        width: body.width,
        height: body.height,
      });
      return { attachment };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/harness/work-items/:id/dispatch", async (request, reply) => {
    const params = request.params as { id: string };
    const id = toNumber(params.id);
    const item = deps.store.getWorkItem(id);
    if (!item) {
      return reply.code(404).send({ error: "Work item not found." });
    }
    const updated = deps.store.updateWorkItem(id, { status: "planned" });
    await deps.dispatcher.runSpecific(id);
    return { workItem: updated };
  });

  app.get("/api/v1/harness/runs", async (request) => {
    const query = request.query as { limit?: string };
    return { runs: deps.store.listRuns(query.limit ? Number(query.limit) : 200) };
  });

  app.get("/api/v1/harness/runs/:id/log", async (request, reply) => {
    const params = request.params as { id: string };
    const run = deps.store.getRun(toNumber(params.id));
    if (!run) {
      return reply.code(404).send({ error: "Run not found." });
    }

    if (!fs.existsSync(run.log_path)) {
      return reply.code(404).send({ error: "Run log file missing." });
    }

    return {
      run,
      log: fs.readFileSync(run.log_path, "utf8"),
    };
  });

  app.get("/api/v1/harness/profiles", async () => {
    return deps.store.listProfiles();
  });

  app.put("/api/v1/harness/profiles", async (request, reply) => {
    const body = (request.body || {}) as {
      executionProfiles?: Array<{
        name: string;
        complexity: "simple" | "medium" | "complex";
        stage: "plan" | "execute" | "test";
        runtime: "host" | "docker";
        agent: string;
        model: string;
        auth_mode: "api_key" | "oauth_callback" | "device_code" | "adc";
        mcp_profile_id?: number | null;
        skill_profile_id?: number | null;
        timeout_s: number;
        retries: number;
        enabled?: number;
      }>;
      mcpProfiles?: Array<{ name: string; config_json: string }>;
      skillProfiles?: Array<{ name: string; skills_json: string }>;
    };

    for (const profile of body.executionProfiles || []) {
      const adapter = deps.registry.getAdapter(profile.agent);
      if (!adapter) {
        return reply.code(400).send({ error: `Unknown agent adapter: ${profile.agent}` });
      }

      const runtimeAllowed = adapter.manifest.runtime_support.includes(profile.runtime);
      if (!runtimeAllowed) {
        return reply.code(400).send({
          error: `Agent ${profile.agent} does not support runtime ${profile.runtime}.`,
        });
      }

      if (
        profile.runtime === "docker" &&
        profile.auth_mode === "oauth_callback" &&
        adapter.manifest.requires_browser_callback_for_oauth
      ) {
        const provider = providerForAgent(profile.agent);
        if (!provider || !deps.broker.supportsCallback(provider)) {
          return reply.code(400).send({
            error: `Selected profile requires OAuth callback broker support, unavailable for agent ${profile.agent}.`,
          });
        }
      }

      if (profile.auth_mode === "device_code") {
        const provider = providerForAgent(profile.agent);
        if (!provider) {
          return reply.code(400).send({
            error: `No native auth provider mapping exists for agent ${profile.agent}.`,
          });
        }
        const native = deps.nativeAuth.resolveRuntime(provider, profile.runtime as RuntimeTarget);
        if (!native.ok) {
          return reply.code(400).send({
            error: native.message || `Native auth validation failed for ${profile.agent}.`,
          });
        }
      }
    }

    const normalized = {
      executionProfiles: (body.executionProfiles || []).map((profile) => ({
        ...profile,
        mcp_profile_id: profile.mcp_profile_id ?? null,
        skill_profile_id: profile.skill_profile_id ?? null,
      })),
      mcpProfiles: body.mcpProfiles || [],
      skillProfiles: body.skillProfiles || [],
    };

    const updated = deps.store.upsertProfiles(normalized);
    return updated;
  });

  app.post("/api/v1/harness/discovery/scan", async (request) => {
    const body = (request.body || {}) as { runtime?: "host" | "docker" | "all" };
    const runtime = body.runtime || "host";
    const runtimes: RuntimeTarget[] = runtime === "all" ? ["host", "docker"] : [runtime];

    const all = [];
    for (const rt of runtimes) {
      const results = await deps.registry.discover(rt);
      for (const row of results) {
        const persisted = deps.store.upsertAgentInstallation({
          agent: row.agent,
          location: row.location,
          version: row.version,
          runtime: rt as RuntimeTarget,
          status: row.status,
          capabilitiesJson: JSON.stringify(row.capabilities),
        });
        all.push({ ...row, id: persisted.id });
      }
    }

    return { agents: all };
  });

  app.get("/api/v1/harness/discovery/agents", async (request) => {
    const query = request.query as { readyOnly?: string };
    const rows = deps.store.listAgentInstallations().map((item) => ({
      ...item,
      capabilities: JSON.parse(item.capabilities_json),
    }));
    return {
      agents: query.readyOnly === "1" ? rows.filter((row) => row.status === "ready") : rows,
    };
  });

  app.post("/api/v1/harness/auth/sessions", async (request, reply) => {
    const body = (request.body || {}) as { provider?: "gemini" | "codex" | "claude"; runtimeTarget?: "host" | "docker" };
    if (!body.provider) {
      return reply.code(400).send({ error: "provider is required." });
    }

    try {
      const session = await deps.broker.startSession(body.provider, body.runtimeTarget || "docker");
      return { session };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/v1/harness/auth/providers", async () => {
    const providers: Array<"gemini" | "codex" | "claude"> = ["gemini", "codex", "claude"];
    const rows = providers.map((provider) => {
      const adapter = deps.registry.getAdapter(provider);
      const authModes = adapter?.manifest.auth_modes || [];
      const callbackConfig = deps.broker.callbackConfiguration(provider);
      const nativeState = deps.nativeAuth.nativeState(provider);
      return {
        provider,
        authModes,
        supportsApiKey: authModes.includes("api_key"),
        supportsCallbackOAuth: deps.broker.supportsCallback(provider),
        supportsNativeCli: authModes.includes("device_code"),
        requiresBrowserCallbackForOAuth: Boolean(adapter?.manifest.requires_browser_callback_for_oauth),
        hasCredential: deps.broker.hasStoredToken(provider),
        oauthConfigured: callbackConfig.configured,
        oauthIssues: callbackConfig.issues,
        nativeStatus: nativeState.status,
        nativeStatusMessage: nativeState.message,
        nativeStartCommand: nativeState.startCommand,
        nativeDocsUrl: nativeState.docsUrl || null,
        nativeDockerMountSupported: nativeState.supportsDockerMount,
      };
    });
    return { providers: rows };
  });

  app.post("/api/v1/harness/auth/providers/:provider/native/check", async (request, reply) => {
    const params = request.params as { provider?: string };
    const provider = parseProvider(params.provider);
    if (!provider) {
      return reply.code(400).send({ error: "Unknown provider." });
    }
    const state = await deps.nativeAuth.check(provider);
    return { provider, state };
  });

  app.post("/api/v1/harness/auth/providers/:provider/native/start", async (request, reply) => {
    const params = request.params as { provider?: string };
    const provider = parseProvider(params.provider);
    if (!provider) {
      return reply.code(400).send({ error: "Unknown provider." });
    }
    const session = deps.nativeAuth.start(provider);
    deps.store.addEvent("native_auth_started", "auth_provider", 0, {
      provider,
      sessionId: session.id,
      pid: session.pid,
    });
    return { session };
  });

  app.get("/api/v1/harness/auth/native/sessions/:id", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = toNumber(params.id);
    const session = deps.nativeAuth.getSession(id);
    if (!session) {
      return reply.code(404).send({ error: "Native auth session not found." });
    }
    return { session };
  });

  app.post("/api/v1/harness/auth/native/sessions/:id/stop", async (request, reply) => {
    const params = request.params as { id?: string };
    const id = toNumber(params.id);
    const session = deps.nativeAuth.stopSession(id);
    if (!session) {
      return reply.code(404).send({ error: "Native auth session not found." });
    }
    return { session };
  });

  app.put("/api/v1/harness/auth/providers/:provider/api-key", async (request, reply) => {
    const params = request.params as { provider?: string };
    const provider = parseProvider(params.provider);
    if (!provider) {
      return reply.code(400).send({ error: "Unknown provider." });
    }

    const adapter = deps.registry.getAdapter(provider);
    if (!adapter || !adapter.manifest.auth_modes.includes("api_key")) {
      return reply.code(400).send({ error: `Provider ${provider} does not support api_key mode.` });
    }

    const body = (request.body || {}) as { apiKey?: string };
    const apiKey = String(body.apiKey || "").trim();
    if (apiKey.length < 8) {
      return reply.code(400).send({ error: "apiKey is required and must be at least 8 characters." });
    }

    deps.broker.storeCredential(provider, apiKey);
    deps.store.addEvent("api_key_stored", "auth_provider", 0, { provider });
    return { ok: true, provider };
  });

  app.delete("/api/v1/harness/auth/providers/:provider/credential", async (request, reply) => {
    const params = request.params as { provider?: string };
    const provider = parseProvider(params.provider);
    if (!provider) {
      return reply.code(400).send({ error: "Unknown provider." });
    }
    deps.broker.clearCredential(provider);
    deps.store.addEvent("auth_credential_cleared", "auth_provider", 0, { provider });
    return { ok: true, provider };
  });

  app.get("/api/v1/harness/auth/callback/:provider", async (request, reply) => {
    const params = request.params as { provider: "gemini" | "codex" | "claude" };
    const query = request.query as { code?: string; state?: string; error?: string };
    const result = await deps.broker.handleCallback(params.provider, query);
    reply.type("text/html");
    return deps.broker.callbackHtml(params.provider, result);
  });

  app.post("/api/v1/harness/auth/grants", async (request, reply) => {
    const body = (request.body || {}) as { runId?: number; provider?: "gemini" | "codex" | "claude" };
    if (!body.runId || !body.provider) {
      return reply.code(400).send({ error: "runId and provider are required." });
    }

    try {
      return deps.broker.mintRuntimeGrant(body.runId, body.provider);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/harness/loop/start", async () => {
    return deps.dispatcher.start();
  });

  app.post("/api/v1/harness/loop/stop", async () => {
    return deps.dispatcher.stop();
  });

  app.get("/api/v1/harness/loop/status", async () => {
    return deps.dispatcher.status();
  });

  app.get("/api/v1/harness/events", async (request) => {
    const query = request.query as { limit?: string };
    return { events: deps.store.listEvents(query.limit ? Number(query.limit) : 200) };
  });

  app.get("/api/v1/harness/runs/:id/artifacts", async (request, reply) => {
    const params = request.params as { id: string };
    const run = deps.store.getRun(toNumber(params.id));
    if (!run) {
      return reply.code(404).send({ error: "Run not found." });
    }

    if (!fs.existsSync(run.artifact_dir)) {
      return { files: [] };
    }

    const files = fs.readdirSync(run.artifact_dir).map((name) => path.join(run.artifact_dir, name));
    return { files };
  });
}
