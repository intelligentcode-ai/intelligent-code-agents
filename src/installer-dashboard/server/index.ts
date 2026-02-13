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
import { addSource, loadSources, removeSource, setSourceSyncStatus, updateSource } from "../../installer-core/sources";
import { loadInstallState } from "../../installer-core/state";
import { discoverTargets, resolveTargetPaths } from "../../installer-core/targets";
import { SUPPORTED_TARGETS } from "../../installer-core/constants";
import { findRepoRoot } from "../../installer-core/repo";
import { InstallRequest, InstallScope, InstallSelection, TargetPlatform } from "../../installer-core/types";

interface Capability {
  id: string;
  title: string;
  enabled: boolean;
}

interface InstallationSkillView {
  name: string;
  skillId?: string;
  sourceId?: string;
  installMode: string;
  effectiveMode: string;
  orphaned?: boolean;
}

function capabilityRegistry(): Capability[] {
  return [
    { id: "skills-catalog", title: "Skill catalog browsing", enabled: true },
    { id: "multi-source", title: "Multi-source repository management", enabled: true },
    { id: "target-selection", title: "Target platform selection", enabled: true },
    { id: "native-project-picker", title: "Native host project picker", enabled: true },
    { id: "install-mode", title: "Symlink/copy mode", enabled: true },
    { id: "installations", title: "Installed state inspection", enabled: true },
    { id: "operations", title: "Install/uninstall/sync operations", enabled: true },
  ];
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

  app.get("/api/v1/health", async () => {
    return {
      ok: true,
      service: "ica-installer-dashboard",
      timestamp: new Date().toISOString(),
    };
  });

  app.get("/api/v1/capabilities", async () => {
    return { capabilities: capabilityRegistry() };
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

  app.get("/api/v1/sources", async () => {
    return {
      sources: await loadSources(),
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

    const source = await addSource({
      id: typeof body.id === "string" ? body.id : undefined,
      name: typeof body.name === "string" ? body.name : undefined,
      repoUrl,
      transport: typeof body.transport === "string" && (body.transport === "https" || body.transport === "ssh") ? body.transport : undefined,
      skillsRoot: typeof body.skillsRoot === "string" ? body.skillsRoot : undefined,
      enabled: body.enabled !== false,
      removable: body.removable !== false,
      official: body.official === true,
    });

    const credentialProvider = createCredentialProvider();
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (token) {
      await credentialProvider.store(source.id, token);
      await updateSource(source.id, { credentialRef: `${source.id}:stored` });
    }

    const auth = await checkSourceAuth(source, credentialProvider);
    if (!auth.ok) {
      await setSourceSyncStatus(source.id, { lastError: auth.message });
      return reply.code(400).send({ error: auth.message, source });
    }

    const sync = await syncSource(source, credentialProvider);
    if (!fs.existsSync(sync.skillsPath) || !fs.statSync(sync.skillsPath).isDirectory()) {
      return reply
        .code(400)
        .send({ error: `Source '${source.id}' is invalid: missing required skills root '${source.skillsRoot}'.`, source });
    }
    return {
      source: {
        ...source,
        localPath: sync.localPath,
        revision: sync.revision,
      },
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

      const credentialProvider = createCredentialProvider();
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (token) {
        await credentialProvider.store(params.id, token);
        await updateSource(params.id, { credentialRef: `${params.id}:stored` });
      }

      return { source };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/v1/sources/:id", async (request, reply) => {
    const params = request.params as { id: string };
    try {
      const removed = await removeSource(params.id);
      const credentialProvider = createCredentialProvider();
      await credentialProvider.delete(params.id);
      return { source: removed };
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
    const source = (await loadSources()).find((item) => item.id === params.id);
    if (!source) {
      return reply.code(404).send({ error: `Unknown source '${params.id}'.` });
    }

    const credentialProvider = createCredentialProvider();
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (token) {
      await credentialProvider.store(source.id, token);
      await updateSource(source.id, { credentialRef: `${source.id}:stored` });
    }
    const auth = await checkSourceAuth(source, credentialProvider);
    if (!auth.ok) {
      return reply.code(400).send(auth);
    }
    return auth;
  });

  app.post("/api/v1/sources/:id/refresh", async (request, reply) => {
    const params = request.params as { id: string };
    const source = (await loadSources()).find((item) => item.id === params.id);
    if (!source) {
      return reply.code(404).send({ error: `Unknown source '${params.id}'.` });
    }
    const credentialProvider = createCredentialProvider();
    try {
      const refreshed = await syncSource(source, credentialProvider);
      return { sourceId: source.id, revision: refreshed.revision, localPath: refreshed.localPath };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/v1/sources/refresh-all", async () => {
    const credentialProvider = createCredentialProvider();
    const sources = (await loadSources()).filter((source) => source.enabled);
    const refreshed: Array<{ sourceId: string; revision?: string; localPath?: string; error?: string }> = [];
    for (const source of sources) {
      try {
        const result = await syncSource(source, credentialProvider);
        refreshed.push({
          sourceId: source.id,
          revision: result.revision,
          localPath: result.localPath,
        });
      } catch (error) {
        refreshed.push({
          sourceId: source.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { refreshed };
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

  function normalizeTargets(value: Partial<InstallRequest>["targets"]): TargetPlatform[] {
    if (!Array.isArray(value)) {
      return discoverTargets();
    }
    const filtered = value.filter((item): item is TargetPlatform =>
      typeof item === "string" && SUPPORTED_TARGETS.includes(item as TargetPlatform),
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

    return executeOperation(repoRoot, installRequest);
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

    return executeOperation(repoRoot, uninstallRequest);
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

    return executeOperation(repoRoot, syncRequest);
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
