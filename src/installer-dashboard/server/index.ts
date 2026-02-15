import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { executeOperation } from "../../installer-core/executor";
import { loadCatalogFromSources } from "../../installer-core/catalog";
import { createCredentialProvider } from "../../installer-core/credentials";
import { checkSourceAuth } from "../../installer-core/sourceAuth";
import { syncSource } from "../../installer-core/sourceSync";
import { contributeOfficialSkillBundle, publishSkillBundle, validateSkillBundle } from "../../installer-core/skillPublish";
import { loadSources, removeSource, setSourceSyncStatus, updateSource } from "../../installer-core/sources";
import { loadHookSources, removeHookSource, updateHookSource } from "../../installer-core/hookSources";
import { syncHookSource } from "../../installer-core/hookSync";
import { loadHookCatalogFromSources, HookInstallSelection } from "../../installer-core/hookCatalog";
import { executeHookOperation, HookInstallRequest, HookTargetPlatform } from "../../installer-core/hookExecutor";
import { loadHookInstallState } from "../../installer-core/hookState";
import { registerRepository } from "../../installer-core/repositories";
import { loadInstallState } from "../../installer-core/state";
import { discoverTargets, resolveTargetPaths } from "../../installer-core/targets";
import { SUPPORTED_TARGETS } from "../../installer-core/constants";
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

function normalizePathForMatch(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function looksLikeOfficialSkillPath(localPath: string): boolean {
  return normalizePathForMatch(localPath).includes("/official-skills/");
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

async function main(): Promise<void> {
  const app = Fastify({ logger: false });
  const repoRoot = findRepoRoot(__dirname);

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
    const scope = parseScope(query.scope);
    const projectPath = query.projectPath;
    const targets = parseTargets(query.targets);
    const resolved = resolveTargetPaths(targets, scope, projectPath);
    const catalog = await loadCatalogFromSources(repoRoot, false);
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
    const catalog = await loadHookCatalogFromSources(repoRoot, false);
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

  app.get("/api/v1/sources", async () => {
    const skillSources = await loadSources();
    const hookSources = await loadHookSources();
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
        publishDefaultMode?: PublishMode;
        defaultBaseBranch?: string;
        providerHint?: "github" | "gitlab" | "bitbucket" | "unknown";
        officialContributionEnabled?: boolean;
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
        publishDefaultMode: source.publishDefaultMode,
        defaultBaseBranch: source.defaultBaseBranch,
        providerHint: source.providerHint,
        officialContributionEnabled: source.officialContributionEnabled,
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
        publishDefaultMode: byId.get(source.id)?.publishDefaultMode,
        defaultBaseBranch: byId.get(source.id)?.defaultBaseBranch,
        providerHint: byId.get(source.id)?.providerHint,
        officialContributionEnabled: byId.get(source.id)?.officialContributionEnabled,
        credentialRef: source.credentialRef || byId.get(source.id)?.credentialRef,
        removable: (byId.get(source.id)?.removable ?? true) && source.removable,
        lastSyncAt: byId.get(source.id)?.lastSyncAt || source.lastSyncAt,
        lastError: byId.get(source.id)?.lastError || source.lastError,
        revision: byId.get(source.id)?.revision || source.revision,
      });
    }

    return {
      sources: Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id)),
    };
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
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
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
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/sources/:id/auth/check", async (request, reply) => {
    const params = request.params as { id: string };
    const body = (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    const source = (await loadSources()).find((item) => item.id === params.id) || (await loadHookSources()).find((item) => item.id === params.id);
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
    const skillSource = (await loadSources()).find((item) => item.id === params.id);
    const hookSource = (await loadHookSources()).find((item) => item.id === params.id);
    if (!skillSource && !hookSource) {
      return reply.code(404).send({ error: `Unknown source '${params.id}'.` });
    }
    const credentialProvider = createCredentialProvider();
    try {
      const refreshed: Array<{ type: "skills" | "hooks"; revision?: string; localPath?: string; error?: string }> = [];
      if (skillSource) {
        try {
          const result = await syncSource(skillSource, credentialProvider);
          refreshed.push({ type: "skills", revision: result.revision, localPath: result.localPath });
        } catch (error) {
          refreshed.push({ type: "skills", error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (hookSource) {
        try {
          const result = await syncHookSource(hookSource, credentialProvider);
          refreshed.push({ type: "hooks", revision: result.revision, localPath: result.localPath });
        } catch (error) {
          refreshed.push({ type: "hooks", error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { sourceId: params.id, refreshed };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/sources/refresh-all", async () => {
    const credentialProvider = createCredentialProvider();
    const skillSources = (await loadSources()).filter((source) => source.enabled);
    const hookSources = (await loadHookSources()).filter((source) => source.enabled);
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
          const result = await syncSource(entry.skills, credentialProvider);
          item.skills = { revision: result.revision, localPath: result.localPath };
        } catch (error) {
          item.skills = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      if (entry.hooks) {
        try {
          const result = await syncHookSource(entry.hooks, credentialProvider);
          item.hooks = { revision: result.revision, localPath: result.localPath };
        } catch (error) {
          item.hooks = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      refreshed.push(item);
    }
    return { refreshed };
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
      const validation = await validateSkillBundle(
        {
          localPath,
          skillName: typeof body.skillName === "string" ? body.skillName : undefined,
        },
        profile,
      );
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
      const sources = await loadSources();
      const targetSource = sources.find((source) => source.id === sourceId);
      if (!targetSource) {
        return reply.code(404).send({ error: `Unknown source '${sourceId}'.` });
      }

      const catalog = await loadCatalogFromSources(repoRoot, false);
      const normalizedLocalPath = normalizePathForMatch(localPath);
      const matchedSkill = catalog.skills.find((skill) => normalizePathForMatch(skill.sourcePath || "") === normalizedLocalPath);
      const matchedSource = matchedSkill ? sources.find((source) => source.id === matchedSkill.sourceId) : undefined;
      const officialBundle = Boolean(matchedSource?.official) || looksLikeOfficialSkillPath(localPath);
      if (officialBundle && !targetSource.official) {
        return reply.code(400).send({ error: "Official skills can only be published to official sources." });
      }

      const result = await publishSkillBundle(
        {
          sourceId,
          bundle: {
            localPath,
            skillName: typeof body.skillName === "string" ? body.skillName : undefined,
          },
          commitMessage: typeof body.message === "string" ? body.message : undefined,
          overrideMode: overrideMode ? (overrideMode as PublishMode) : undefined,
          overrideBaseBranch: overrideBaseBranch || undefined,
        },
        createCredentialProvider(),
      );
      return { result };
    } catch (error) {
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
      const result = await contributeOfficialSkillBundle(
        {
          sourceId: typeof body.sourceId === "string" ? body.sourceId : undefined,
          bundle: {
            localPath,
            skillName: typeof body.skillName === "string" ? body.skillName : undefined,
          },
          commitMessage: typeof body.message === "string" ? body.message : undefined,
        },
        createCredentialProvider(),
      );
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
      await ensureHelperRunning(repoRoot);
      const payload = await helperRequest("/pick-directory", {
        initialPath: typeof body.initialPath === "string" ? body.initialPath : process.cwd(),
      });
      return payload;
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

    return executeOperation(repoRoot, installRequest, { hooks: pluginRuntime.installHooks });
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

    return executeOperation(repoRoot, uninstallRequest, { hooks: pluginRuntime.installHooks });
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

    return executeOperation(repoRoot, syncRequest, { hooks: pluginRuntime.installHooks });
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

  const host = process.env.ICA_DASHBOARD_HOST || "127.0.0.1";
  const port = Number(process.env.ICA_DASHBOARD_PORT || "4173");
  await app.listen({ host, port });
  process.stdout.write(`ICA dashboard listening at http://${host}:${port}\n`);
}

main().catch((error) => {
  process.stderr.write(`Dashboard startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
