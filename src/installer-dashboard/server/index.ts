import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import Fastify, { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { executeOperation } from "../../installer-core/executor";
import { loadCatalogFromSources } from "../../installer-core/catalog";
import { syncSource } from "../../installer-core/sourceSync";
import { loadSources } from "../../installer-core/sources";
import { loadHookSources } from "../../installer-core/hookSources";
import { syncHookSource } from "../../installer-core/hookSync";
import { loadHookCatalogFromSources, HookInstallSelection } from "../../installer-core/hookCatalog";
import { executeHookOperation, HookInstallRequest, HookTargetPlatform } from "../../installer-core/hookExecutor";
import { loadHookInstallState } from "../../installer-core/hookState";
import { loadInstallState } from "../../installer-core/state";
import { discoverTargets, resolveTargetPaths } from "../../installer-core/targets";
import { SUPPORTED_TARGETS } from "../../installer-core/constants";
import { createInstallerApplicationService, InstallerApplicationService, withInstallerApplicationService } from "../../installer-core/applicationService";
import { findRepoRoot } from "../../installer-core/repo";
import { InstallRequest, InstallScope, InstallSelection, PublishMode, TargetPlatform, ValidationProfile } from "../../installer-core/types";
import {
  Capability,
  loadDashboardServerPlugins,
  mergeCapabilities,
  parseDashboardPluginConfig,
  parseEnabledDashboardPlugins,
} from "./plugins";
import { dashboardServerPluginRegistry } from "./pluginRegistry";

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

function isUnknownSourceError(value: unknown, sourceId: string): boolean {
  const message = value instanceof Error ? value.message : String(value);
  return message === `Unknown source '${sourceId}'.`;
}

const HELPER_HOST = "127.0.0.1";
const HELPER_PORT = Number(process.env.ICA_HELPER_PORT || "4174");
const HELPER_TOKEN = process.env.ICA_HELPER_TOKEN || crypto.randomBytes(24).toString("hex");
let helperProcess: ChildProcessWithoutNullStreams | null = null;

async function helperRequest(pathname: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`http://${HELPER_HOST}:${HELPER_PORT}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ica-helper-token": HELPER_TOKEN,
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "Helper request failed.");
  }
  return payload;
}

async function waitForHelperReady(retries = 30): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(`http://${HELPER_HOST}:${HELPER_PORT}/health`, {
        headers: {
          "x-ica-helper-token": HELPER_TOKEN,
        },
      });
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("ICA helper did not become ready in time.");
}

async function ensureHelperRunning(repoRoot: string): Promise<void> {
  if (helperProcess && !helperProcess.killed) {
    try {
      await waitForHelperReady(1);
      return;
    } catch {
      // respawn below
    }
  }

  const helperScript = path.join(repoRoot, "dist", "src", "installer-helper", "server.js");
  if (!fs.existsSync(helperScript)) {
    throw new Error("Native helper is not built. Run: npm run build");
  }

  helperProcess = spawn(process.execPath, [helperScript], {
    env: {
      ...process.env,
      ICA_HELPER_PORT: String(HELPER_PORT),
      ICA_HELPER_TOKEN: HELPER_TOKEN,
    },
    stdio: "pipe",
  });
  helperProcess.stderr.on("data", (chunk) => {
    const message = chunk.toString("utf8");
    process.stderr.write(`[ica-helper] ${message}`);
  });

  await waitForHelperReady();
}

export interface InstallerDashboardServerOptions {
  repoRoot?: string;
  applicationService?: Partial<InstallerApplicationService>;
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

export async function createInstallerDashboardServer(
  options: InstallerDashboardServerOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const repoRoot = options.repoRoot || findRepoRoot(__dirname);

  const webBuildPath = path.join(repoRoot, "dist", "installer-dashboard", "web-build");
  if (fs.existsSync(webBuildPath)) {
    await app.register(fastifyStatic, {
      root: webBuildPath,
      prefix: "/",
    });
  }

  const pluginRuntime = await loadDashboardServerPlugins({
    app,
    enabledPluginIds: parseEnabledDashboardPlugins(process.env.ICA_DASHBOARD_PLUGINS),
    registry: dashboardServerPluginRegistry,
    pluginConfigs: parseDashboardPluginConfig(process.env.ICA_DASHBOARD_PLUGIN_CONFIG),
  });
  const applicationService = withInstallerApplicationService(
    createInstallerApplicationService({
      repoRoot,
      installHooks: pluginRuntime.installHooks,
      dependencies: {
        pickProjectDirectory: async (initialPath) => {
          await ensureHelperRunning(repoRoot);
          const payload = await helperRequest("/pick-directory", {
            initialPath,
          });
          const selectedPath = typeof payload.path === "string" ? payload.path : "";
          if (!selectedPath) {
            throw new Error("Helper did not return a selected path.");
          }
          return selectedPath;
        },
      },
    }),
    options.applicationService,
  );

  app.get("/api/v1/health", async () => {
    return {
      ok: true,
      service: "ica-installer-dashboard",
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

  app.get("/api/v1/catalog/skills", async () => {
    const catalog = await loadCatalogFromSources(repoRoot, true);
    return {
      generatedAt: catalog.generatedAt,
      version: catalog.version,
      sources: catalog.sources,
      skills: catalog.skills,
    };
  });

  app.get("/api/v1/catalog/hooks", async () => {
    const catalog = await loadHookCatalogFromSources(repoRoot, true);
    return {
      generatedAt: catalog.generatedAt,
      version: catalog.version,
      sources: catalog.sources,
      hooks: catalog.hooks,
    };
  });

  app.get("/api/v1/targets/discovered", async () => {
    return {
      targets: discoverTargets(),
    };
  });

  app.get("/api/v1/installations", async (request) => {
    const query = request.query as { scope?: string; projectPath?: string; targets?: string };
    return applicationService.listInstallations({
      scope: parseScope(query.scope),
      projectPath: query.projectPath,
      targets: parseTargets(query.targets),
    });
  });

  app.get("/api/v1/hooks/installations", async (request) => {
    const query = request.query as { scope?: string; projectPath?: string; targets?: string };
    const targets = parseTargets(query.targets).filter((target): target is HookTargetPlatform => HOOK_CAPABLE_TARGETS.has(target as HookTargetPlatform));
    if (targets.length === 0) {
      return { installations: [] };
    }
    return applicationService.listHookInstallations({
      scope: parseScope(query.scope),
      projectPath: query.projectPath,
      targets,
    });
  });

  app.get("/api/v1/sources", async () => {
    return applicationService.listSources();
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

    const result = await applicationService.registerSource({
      id: typeof body.id === "string" ? body.id : undefined,
      name: typeof body.name === "string" ? body.name : undefined,
      repoUrl,
      transport: typeof body.transport === "string" && (body.transport === "https" || body.transport === "ssh") ? body.transport : undefined,
      skillsRoot: typeof body.skillsRoot === "string" ? body.skillsRoot : undefined,
      publishDefaultMode:
        typeof body.publishDefaultMode === "string" &&
        (body.publishDefaultMode === "direct-push" || body.publishDefaultMode === "branch-only" || body.publishDefaultMode === "branch-pr")
          ? body.publishDefaultMode
          : undefined,
      defaultBaseBranch: typeof body.defaultBaseBranch === "string" ? body.defaultBaseBranch : undefined,
      providerHint:
        typeof body.providerHint === "string" &&
        (body.providerHint === "github" || body.providerHint === "gitlab" || body.providerHint === "bitbucket" || body.providerHint === "unknown")
          ? body.providerHint
          : undefined,
      officialContributionEnabled: typeof body.officialContributionEnabled === "boolean" ? body.officialContributionEnabled : undefined,
      hooksRoot: typeof body.hooksRoot === "string" ? body.hooksRoot : undefined,
      enabled: body.enabled !== false,
      removable: body.removable !== false,
      official: body.official === true,
      token: typeof body.token === "string" ? body.token.trim() : "",
    });
    if (!result.auth.ok) {
      return reply.code(400).send({ error: result.auth.message, source: result.source });
    }

    return {
      source: result.source,
      sync: result.sync,
    };
  });

  app.patch("/api/v1/sources/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const body = (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;

    try {
      return await applicationService.updateSource({
        sourceId: params.id,
        name: typeof body.name === "string" ? body.name : undefined,
        repoUrl: typeof body.repoUrl === "string" ? body.repoUrl : undefined,
        transport: typeof body.transport === "string" && (body.transport === "https" || body.transport === "ssh") ? body.transport : undefined,
        skillsRoot: typeof body.skillsRoot === "string" ? body.skillsRoot : undefined,
        hooksRoot: typeof body.hooksRoot === "string" ? body.hooksRoot : undefined,
        publishDefaultMode:
          typeof body.publishDefaultMode === "string" &&
          (body.publishDefaultMode === "direct-push" || body.publishDefaultMode === "branch-only" || body.publishDefaultMode === "branch-pr")
            ? body.publishDefaultMode
            : undefined,
        defaultBaseBranch: typeof body.defaultBaseBranch === "string" ? body.defaultBaseBranch : undefined,
        providerHint:
          typeof body.providerHint === "string" &&
          (body.providerHint === "github" || body.providerHint === "gitlab" || body.providerHint === "bitbucket" || body.providerHint === "unknown")
            ? body.providerHint
            : undefined,
        officialContributionEnabled: typeof body.officialContributionEnabled === "boolean" ? body.officialContributionEnabled : undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        credentialRef: typeof body.credentialRef === "string" ? body.credentialRef : undefined,
        removable: typeof body.removable === "boolean" ? body.removable : undefined,
        official: typeof body.official === "boolean" ? body.official : undefined,
        token: typeof body.token === "string" ? body.token.trim() : "",
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/v1/sources/:id", async (request, reply) => {
    const params = request.params as { id: string };
    try {
      return await applicationService.removeSource(params.id);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/sources/:id/auth/check", async (request, reply) => {
    const params = request.params as { id: string };
    const body = (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    try {
      const auth = await applicationService.checkSourceAuth({
        sourceId: params.id,
        token: typeof body.token === "string" ? body.token.trim() : "",
      });
      if (!auth.ok) {
        return reply.code(400).send(auth);
      }
      return auth;
    } catch (error) {
      if (isUnknownSourceError(error, params.id)) {
        return reply.code(404).send({ error: `Unknown source '${params.id}'.` });
      }
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/sources/:id/refresh", async (request, reply) => {
    const params = request.params as { id: string };
    const result = await applicationService.refreshSources({ sourceId: params.id, onlyEnabled: false });
    if (!result.matched) {
      return reply.code(404).send({ error: `Unknown source '${params.id}'.` });
    }
    try {
      const refreshed: Array<{ type: "skills" | "hooks"; revision?: string; localPath?: string; error?: string }> = [];
      const item = result.refreshed[0];
      if (item?.skills) {
        refreshed.push({ type: "skills", ...item.skills });
      }
      if (item?.hooks) {
        refreshed.push({ type: "hooks", ...item.hooks });
      }
      return { sourceId: params.id, refreshed };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/sources/refresh-all", async () => {
    const result = await applicationService.refreshSources();
    return { refreshed: result.refreshed };
  });

  app.post("/api/v1/skills/validate", async (request, reply) => {
    const body = (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    const localPath = typeof body.path === "string" ? body.path.trim() : "";
    if (!localPath) {
      return reply.code(400).send({ error: "path is required." });
    }
    const profile = (typeof body.profile === "string" ? body.profile : "personal") as ValidationProfile;
    if (profile !== "personal" && profile !== "official") {
      return reply.code(400).send({ error: "profile must be 'personal' or 'official'." });
    }

    try {
      const validation = await applicationService.validateSkillBundle({
        localPath,
        skillName: typeof body.skillName === "string" ? body.skillName : undefined,
        profile,
      });
      return { validation };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/skills/publish", async (request, reply) => {
    const body = (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";
    const localPath = typeof body.path === "string" ? body.path.trim() : "";
    const overrideMode = typeof body.overrideMode === "string" ? body.overrideMode.trim() : "";
    const overrideBaseBranch = typeof body.overrideBaseBranch === "string" ? body.overrideBaseBranch.trim() : "";
    if (!sourceId) {
      return reply.code(400).send({ error: "sourceId is required." });
    }
    if (!localPath) {
      return reply.code(400).send({ error: "path is required." });
    }
    if (overrideMode && overrideMode !== "direct-push" && overrideMode !== "branch-only" && overrideMode !== "branch-pr") {
      return reply.code(400).send({ error: "overrideMode must be direct-push, branch-only, or branch-pr." });
    }
    try {
      // Official skills can only be published to official sources. The shared application service enforces that guard.
      const result = await applicationService.publishSkillBundle({
        sourceId,
        localPath,
        skillName: typeof body.skillName === "string" ? body.skillName : undefined,
        commitMessage: typeof body.message === "string" ? body.message : undefined,
        overrideMode: overrideMode ? (overrideMode as PublishMode) : undefined,
        overrideBaseBranch: overrideBaseBranch || undefined,
      });
      return { result };
    } catch (error) {
      if (isUnknownSourceError(error, sourceId)) {
        return reply.code(404).send({ error: `Unknown source '${sourceId}'.` });
      }
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/skills/contribute-official", async (request, reply) => {
    const body = (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    const localPath = typeof body.path === "string" ? body.path.trim() : "";
    if (!localPath) {
      return reply.code(400).send({ error: "path is required." });
    }
    try {
      const result = await applicationService.contributeOfficialSkillBundle({
        sourceId: typeof body.sourceId === "string" ? body.sourceId : undefined,
        localPath,
        skillName: typeof body.skillName === "string" ? body.skillName : undefined,
        commitMessage: typeof body.message === "string" ? body.message : undefined,
      });
      return { result };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/skills/pick", async (request, reply) => {
    const body = (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    try {
      await ensureHelperRunning(repoRoot);
      const payload = await helperRequest("/pick-directory", {
        initialPath: typeof body.initialPath === "string" ? body.initialPath : process.cwd(),
      });
      return payload;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/projects/pick", async (request, reply) => {
    const body = (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    try {
      return await applicationService.pickProjectDirectory(typeof body.initialPath === "string" ? body.initialPath : process.cwd());
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/container/mount-project", async (request, reply) => {
    const body = (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    try {
      await ensureHelperRunning(repoRoot);
      const payload = await helperRequest("/container/mount-project", {
        projectPath: typeof body.projectPath === "string" ? body.projectPath : "",
        containerName: typeof body.containerName === "string" ? body.containerName : undefined,
        image: typeof body.image === "string" ? body.image : undefined,
        port: typeof body.port === "string" ? body.port : undefined,
        confirm: body.confirm === true,
      });
      return payload;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!["POST", "PATCH", "DELETE"].includes(request.method) || !request.url.startsWith("/api/v1/")) {
      return;
    }

    const loopbackIps = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
    if (!loopbackIps.has(request.ip)) {
      return reply.code(403).send({ error: "Forbidden: dashboard API accepts local loopback requests only." });
    }

    if (request.method !== "DELETE") {
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

    return applicationService.executeInstallOperation(installRequest);
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

    return applicationService.executeUninstallOperation(uninstallRequest);
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

    return applicationService.executeSyncOperation(syncRequest);
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

    return executeHookOperation(repoRoot, installRequest);
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

    return executeHookOperation(repoRoot, uninstallRequest);
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

    return executeHookOperation(repoRoot, syncRequest);
  });

  app.setNotFoundHandler(async (_request, reply) => {
    if (!fs.existsSync(path.join(webBuildPath, "index.html"))) {
      return reply.type("text/plain").send("Dashboard web assets not built. Run: npm run build:dashboard:web");
    }
    return reply.type("text/html").send(fs.readFileSync(path.join(webBuildPath, "index.html"), "utf8"));
  });

  return app;
}

async function main(): Promise<void> {
  const app = await createInstallerDashboardServer();
  const host = process.env.ICA_DASHBOARD_HOST || "127.0.0.1";
  const port = Number(process.env.ICA_DASHBOARD_PORT || "4173");
  await app.listen({ host, port });
  process.stdout.write(`ICA dashboard listening at http://${host}:${port}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Dashboard startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
