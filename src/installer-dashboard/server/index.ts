import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { executeOperation } from "../../installer-core/executor";
import { loadCatalog } from "../../installer-core/catalog";
import { loadInstallState } from "../../installer-core/state";
import { discoverTargets, resolveTargetPaths } from "../../installer-core/targets";
import { SUPPORTED_TARGETS } from "../../installer-core/constants";
import { findRepoRoot } from "../../installer-core/repo";
import { InstallRequest, InstallScope, TargetPlatform } from "../../installer-core/types";

interface Capability {
  id: string;
  title: string;
  enabled: boolean;
}

interface InstallationSkillView {
  name: string;
  installMode: string;
  effectiveMode: string;
}

function capabilityRegistry(): Capability[] {
  return [
    { id: "skills-catalog", title: "Skill catalog browsing", enabled: true },
    { id: "target-selection", title: "Target platform selection", enabled: true },
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
    const catalog = loadCatalog(repoRoot);
    return {
      generatedAt: catalog.generatedAt,
      version: catalog.version,
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
    const catalog = loadCatalog(repoRoot);
    const catalogSkillNames = new Set(catalog.skills.map((skill) => skill.name));

    const rows = await Promise.all(
      resolved.map(async (entry) => {
        const state = await loadInstallState(entry.installPath);
        const managedSkills: InstallationSkillView[] =
          state?.managedSkills.map((skill) => ({
            name: skill.name,
            installMode: skill.installMode,
            effectiveMode: skill.effectiveMode,
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

  app.addHook("preHandler", async (request, reply) => {
    if (
      request.method !== "POST" ||
      !request.url.startsWith("/api/v1/") ||
      (!request.url.endsWith("/apply") && request.url !== "/api/v1/sync/apply")
    ) {
      return;
    }

    const loopbackIps = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
    if (!loopbackIps.has(request.ip)) {
      return reply.code(403).send({ error: "Forbidden: dashboard API accepts local loopback requests only." });
    }

    const contentType = String(request.headers["content-type"] || "");
    if (!contentType.toLowerCase().includes("application/json")) {
      return reply.code(415).send({ error: "Unsupported media type: expected application/json." });
    }
  });

  function normalizeBody(body: unknown): Partial<InstallRequest> {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return {};
    }
    const typed = body as Partial<InstallRequest>;
    return typed;
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
