import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Fastify, { FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import type { WebSocket as WsWebSocket } from "ws";
import { executeOperation } from "../../installer-core/executor";
import { loadCatalogFromSources } from "../../installer-core/catalog";
import { createCredentialProvider } from "../../installer-core/credentials";
import { checkSourceAuth } from "../../installer-core/sourceAuth";
import { syncSource } from "../../installer-core/sourceSync";
import { loadSources, removeSource, setSourceSyncStatus, updateSource } from "../../installer-core/sources";
import { loadHookSources, removeHookSource, updateHookSource } from "../../installer-core/hookSources";
import { syncHookSource } from "../../installer-core/hookSync";
import { loadHookCatalogFromSources, HookInstallSelection } from "../../installer-core/hookCatalog";
import { executeHookOperation, HookInstallRequest, HookTargetPlatform } from "../../installer-core/hookExecutor";
import { loadHookInstallState } from "../../installer-core/hookState";
import { registerRepository } from "../../installer-core/repositories";
import { redactSensitive, safeErrorMessage } from "../../installer-core/security";
import { loadInstallState } from "../../installer-core/state";
import { discoverTargets, resolveTargetPaths } from "../../installer-core/targets";
import { SUPPORTED_TARGETS } from "../../installer-core/constants";
import { findRepoRoot } from "../../installer-core/repo";
import { InstallRequest, InstallScope, InstallSelection, TargetPlatform } from "../../installer-core/types";
import { pickDirectoryNative } from "../../installer-helper/server";
import {
  Capability,
  loadDashboardServerPlugins,
  mergeCapabilities,
  parseDashboardPluginConfig,
  parseEnabledDashboardPlugins,
} from "../../installer-dashboard/server/plugins";
import { dashboardServerPluginRegistry } from "../../installer-dashboard/server/pluginRegistry";
import { createRealtimeHub } from "./realtime";
import { createWsTicketStore } from "./wsTickets";

interface InstallationSkillView {
  name: string;
  skillId?: string;
  sourceId?: string;
  installMode: string;
  effectiveMode: string;
  orphaned?: boolean;
}

interface InstallationHookView {
  name: string;
  hookId?: string;
  sourceId?: string;
  installMode: string;
  effectiveMode: string;
  orphaned?: boolean;
}

function capabilityRegistry(): Capability[] {
  return [
    { id: "skills-catalog", title: "Skill catalog browsing", enabled: true },
    { id: "hooks-catalog", title: "Hook catalog browsing", enabled: true },
    { id: "multi-source", title: "Multi-source repository management", enabled: true },
    { id: "target-selection", title: "Target platform selection", enabled: true },
    { id: "native-project-picker", title: "Native host project picker", enabled: true },
    { id: "install-mode", title: "Symlink/copy mode", enabled: true },
    { id: "installations", title: "Installed state inspection", enabled: true },
    { id: "operations", title: "Install/uninstall/sync operations", enabled: true },
  ];
}

const HOOK_CAPABLE_TARGETS = new Set<HookTargetPlatform>(["claude", "gemini"]);
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const WS_PROTOCOL_VERSION = "ica-ws-v1";

export function allowedUiOrigins(uiPort: number): Set<string> {
  return new Set([`http://127.0.0.1:${uiPort}`, `http://localhost:${uiPort}`, `http://[::1]:${uiPort}`]);
}

export function isAllowedUiOrigin(allowedOrigins: Set<string>, origin: string | undefined): boolean {
  return !origin || allowedOrigins.has(origin);
}

interface ApiFailurePayload {
  error: string;
  code: string;
  retryable: boolean;
}

interface InstallerApiDependencies {
  executeOperation: typeof executeOperation;
  executeHookOperation: typeof executeHookOperation;
  loadCatalogFromSources: typeof loadCatalogFromSources;
  loadHookCatalogFromSources: typeof loadHookCatalogFromSources;
  loadSources: typeof loadSources;
  loadHookSources: typeof loadHookSources;
  syncSource: typeof syncSource;
  syncHookSource: typeof syncHookSource;
}

export interface InstallerApiServerOptions {
  host?: string;
  port?: number;
  uiPort?: number;
  apiKey?: string;
  repoRoot?: string;
  wsTicketTtlMs?: number;
  wsHeartbeatMs?: number;
  dependencies?: Partial<InstallerApiDependencies>;
}

function parseScope(value?: string): InstallScope {
  return value === "project" ? "project" : "user";
}

function parseTargets(value?: string): TargetPlatform[] {
  if (!value) {
    return discoverTargets();
  }
  const parsed = value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item): item is TargetPlatform => SUPPORTED_TARGETS.includes(item as TargetPlatform));

  return Array.from(new Set(parsed));
}

function sanitizeError(value: unknown, fallback = "Operation failed."): string {
  return safeErrorMessage(value, fallback);
}

function resolveInstallerVersion(repoRoot: string): string {
  const versionFile = path.join(repoRoot, "VERSION");
  if (!fs.existsSync(versionFile)) {
    return "0.0.0";
  }
  try {
    const value = fs.readFileSync(versionFile, "utf8").trim();
    return value || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function apiFailure(error: unknown, fallback: string, code: string, retryable: boolean): ApiFailurePayload {
  return {
    error: sanitizeError(error, fallback),
    code,
    retryable,
  };
}

function isApiRoute(url: string): boolean {
  return url.startsWith("/api/v1/");
}

function toPublicSource(source: {
  id: string;
  name: string;
  repoUrl: string;
  transport: "https" | "ssh";
  official: boolean;
  enabled: boolean;
  skillsRoot?: string;
  hooksRoot?: string;
  credentialRef?: string;
  removable: boolean;
  lastSyncAt?: string;
  lastError?: string;
  revision?: string;
}): {
  id: string;
  name: string;
  repoUrl: string;
  transport: "https" | "ssh";
  official: boolean;
  enabled: boolean;
  skillsRoot?: string;
  hooksRoot?: string;
  credentialRef?: string;
  removable: boolean;
  lastSyncAt?: string;
  lastError?: string;
  revision?: string;
} {
  return {
    ...source,
    lastError: source.lastError ? redactSensitive(source.lastError) : undefined,
  };
}

function asInstallSelection(input: unknown): InstallSelection[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const parsed = input
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      sourceId: String(item.sourceId || ""),
      skillName: String(item.skillName || ""),
      skillId: String(item.skillId || `${String(item.sourceId || "")}/${String(item.skillName || "")}`),
    }))
    .filter((item) => item.sourceId && item.skillName);
  return parsed.length > 0 ? parsed : undefined;
}

function asHookInstallSelection(input: unknown): HookInstallSelection[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const parsed = input
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : null))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      sourceId: String(item.sourceId || ""),
      hookName: String(item.hookName || ""),
      hookId: String(item.hookId || `${String(item.sourceId || "")}/${String(item.hookName || "")}`),
    }))
    .filter((item) => item.sourceId && item.hookName);
  return parsed.length > 0 ? parsed : undefined;
}

function detectLegacyInstalledSkills(installPath: string, catalogSkillNames: Set<string>): InstallationSkillView[] {
  const skillsRoot = path.join(installPath, "skills");
  if (!fs.existsSync(skillsRoot)) {
    return [];
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const detected: InstallationSkillView[] = [];
  for (const entry of entries) {
    if (!catalogSkillNames.has(entry.name)) {
      continue;
    }

    const skillPath = path.join(skillsRoot, entry.name);
    let looksLikeSkill = false;
    try {
      const stat = fs.lstatSync(skillPath);
      if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(skillPath);
        looksLikeSkill = fs.existsSync(path.join(resolved, "SKILL.md"));
      } else if (stat.isDirectory()) {
        looksLikeSkill = fs.existsSync(path.join(skillPath, "SKILL.md"));
      }
    } catch {
      looksLikeSkill = false;
    }

    if (looksLikeSkill) {
      detected.push({
        name: entry.name,
        installMode: "unknown",
        effectiveMode: "unknown",
      });
    }
  }

  return detected.sort((a, b) => a.name.localeCompare(b.name));
}

function detectLegacyInstalledHooks(installPath: string, catalogHookNames: Set<string>): InstallationHookView[] {
  const hooksRoot = path.join(installPath, "hooks");
  if (!fs.existsSync(hooksRoot)) {
    return [];
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(hooksRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const detected: InstallationHookView[] = [];
  for (const entry of entries) {
    if (!catalogHookNames.has(entry.name)) {
      continue;
    }

    const hookPath = path.join(hooksRoot, entry.name);
    let looksLikeHook = false;
    try {
      const stat = fs.lstatSync(hookPath);
      if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(hookPath);
        looksLikeHook = fs.existsSync(path.join(resolved, "HOOK.md")) || fs.readdirSync(resolved, { withFileTypes: true }).length > 0;
      } else if (stat.isDirectory()) {
        looksLikeHook = fs.existsSync(path.join(hookPath, "HOOK.md")) || fs.readdirSync(hookPath, { withFileTypes: true }).length > 0;
      }
    } catch {
      looksLikeHook = false;
    }

    if (looksLikeHook) {
      detected.push({
        name: entry.name,
        installMode: "unknown",
        effectiveMode: "unknown",
      });
    }
  }

  return detected.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createInstallerApiServer(options: InstallerApiServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const repoRoot = options.repoRoot || findRepoRoot(__dirname);
  const installerVersion = resolveInstallerVersion(repoRoot);
  const host = options.host || process.env.ICA_API_HOST || "127.0.0.1";
  const port = options.port ?? Number(process.env.ICA_API_PORT || "4174");
  const uiPort = options.uiPort ?? Number(process.env.ICA_UI_PORT || "4173");
  const apiKey = options.apiKey || process.env.ICA_API_KEY || "";
  const wsTicketTtlMs = options.wsTicketTtlMs ?? Number(process.env.ICA_WS_TICKET_TTL_MS || "60000");
  const wsHeartbeatMs = options.wsHeartbeatMs ?? Number(process.env.ICA_WS_HEARTBEAT_MS || "15000");
  const deps: InstallerApiDependencies = {
    executeOperation,
    executeHookOperation,
    loadCatalogFromSources,
    loadHookCatalogFromSources,
    loadSources,
    loadHookSources,
    syncSource,
    syncHookSource,
    ...(options.dependencies || {}),
  };

  if (!apiKey) {
    throw new Error("ICA_API_KEY is required.");
  }
  if (!LOOPBACK_IPS.has(host)) {
    throw new Error(`ICA API host must be loopback. Received '${host}'.`);
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`ICA API port must be a valid TCP port. Received '${String(port)}'.`);
  }

  const allowedOrigins = allowedUiOrigins(uiPort);
  await app.register(fastifyCors, {
    origin(origin, callback) {
      if (isAllowedUiOrigin(allowedOrigins, origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("CORS origin not allowed."), false);
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-ICA-API-Key"],
    credentials: false,
  });
  await app.register(fastifyWebsocket);

  const wsTickets = createWsTicketStore({ ttlMs: wsTicketTtlMs });
  const realtime = createRealtimeHub({ heartbeatMs: wsHeartbeatMs });
  app.addHook("onClose", async () => {
    realtime.close();
  });

  const pluginRuntime = await loadDashboardServerPlugins({
    app,
    enabledPluginIds: parseEnabledDashboardPlugins(process.env.ICA_API_PLUGINS || process.env.ICA_DASHBOARD_PLUGINS),
    registry: dashboardServerPluginRegistry,
    pluginConfigs: parseDashboardPluginConfig(process.env.ICA_API_PLUGIN_CONFIG || process.env.ICA_DASHBOARD_PLUGIN_CONFIG),
  });

  app.setErrorHandler(async (error, request, reply) => {
    if (!isApiRoute(request.url)) {
      reply.send(error);
      return;
    }

    const statusCodeCandidate = (error as { statusCode?: unknown }).statusCode;
    const statusCode =
      typeof statusCodeCandidate === "number" && Number.isInteger(statusCodeCandidate) && statusCodeCandidate >= 400
        ? statusCodeCandidate
        : 500;
    const retryable = statusCode >= 500;
    const code = retryable ? "INTERNAL_SERVER_ERROR" : "API_REQUEST_FAILED";
    const payload = apiFailure(error, retryable ? "Request failed." : "Request rejected.", code, retryable);
    await reply.code(statusCode).send(payload);
  });

  app.post("/api/v1/ws/session", async () => {
    const created = wsTickets.createTicket(apiKey);
    const wsHost = host === "::1" ? "[::1]" : host === "::ffff:127.0.0.1" ? "127.0.0.1" : host;
    return {
      wsUrl: `ws://${wsHost}:${port}/ws/events?ticket=${encodeURIComponent(created.ticket)}`,
      ticket: created.ticket,
      expiresAt: created.expiresAt,
      protocolVersion: WS_PROTOCOL_VERSION,
    };
  });

  app.get("/ws/events", { websocket: true }, (connection, request) => {
    const socket: WsWebSocket = (connection as { socket?: WsWebSocket }).socket || (connection as unknown as WsWebSocket);
    if (!LOOPBACK_IPS.has(request.ip)) {
      socket.close(1008, "Forbidden");
      return;
    }
    const originHeader = request.headers.origin;
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
    if (!isAllowedUiOrigin(allowedOrigins, origin)) {
      socket.close(1008, "Forbidden origin");
      return;
    }

    const query = request.query as { ticket?: string };
    const ticket = typeof query.ticket === "string" ? query.ticket.trim() : "";
    if (!ticket) {
      socket.close(1008, "Missing ticket");
      return;
    }

    const consumed = wsTickets.consumeTicket(ticket, apiKey);
    if (!consumed.ok) {
      socket.close(1008, "Invalid ticket");
      return;
    }

    realtime.attach(socket);
  });

  app.get("/api/v1/health", async () => {
    return {
      ok: true,
      service: "ica-installer-api",
      version: installerVersion,
      timestamp: new Date().toISOString(),
    };
  });

  app.get("/api/v1/capabilities", async () => {
    return { capabilities: mergeCapabilities(capabilityRegistry(), pluginRuntime.capabilities) };
  });

  app.get("/api/v1/plugins", async () => {
    return {
      loadedPluginIds: pluginRuntime.loadedPluginIds,
      capabilities: pluginRuntime.capabilities,
    };
  });

  app.get("/api/v1/catalog/skills", async (_request, reply) => {
    try {
      const request = _request as { query?: { refresh?: string | boolean } };
      const refreshRaw = request.query?.refresh;
      const refresh = refreshRaw === true || refreshRaw === "true" || refreshRaw === "1";
      const catalog = await deps.loadCatalogFromSources(repoRoot, refresh);
      return {
        generatedAt: catalog.generatedAt,
        version: catalog.version,
        stale: catalog.stale,
        catalogSource: catalog.catalogSource,
        staleReason: catalog.staleReason,
        cacheAgeSeconds: catalog.cacheAgeSeconds,
        nextRefreshAt: catalog.nextRefreshAt,
        sources: catalog.sources.map((source) =>
          toPublicSource({
            id: source.id,
            name: source.name,
            repoUrl: source.repoUrl,
            transport: source.transport,
            official: source.official,
            enabled: source.enabled,
            skillsRoot: source.skillsRoot,
            credentialRef: source.credentialRef,
            removable: source.removable,
            lastSyncAt: source.lastSyncAt,
            lastError: source.lastError,
            revision: source.revision,
          }),
        ),
        skills: catalog.skills,
      };
    } catch (error) {
      return reply.code(503).send(apiFailure(error, "Failed to load skills catalog.", "CATALOG_SKILLS_UNAVAILABLE", true));
    }
  });

  app.get("/api/v1/catalog/hooks", async (_request, reply) => {
    try {
      const catalog = await deps.loadHookCatalogFromSources(repoRoot, false);
      return {
        generatedAt: catalog.generatedAt,
        version: catalog.version,
        sources: catalog.sources.map((source) =>
          toPublicSource({
            id: source.id,
            name: source.name,
            repoUrl: source.repoUrl,
            transport: source.transport,
            official: source.official,
            enabled: source.enabled,
            hooksRoot: source.hooksRoot,
            credentialRef: source.credentialRef,
            removable: source.removable,
            lastSyncAt: source.lastSyncAt,
            lastError: source.lastError,
            revision: source.revision,
          }),
        ),
        hooks: catalog.hooks,
      };
    } catch (error) {
      return reply.code(503).send(apiFailure(error, "Failed to load hooks catalog.", "CATALOG_HOOKS_UNAVAILABLE", true));
    }
  });

  app.get("/api/v1/targets/discovered", async () => {
    return {
      targets: discoverTargets(),
    };
  });

  app.get("/api/v1/installations", async (request) => {
    const query = request.query as { scope?: string; projectPath?: string; targets?: string };
    const scope = parseScope(query.scope);
    const projectPath = query.projectPath;
    const targets = parseTargets(query.targets);
    const resolved = resolveTargetPaths(targets, scope, projectPath);
    const catalog = await deps.loadCatalogFromSources(repoRoot, false);
    const catalogSkillNames = new Set(catalog.skills.map((skill) => skill.skillName));
    const activeSourceIds = new Set(catalog.sources.map((source) => source.id));

    const rows = await Promise.all(
      resolved.map(async (entry) => {
        const state = await loadInstallState(entry.installPath);
        const managedSkills: InstallationSkillView[] =
          state?.managedSkills.map((skill) => ({
            name: skill.name,
            skillId: skill.skillId,
            sourceId: skill.sourceId,
            installMode: skill.installMode,
            effectiveMode: skill.effectiveMode,
            orphaned: skill.orphaned || (skill.sourceId ? !activeSourceIds.has(skill.sourceId) : false),
          })) || [];
        const skillsByName = new Map(managedSkills.map((skill) => [skill.name, skill]));
        const detected = detectLegacyInstalledSkills(entry.installPath, catalogSkillNames);
        for (const skill of detected) {
          if (!skillsByName.has(skill.name)) {
            skillsByName.set(skill.name, skill);
          }
        }
        const combinedSkills = Array.from(skillsByName.values()).sort((a, b) => a.name.localeCompare(b.name));

        return {
          target: entry.target,
          installPath: entry.installPath,
          scope: entry.scope,
          projectPath: entry.projectPath,
          installed: Boolean(state) || combinedSkills.length > 0,
          managedSkills: combinedSkills,
          updatedAt: state?.updatedAt,
        };
      }),
    );

    return { installations: rows };
  });

  app.get("/api/v1/hooks/installations", async (request) => {
    const query = request.query as { scope?: string; projectPath?: string; targets?: string };
    const scope = parseScope(query.scope);
    const projectPath = query.projectPath;
    const targets = parseTargets(query.targets).filter((target): target is HookTargetPlatform => HOOK_CAPABLE_TARGETS.has(target as HookTargetPlatform));
    if (targets.length === 0) {
      return { installations: [] };
    }
    const resolved = resolveTargetPaths(targets, scope, projectPath);
    const catalog = await deps.loadHookCatalogFromSources(repoRoot, false);
    const catalogHookNames = new Set(catalog.hooks.map((hook) => hook.hookName));
    const activeSourceIds = new Set(catalog.sources.map((source) => source.id));

    const rows = await Promise.all(
      resolved.map(async (entry) => {
        const state = await loadHookInstallState(entry.installPath);
        const managedHooks: InstallationHookView[] =
          state?.managedHooks.map((hook) => ({
            name: hook.name,
            hookId: hook.hookId,
            sourceId: hook.sourceId,
            installMode: hook.installMode,
            effectiveMode: hook.effectiveMode,
            orphaned: hook.orphaned || (hook.sourceId ? !activeSourceIds.has(hook.sourceId) : false),
          })) || [];
        const hooksByName = new Map(managedHooks.map((hook) => [hook.name, hook]));
        const detected = detectLegacyInstalledHooks(entry.installPath, catalogHookNames);
        for (const hook of detected) {
          if (!hooksByName.has(hook.name)) {
            hooksByName.set(hook.name, hook);
          }
        }
        const combinedHooks = Array.from(hooksByName.values()).sort((a, b) => a.name.localeCompare(b.name));

        return {
          target: entry.target,
          installPath: entry.installPath,
          scope: entry.scope,
          projectPath: entry.projectPath,
          installed: Boolean(state) || combinedHooks.length > 0,
          managedHooks: combinedHooks,
          updatedAt: state?.updatedAt,
        };
      }),
    );

    return { installations: rows };
  });

  app.get("/api/v1/sources", async (_request, reply) => {
    try {
      const skillSources = await deps.loadSources();
      const hookSources = await deps.loadHookSources();
    const byId = new Map<
      string,
      {
        id: string;
        name: string;
        repoUrl: string;
        transport: "https" | "ssh";
        official: boolean;
        enabled: boolean;
        skillsRoot?: string;
        hooksRoot?: string;
        credentialRef?: string;
        removable: boolean;
        lastSyncAt?: string;
        lastError?: string;
        revision?: string;
      }
    >();

    for (const source of skillSources) {
      byId.set(source.id, {
        ...(byId.get(source.id) || {
          id: source.id,
          name: source.name,
          repoUrl: source.repoUrl,
          transport: source.transport,
          official: source.official,
          enabled: source.enabled,
          removable: source.removable,
        }),
        id: source.id,
        name: source.name,
        repoUrl: source.repoUrl,
        transport: source.transport,
        official: source.official,
        enabled: source.enabled,
        skillsRoot: source.skillsRoot,
        credentialRef: source.credentialRef,
        removable: source.removable,
        lastSyncAt: source.lastSyncAt || byId.get(source.id)?.lastSyncAt,
        lastError: source.lastError || byId.get(source.id)?.lastError,
        revision: source.revision || byId.get(source.id)?.revision,
      });
    }

    for (const source of hookSources) {
      byId.set(source.id, {
        ...(byId.get(source.id) || {
          id: source.id,
          name: source.name,
          repoUrl: source.repoUrl,
          transport: source.transport,
          official: source.official,
          enabled: source.enabled,
          removable: source.removable,
        }),
        id: source.id,
        name: source.name,
        repoUrl: source.repoUrl,
        transport: source.transport,
        official: source.official,
        enabled: (byId.get(source.id)?.enabled ?? false) || source.enabled,
        hooksRoot: source.hooksRoot,
        credentialRef: source.credentialRef || byId.get(source.id)?.credentialRef,
        removable: (byId.get(source.id)?.removable ?? true) && source.removable,
        lastSyncAt: byId.get(source.id)?.lastSyncAt || source.lastSyncAt,
        lastError: byId.get(source.id)?.lastError || source.lastError,
        revision: byId.get(source.id)?.revision || source.revision,
      });
    }

      return {
        sources: Array.from(byId.values())
          .map((source) => toPublicSource(source))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    } catch (error) {
      return reply.code(503).send(apiFailure(error, "Failed to load sources.", "SOURCES_UNAVAILABLE", true));
    }
  });

  app.post("/api/v1/sources", async (request, reply) => {
    const body = (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    const repoUrl = String(body.repoUrl || "").trim();
    if (!repoUrl) {
      return reply.code(400).send({ error: "repoUrl is required." });
    }

    const credentialProvider = createCredentialProvider();
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const registration = await registerRepository(
      {
        id: typeof body.id === "string" ? body.id : undefined,
        name: typeof body.name === "string" ? body.name : undefined,
        repoUrl,
        transport: typeof body.transport === "string" && (body.transport === "https" || body.transport === "ssh") ? body.transport : undefined,
        skillsRoot: typeof body.skillsRoot === "string" ? body.skillsRoot : undefined,
        hooksRoot: typeof body.hooksRoot === "string" ? body.hooksRoot : undefined,
        enabled: body.enabled !== false,
        removable: body.removable !== false,
        official: body.official === true,
        token,
      },
      credentialProvider,
    );
    const source = registration.skillSource;
    const auth = await checkSourceAuth(
      {
        id: source.id,
        repoUrl: source.repoUrl,
        transport: source.transport,
      },
      credentialProvider,
    );
    if (!auth.ok) {
      await setSourceSyncStatus(source.id, { lastError: auth.message });
      return reply.code(400).send({ error: auth.message, source });
    }

    return {
      source,
      sync: registration.sync,
    };
  });

  app.patch("/api/v1/sources/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const body = (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;

    try {
      const source = await updateSource(params.id, {
        name: typeof body.name === "string" ? body.name : undefined,
        repoUrl: typeof body.repoUrl === "string" ? body.repoUrl : undefined,
        transport: typeof body.transport === "string" && (body.transport === "https" || body.transport === "ssh") ? body.transport : undefined,
        skillsRoot: typeof body.skillsRoot === "string" ? body.skillsRoot : undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        credentialRef: typeof body.credentialRef === "string" ? body.credentialRef : undefined,
        removable: typeof body.removable === "boolean" ? body.removable : undefined,
        official: typeof body.official === "boolean" ? body.official : undefined,
      });
      try {
        await updateHookSource(params.id, {
          name: typeof body.name === "string" ? body.name : undefined,
          repoUrl: typeof body.repoUrl === "string" ? body.repoUrl : undefined,
          transport: typeof body.transport === "string" && (body.transport === "https" || body.transport === "ssh") ? body.transport : undefined,
          hooksRoot: typeof body.hooksRoot === "string" ? body.hooksRoot : undefined,
          enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
          credentialRef: typeof body.credentialRef === "string" ? body.credentialRef : undefined,
          removable: typeof body.removable === "boolean" ? body.removable : undefined,
          official: typeof body.official === "boolean" ? body.official : undefined,
        });
      } catch {
        // Older environments may still have only skill sources configured.
      }

      const credentialProvider = createCredentialProvider();
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (token) {
        await credentialProvider.store(params.id, token);
        await updateSource(params.id, { credentialRef: `${params.id}:stored` });
        await updateHookSource(params.id, { credentialRef: `${params.id}:stored` });
      }

      return { source };
    } catch (error) {
      return reply.code(400).send({ error: sanitizeError(error) });
    }
  });

  app.delete("/api/v1/sources/:id", async (request, reply) => {
    const params = request.params as { id: string };
    try {
      let removed: Awaited<ReturnType<typeof removeSource>> | null = null;
      try {
        removed = await removeSource(params.id);
      } catch {
        // allow hook-only entries
      }
      try {
        await removeHookSource(params.id);
      } catch {
        // hooks mirror may not exist; ignore.
      }
      const credentialProvider = createCredentialProvider();
      await credentialProvider.delete(params.id);
      return { source: removed || { id: params.id } };
    } catch (error) {
      return reply.code(400).send({ error: sanitizeError(error) });
    }
  });

  app.post("/api/v1/sources/:id/auth/check", async (request, reply) => {
    const params = request.params as { id: string };
    const body = (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    const source = (await deps.loadSources()).find((item) => item.id === params.id) || (await deps.loadHookSources()).find((item) => item.id === params.id);
    if (!source) {
      return reply.code(404).send({ error: `Unknown source '${params.id}'.` });
    }

    const credentialProvider = createCredentialProvider();
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (token) {
      await credentialProvider.store(source.id, token);
      await updateSource(source.id, { credentialRef: `${source.id}:stored` });
      try {
        await updateHookSource(source.id, { credentialRef: `${source.id}:stored` });
      } catch {
        // ignore missing hook mirror
      }
    }
    const auth = await checkSourceAuth(
      {
        id: source.id,
        repoUrl: source.repoUrl,
        transport: source.transport,
      },
      credentialProvider,
    );
    if (!auth.ok) {
      return reply.code(400).send(auth);
    }
    return auth;
  });

  app.post("/api/v1/sources/:id/refresh", async (request, reply) => {
    const params = request.params as { id: string };
    const skillSource = (await deps.loadSources()).find((item) => item.id === params.id);
    const hookSource = (await deps.loadHookSources()).find((item) => item.id === params.id);
    if (!skillSource && !hookSource) {
      return reply.code(404).send({ error: `Unknown source '${params.id}'.` });
    }
    const opId = `op_${crypto.randomUUID()}`;
    realtime.emit("source", "source.refresh.started", { sourceId: params.id }, opId);
    const credentialProvider = createCredentialProvider();
    try {
      const refreshed: Array<{ type: "skills" | "hooks"; revision?: string; localPath?: string; error?: string }> = [];
      if (skillSource) {
        try {
          const result = await deps.syncSource(skillSource, credentialProvider);
          refreshed.push({ type: "skills", revision: result.revision, localPath: result.localPath });
        } catch (error) {
          refreshed.push({ type: "skills", error: sanitizeError(error) });
        }
      }
      if (hookSource) {
        try {
          const result = await deps.syncHookSource(hookSource, credentialProvider);
          refreshed.push({ type: "hooks", revision: result.revision, localPath: result.localPath });
        } catch (error) {
          refreshed.push({ type: "hooks", error: sanitizeError(error) });
        }
      }
      realtime.emit("source", "source.refresh.completed", { sourceId: params.id, refreshed }, opId);
      return { sourceId: params.id, refreshed, operationId: opId };
    } catch (error) {
      realtime.emit("source", "source.refresh.failed", { sourceId: params.id, error: sanitizeError(error) }, opId);
      return reply.code(503).send(apiFailure(error, "Failed to refresh source.", "SOURCE_REFRESH_FAILED", true));
    }
  });

  app.post("/api/v1/sources/refresh-all", async (_request, reply) => {
    const opId = `op_${crypto.randomUUID()}`;
    realtime.emit("source", "source.refresh.started", { sourceId: "all" }, opId);
    try {
      const credentialProvider = createCredentialProvider();
      const skillSources = (await deps.loadSources()).filter((source) => source.enabled);
      const hookSources = (await deps.loadHookSources()).filter((source) => source.enabled);
      const byId = new Map<string, { skills?: typeof skillSources[number]; hooks?: typeof hookSources[number] }>();
      for (const source of skillSources) {
        byId.set(source.id, { ...(byId.get(source.id) || {}), skills: source });
      }
      for (const source of hookSources) {
        byId.set(source.id, { ...(byId.get(source.id) || {}), hooks: source });
      }

      const refreshed: Array<{
        sourceId: string;
        skills?: { revision?: string; localPath?: string; error?: string };
        hooks?: { revision?: string; localPath?: string; error?: string };
      }> = [];
      for (const [sourceId, entry] of byId.entries()) {
        const item: {
          sourceId: string;
          skills?: { revision?: string; localPath?: string; error?: string };
          hooks?: { revision?: string; localPath?: string; error?: string };
        } = { sourceId };

        if (entry.skills) {
          try {
            const result = await deps.syncSource(entry.skills, credentialProvider);
            item.skills = { revision: result.revision, localPath: result.localPath };
          } catch (error) {
            item.skills = { error: sanitizeError(error) };
          }
        }
        if (entry.hooks) {
          try {
            const result = await deps.syncHookSource(entry.hooks, credentialProvider);
            item.hooks = { revision: result.revision, localPath: result.localPath };
          } catch (error) {
            item.hooks = { error: sanitizeError(error) };
          }
        }
        refreshed.push(item);
      }
      realtime.emit("source", "source.refresh.completed", { sourceId: "all", refreshed }, opId);
      return { refreshed, operationId: opId };
    } catch (error) {
      realtime.emit("source", "source.refresh.failed", { sourceId: "all", error: sanitizeError(error) }, opId);
      return reply.code(503).send(apiFailure(error, "Failed to refresh sources.", "SOURCE_REFRESH_FAILED", true));
    }
  });

  app.post("/api/v1/projects/pick", async (request, reply) => {
    const body = (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    try {
      const selectedPath = await pickDirectoryNative(typeof body.initialPath === "string" ? body.initialPath : process.cwd());
      return { path: selectedPath };
    } catch (error) {
      return reply.code(400).send({ error: sanitizeError(error) });
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/v1/")) {
      return;
    }

    if (request.method === "OPTIONS") {
      return;
    }

    if (!LOOPBACK_IPS.has(request.ip)) {
      return reply.code(403).send({ error: "Forbidden: API accepts local loopback requests only." });
    }

    const providedToken = String(request.headers["x-ica-api-key"] || "");
    if (!providedToken || providedToken !== apiKey) {
      return reply.code(401).send({ error: "Unauthorized API key." });
    }

    if (["POST", "PATCH", "DELETE"].includes(request.method) && request.method !== "DELETE") {
      const contentType = String(request.headers["content-type"] || "");
      if (!contentType.toLowerCase().includes("application/json")) {
        return reply.code(415).send({ error: "Unsupported media type: expected application/json." });
      }
    }
  });

  function normalizeBody(body: unknown): Partial<InstallRequest> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {};
    }
    const typed = body as Partial<InstallRequest>;
    return {
      ...typed,
      skillSelections: asInstallSelection((typed as Record<string, unknown>).skillSelections),
    };
  }

  function normalizeHookBody(body: unknown): Partial<HookInstallRequest> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {};
    }
    const typed = body as Partial<HookInstallRequest>;
    return {
      ...typed,
      hookSelections: asHookInstallSelection((typed as Record<string, unknown>).hookSelections),
    };
  }

  function normalizeTargets(value: Partial<InstallRequest>["targets"]): TargetPlatform[] {
    if (!Array.isArray(value)) {
      return discoverTargets();
    }
    const filtered = value.filter((item): item is TargetPlatform =>
      typeof item === "string" && SUPPORTED_TARGETS.includes(item as TargetPlatform),
    );
    return Array.from(new Set(filtered));
  }

  function normalizeHookTargets(value: Partial<HookInstallRequest>["targets"]): HookTargetPlatform[] {
    const filtered = normalizeTargets(value as TargetPlatform[]).filter(
      (item): item is HookTargetPlatform => HOOK_CAPABLE_TARGETS.has(item as HookTargetPlatform),
    );
    return Array.from(new Set(filtered));
  }

  function withOperationId(result: unknown, operationId: string): Record<string, unknown> {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      return { ...(result as Record<string, unknown>), operationId };
    }
    return { result, operationId };
  }

  app.post("/api/v1/install/apply", async (request, reply) => {
    const body = normalizeBody(request.body);
    const targets = normalizeTargets(body.targets);
    if (targets.length === 0) {
      return reply.code(400).send({ error: "No valid targets selected." });
    }
    const installRequest: InstallRequest = {
      operation: "install",
      targets,
      scope: body.scope || "user",
      projectPath: body.projectPath,
      agentDirName: body.agentDirName,
      mode: body.mode || "symlink",
      skills: body.skills || [],
      skillSelections: body.skillSelections,
      removeUnselected: body.removeUnselected || false,
      installClaudeIntegration: body.installClaudeIntegration !== false,
      force: body.force || false,
      configFile: body.configFile,
      mcpConfigFile: body.mcpConfigFile,
      envFile: body.envFile,
    };
    const opId = `op_${crypto.randomUUID()}`;
    realtime.emit("operation", "operation.started", { operation: "install", targets }, opId);
    try {
      const result = await deps.executeOperation(repoRoot, installRequest, { hooks: pluginRuntime.installHooks });
      realtime.emit("operation", "operation.completed", { operation: "install", targets }, opId);
      return withOperationId(result, opId);
    } catch (error) {
      realtime.emit("operation", "operation.failed", { operation: "install", error: sanitizeError(error) }, opId);
      throw error;
    }
  });

  app.post("/api/v1/uninstall/apply", async (request, reply) => {
    const body = normalizeBody(request.body);
    const targets = normalizeTargets(body.targets);
    if (targets.length === 0) {
      return reply.code(400).send({ error: "No valid targets selected." });
    }
    const uninstallRequest: InstallRequest = {
      operation: "uninstall",
      targets,
      scope: body.scope || "user",
      projectPath: body.projectPath,
      agentDirName: body.agentDirName,
      mode: body.mode || "symlink",
      skills: body.skills || [],
      skillSelections: body.skillSelections,
      removeUnselected: false,
      installClaudeIntegration: body.installClaudeIntegration !== false,
      force: body.force || false,
      configFile: body.configFile,
      mcpConfigFile: body.mcpConfigFile,
      envFile: body.envFile,
    };
    const opId = `op_${crypto.randomUUID()}`;
    realtime.emit("operation", "operation.started", { operation: "uninstall", targets }, opId);
    try {
      const result = await deps.executeOperation(repoRoot, uninstallRequest, { hooks: pluginRuntime.installHooks });
      realtime.emit("operation", "operation.completed", { operation: "uninstall", targets }, opId);
      return withOperationId(result, opId);
    } catch (error) {
      realtime.emit("operation", "operation.failed", { operation: "uninstall", error: sanitizeError(error) }, opId);
      throw error;
    }
  });

  app.post("/api/v1/sync/apply", async (request, reply) => {
    const body = normalizeBody(request.body);
    const targets = normalizeTargets(body.targets);
    if (targets.length === 0) {
      return reply.code(400).send({ error: "No valid targets selected." });
    }
    const syncRequest: InstallRequest = {
      operation: "sync",
      targets,
      scope: body.scope || "user",
      projectPath: body.projectPath,
      agentDirName: body.agentDirName,
      mode: body.mode || "symlink",
      skills: body.skills || [],
      skillSelections: body.skillSelections,
      removeUnselected: true,
      installClaudeIntegration: body.installClaudeIntegration !== false,
      force: body.force || false,
      configFile: body.configFile,
      mcpConfigFile: body.mcpConfigFile,
      envFile: body.envFile,
    };
    const opId = `op_${crypto.randomUUID()}`;
    realtime.emit("operation", "operation.started", { operation: "sync", targets }, opId);
    try {
      const result = await deps.executeOperation(repoRoot, syncRequest, { hooks: pluginRuntime.installHooks });
      realtime.emit("operation", "operation.completed", { operation: "sync", targets }, opId);
      return withOperationId(result, opId);
    } catch (error) {
      realtime.emit("operation", "operation.failed", { operation: "sync", error: sanitizeError(error) }, opId);
      throw error;
    }
  });

  app.post("/api/v1/hooks/install/apply", async (request, reply) => {
    const body = normalizeHookBody(request.body);
    const targets = normalizeHookTargets(body.targets);
    if (targets.length === 0) {
      return reply.code(400).send({ error: "No hook-capable targets selected (supported: claude, gemini)." });
    }
    const installRequest: HookInstallRequest = {
      operation: "install",
      targets,
      scope: body.scope || "user",
      projectPath: body.projectPath,
      agentDirName: body.agentDirName,
      mode: body.mode || "symlink",
      hooks: body.hooks || [],
      hookSelections: body.hookSelections,
      removeUnselected: body.removeUnselected || false,
      force: body.force || false,
    };
    const opId = `op_${crypto.randomUUID()}`;
    realtime.emit("operation", "operation.started", { operation: "hooks.install", targets }, opId);
    try {
      const result = await deps.executeHookOperation(repoRoot, installRequest);
      realtime.emit("operation", "operation.completed", { operation: "hooks.install", targets }, opId);
      return withOperationId(result, opId);
    } catch (error) {
      realtime.emit("operation", "operation.failed", { operation: "hooks.install", error: sanitizeError(error) }, opId);
      throw error;
    }
  });

  app.post("/api/v1/hooks/uninstall/apply", async (request, reply) => {
    const body = normalizeHookBody(request.body);
    const targets = normalizeHookTargets(body.targets);
    if (targets.length === 0) {
      return reply.code(400).send({ error: "No hook-capable targets selected (supported: claude, gemini)." });
    }
    const uninstallRequest: HookInstallRequest = {
      operation: "uninstall",
      targets,
      scope: body.scope || "user",
      projectPath: body.projectPath,
      agentDirName: body.agentDirName,
      mode: body.mode || "symlink",
      hooks: body.hooks || [],
      hookSelections: body.hookSelections,
      removeUnselected: false,
      force: body.force || false,
    };
    const opId = `op_${crypto.randomUUID()}`;
    realtime.emit("operation", "operation.started", { operation: "hooks.uninstall", targets }, opId);
    try {
      const result = await deps.executeHookOperation(repoRoot, uninstallRequest);
      realtime.emit("operation", "operation.completed", { operation: "hooks.uninstall", targets }, opId);
      return withOperationId(result, opId);
    } catch (error) {
      realtime.emit("operation", "operation.failed", { operation: "hooks.uninstall", error: sanitizeError(error) }, opId);
      throw error;
    }
  });

  app.post("/api/v1/hooks/sync/apply", async (request, reply) => {
    const body = normalizeHookBody(request.body);
    const targets = normalizeHookTargets(body.targets);
    if (targets.length === 0) {
      return reply.code(400).send({ error: "No hook-capable targets selected (supported: claude, gemini)." });
    }
    const syncRequest: HookInstallRequest = {
      operation: "sync",
      targets,
      scope: body.scope || "user",
      projectPath: body.projectPath,
      agentDirName: body.agentDirName,
      mode: body.mode || "symlink",
      hooks: body.hooks || [],
      hookSelections: body.hookSelections,
      removeUnselected: true,
      force: body.force || false,
    };
    const opId = `op_${crypto.randomUUID()}`;
    realtime.emit("operation", "operation.started", { operation: "hooks.sync", targets }, opId);
    try {
      const result = await deps.executeHookOperation(repoRoot, syncRequest);
      realtime.emit("operation", "operation.completed", { operation: "hooks.sync", targets }, opId);
      return withOperationId(result, opId);
    } catch (error) {
      realtime.emit("operation", "operation.failed", { operation: "hooks.sync", error: sanitizeError(error) }, opId);
      throw error;
    }
  });
  return app;
}

async function main(): Promise<void> {
  const host = process.env.ICA_API_HOST || "127.0.0.1";
  const port = Number(process.env.ICA_API_PORT || "4174");
  const uiPort = Number(process.env.ICA_UI_PORT || "4173");
  const apiKey = process.env.ICA_API_KEY || "";
  const wsTicketTtlMs = Number(process.env.ICA_WS_TICKET_TTL_MS || "60000");
  const wsHeartbeatMs = Number(process.env.ICA_WS_HEARTBEAT_MS || "15000");

  const app = await createInstallerApiServer({
    host,
    port,
    uiPort,
    apiKey,
    wsTicketTtlMs,
    wsHeartbeatMs,
  });
  await app.listen({ host, port });
  process.stdout.write(`ICA API listening at http://${host}:${port}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`API startup failed: ${sanitizeError(error)}\n`);
    process.exitCode = 1;
  });
}
