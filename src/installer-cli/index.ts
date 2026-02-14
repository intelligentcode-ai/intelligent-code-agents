#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { executeOperation } from "../installer-core/executor";
import { loadCatalogFromSources } from "../installer-core/catalog";
import { createCredentialProvider } from "../installer-core/credentials";
import { checkSourceAuth } from "../installer-core/sourceAuth";
import { syncSource } from "../installer-core/sourceSync";
import { ensureSourceRegistry, loadSources, removeSource, updateSource } from "../installer-core/sources";
import { loadHookSources, removeHookSource, updateHookSource } from "../installer-core/hookSources";
import { syncHookSource } from "../installer-core/hookSync";
import { loadHookCatalogFromSources, HookInstallSelection } from "../installer-core/hookCatalog";
import { executeHookOperation, HookInstallRequest, HookTargetPlatform } from "../installer-core/hookExecutor";
import { loadHookInstallState } from "../installer-core/hookState";
import { registerRepository } from "../installer-core/repositories";
import { loadInstallState } from "../installer-core/state";
import { parseTargets, resolveTargetPaths } from "../installer-core/targets";
import { findRepoRoot } from "../installer-core/repo";
import { InstallMode, InstallRequest, InstallScope, InstallSelection, OperationKind, TargetPlatform } from "../installer-core/types";

interface ParsedArgs {
  command: string;
  options: Record<string, string | boolean>;
  positionals: string[];
}

const HELPER_HOST = "127.0.0.1";
const HELPER_PORT = Number(process.env.ICA_HELPER_PORT || "4174");
const HELPER_TOKEN = process.env.ICA_HELPER_TOKEN || crypto.randomBytes(24).toString("hex");
let helperProcess: ChildProcessWithoutNullStreams | null = null;

function parseArgv(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const trimmed = token.slice(2);
    if (trimmed.includes("=")) {
      const [key, value] = trimmed.split("=", 2);
      options[key] = value;
      continue;
    }

    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      options[trimmed] = true;
      continue;
    }

    options[trimmed] = next;
    i += 1;
  }

  return { command, options, positionals };
}

function boolOption(options: Record<string, string | boolean>, key: string, defaultValue = false): boolean {
  const value = options[key];
  if (value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function stringOption(options: Record<string, string | boolean>, key: string, defaultValue = ""): string {
  const value = options[key];
  if (value === undefined) return defaultValue;
  return typeof value === "boolean" ? String(value) : value;
}

function splitCsv(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseSkillSelectors(tokens: string[]): { legacySkills: string[]; selections: InstallSelection[] } {
  const legacySkills: string[] = [];
  const selections: InstallSelection[] = [];

  for (const token of tokens) {
    const idx = token.indexOf("/");
    if (idx > 0) {
      const sourceId = token.slice(0, idx);
      const skillName = token.slice(idx + 1);
      if (!sourceId || !skillName) {
        legacySkills.push(token);
        continue;
      }
      selections.push({
        sourceId,
        skillName,
        skillId: `${sourceId}/${skillName}`,
      });
      continue;
    }
    legacySkills.push(token);
  }

  return { legacySkills, selections };
}

function parseHookSelectors(tokens: string[]): { legacyHooks: string[]; selections: HookInstallSelection[] } {
  const legacyHooks: string[] = [];
  const selections: HookInstallSelection[] = [];

  for (const token of tokens) {
    const idx = token.indexOf("/");
    if (idx > 0) {
      const sourceId = token.slice(0, idx);
      const hookName = token.slice(idx + 1);
      if (!sourceId || !hookName) {
        legacyHooks.push(token);
        continue;
      }
      selections.push({
        sourceId,
        hookName,
        hookId: `${sourceId}/${hookName}`,
      });
      continue;
    }
    legacyHooks.push(token);
  }

  return { legacyHooks, selections };
}

function parseTargetsStrict(rawValue: string): TargetPlatform[] {
  const parsed = parseTargets(rawValue);
  if (rawValue.trim().length > 0 && parsed.length === 0) {
    throw new Error(`No valid targets were parsed from '${rawValue}'. Supported: claude,codex,cursor,gemini,antigravity`);
  }
  return parsed;
}

function parseHookTargetsStrict(rawValue: string): HookTargetPlatform[] {
  const parsed = parseTargets(rawValue).filter((target): target is HookTargetPlatform => target === "claude" || target === "gemini");
  if (rawValue.trim().length > 0 && parsed.length === 0) {
    throw new Error(`No valid hook-capable targets were parsed from '${rawValue}'. Supported: claude,gemini`);
  }
  if (parsed.length > 0) return parsed;
  return ["claude"];
}

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

function printHelp(): void {
  output.write(`ICA Installer CLI\n\n`);
  output.write(`Commands:\n`);
  output.write(`  ica install\n`);
  output.write(`  ica uninstall\n`);
  output.write(`  ica sync\n`);
  output.write(`  ica list\n`);
  output.write(`  ica doctor\n`);
  output.write(`  ica catalog\n\n`);
  output.write(`  ica sources list\n`);
  output.write(`  ica sources add [--repo-url=<url> | --repo-path=<path>] [--name=<name>] [--id=<id>] [--transport=https|ssh]\n`);
  output.write(`  ica sources remove --id=<source-id>\n`);
  output.write(
    `  ica sources update --id=<source-id> [--name=<name>] [--repo-url=<url>] [--transport=https|ssh] [--skills-root=/skills] [--hooks-root=/hooks] [--enabled=true|false]\n`,
  );
  output.write(`  ica sources auth --id=<source-id> [--token=<pat-or-api-key>]\n`);
  output.write(`  ica sources refresh [--id=<source-id>]\n\n`);
  output.write(`  ica hooks list [--targets=claude,gemini] [--scope=user|project] [--project-path=/path]\n`);
  output.write(`  ica hooks catalog [--json]\n`);
  output.write(`  ica hooks install [--targets=claude,gemini] [--scope=user|project] [--project-path=/path] [--mode=symlink|copy] [--hooks=<source/hook,...>]\n`);
  output.write(`  ica hooks uninstall [--targets=claude,gemini] [--scope=user|project] [--project-path=/path] [--mode=symlink|copy] [--hooks=<source/hook,...>]\n`);
  output.write(`  ica hooks sync [--targets=claude,gemini] [--scope=user|project] [--project-path=/path] [--mode=symlink|copy] [--hooks=<source/hook,...>]\n\n`);
  output.write(`  ica launch [--host=127.0.0.1] [--port=4173] [--open=true|false] [--allow-remote=true|false]\n\n`);
  output.write(`  Note: repository registration is unified. Adding one source auto-registers both skills and hooks mirrors.\n\n`);
  output.write(`  ica container mount-project --project-path=<path> --confirm [--container-name=<name>] [--image=<image>] [--port=<host:container>] [--json]\n\n`);
  output.write(`Common flags:\n`);
  output.write(`  --targets=claude,codex\n`);
  output.write(`  --scope=user|project\n`);
  output.write(`  --project-path=/path/to/repo (default: current directory when --scope=project)\n`);
  output.write(`  --mode=symlink|copy\n`);
  output.write(`  --skills=developer,architect,official-skills/reviewer\n`);
  output.write(`  --remove-unselected\n`);
  output.write(`  --agent-dir-name=.custom\n`);
  output.write(`  --install-claude-integration=true|false\n`);
  output.write(`  --config-file=path/to/ica.config.json\n`);
  output.write(`  --mcp-config=path/to/mcps.json\n`);
  output.write(`  --env-file=.env\n`);
  output.write(`  --force\n`);
  output.write(`  --yes\n`);
  output.write(`  --json\n`);
}

function openBrowser(url: string): void {
  let command = "";
  let args: string[] = [];
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch (error) {
    process.stderr.write(`Unable to open browser automatically: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

async function promptInteractive(command: OperationKind, options: Record<string, string | boolean>): Promise<InstallRequest> {
  const repoRoot = findRepoRoot(__dirname);
  const catalog = await loadCatalogFromSources(repoRoot, false);
  const rl = readline.createInterface({ input, output });

  try {
    const discovered = parseTargetsStrict(stringOption(options, "targets", ""));
    const defaultTargets = discovered.length > 0 ? discovered.join(",") : "claude";
    const rawTargets = await rl.question(`Targets [${defaultTargets}]: `);
    const targets = parseTargetsStrict(rawTargets || defaultTargets);

    const defaultScope = stringOption(options, "scope", "user");
    const scopeInput = (await rl.question(`Scope (user/project) [${defaultScope}]: `)).trim() || defaultScope;
    const scope = (scopeInput === "project" ? "project" : "user") as InstallScope;

    let projectPath = stringOption(options, "project-path", "");
    if (scope === "project" && !projectPath) {
      projectPath = (await rl.question(`Project path [${process.cwd()}]: `)).trim() || process.cwd();
    }

    const defaultMode = stringOption(options, "mode", "symlink");
    const modeInput = (await rl.question(`Mode (symlink/copy) [${defaultMode}]: `)).trim() || defaultMode;
    const mode = (modeInput === "copy" ? "copy" : "symlink") as InstallMode;

    const defaultSkills = catalog.skills.slice(0, 5).map((skill) => skill.skillId).join(",");
    const skillsInput =
      (await rl.question(
        `Skills (comma-separated, 'all' for every skill) [${command === "uninstall" ? "all-installed" : defaultSkills}]: `,
      )).trim() || (command === "uninstall" ? "" : defaultSkills);

    const selectedTokens =
      skillsInput.toLowerCase() === "all"
        ? catalog.skills.map((skill) => skill.skillId)
        : command === "uninstall" && skillsInput.toLowerCase() === "all-installed"
          ? []
          : splitCsv(skillsInput);
    const parsedSkills = parseSkillSelectors(selectedTokens);

    const removeUnselected = command === "sync" ? true : boolOption(options, "remove-unselected", false);

    const request: InstallRequest = {
      operation: command,
      targets,
      scope,
      projectPath: projectPath || undefined,
      agentDirName: stringOption(options, "agent-dir-name", "") || undefined,
      mode,
      skills: parsedSkills.legacySkills,
      skillSelections: parsedSkills.selections.length > 0 ? parsedSkills.selections : undefined,
      removeUnselected,
      installClaudeIntegration: !stringOption(options, "install-claude-integration", "true").toLowerCase().startsWith("f"),
      force: boolOption(options, "force", false),
      configFile: stringOption(options, "config-file", "") || undefined,
      mcpConfigFile: stringOption(options, "mcp-config", "") || undefined,
      envFile: stringOption(options, "env-file", "") || undefined,
    };

    return request;
  } finally {
    rl.close();
  }
}

async function buildRequestFromFlags(command: OperationKind, options: Record<string, string | boolean>): Promise<InstallRequest> {
  const repoRoot = findRepoRoot(__dirname);
  const catalog = await loadCatalogFromSources(repoRoot, false);
  const targets = parseTargetsStrict(stringOption(options, "targets", ""));
  const scope = (stringOption(options, "scope", "user") === "project" ? "project" : "user") as InstallScope;
  const projectPath =
    scope === "project"
      ? stringOption(options, "project-path", "").trim() || process.cwd()
      : stringOption(options, "project-path", "") || undefined;
  const mode = (stringOption(options, "mode", "symlink") === "copy" ? "copy" : "symlink") as InstallMode;

  const skillsRaw = stringOption(options, "skills", "");
  const selectedTokens =
    skillsRaw.trim().length > 0
      ? splitCsv(skillsRaw)
      : command === "install" || command === "sync"
        ? catalog.skills.map((skill) => skill.skillId)
        : [];
  const parsedSkills = parseSkillSelectors(selectedTokens);

  return {
    operation: command,
    targets,
    scope,
    projectPath,
    agentDirName: stringOption(options, "agent-dir-name", "") || undefined,
    mode,
    skills: parsedSkills.legacySkills,
    skillSelections: parsedSkills.selections.length > 0 ? parsedSkills.selections : undefined,
    removeUnselected: boolOption(options, "remove-unselected", false),
    installClaudeIntegration: boolOption(options, "install-claude-integration", true),
    force: boolOption(options, "force", false),
    configFile: stringOption(options, "config-file", "") || undefined,
    mcpConfigFile: stringOption(options, "mcp-config", "") || undefined,
    envFile: stringOption(options, "env-file", "") || undefined,
  };
}

async function runList(options: Record<string, string | boolean>): Promise<void> {
  const json = boolOption(options, "json", false);
  const scope = (stringOption(options, "scope", "user") === "project" ? "project" : "user") as InstallScope;
  const projectPath = stringOption(options, "project-path", "") || undefined;
  const targets = parseTargetsStrict(stringOption(options, "targets", ""));
  const resolved = resolveTargetPaths(targets, scope, projectPath, stringOption(options, "agent-dir-name", "") || undefined);

  const rows: Array<{ target: TargetPlatform; installPath: string; managedSkills: string[]; updatedAt?: string }> = [];

  for (const target of resolved) {
    const state = await loadInstallState(target.installPath);
    rows.push({
      target: target.target,
      installPath: target.installPath,
      managedSkills: (state?.managedSkills || []).map((skill) => skill.skillId || skill.name),
      updatedAt: state?.updatedAt,
    });
  }

  if (json) {
    output.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  for (const row of rows) {
    output.write(`${row.target}: ${row.installPath}\n`);
    output.write(`  Skills: ${row.managedSkills.length > 0 ? row.managedSkills.join(", ") : "(none)"}\n`);
    if (row.updatedAt) {
      output.write(`  Updated: ${row.updatedAt}\n`);
    }
  }
}

async function runDoctor(options: Record<string, string | boolean>): Promise<void> {
  const repoRoot = findRepoRoot(__dirname);
  const catalog = await loadCatalogFromSources(repoRoot, false);
  const discovered = parseTargetsStrict(stringOption(options, "targets", ""));

  const payload = {
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    discoveredTargets: discovered,
    catalogVersion: catalog.version,
    skills: catalog.skills.length,
  };

  if (boolOption(options, "json", false)) {
    output.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  output.write(`Node: ${payload.node}\n`);
  output.write(`Platform: ${payload.platform}\n`);
  output.write(`Discovered targets: ${payload.discoveredTargets.join(", ") || "(none)"}\n`);
  output.write(`Catalog: ${payload.catalogVersion} (${payload.skills} skills)\n`);
}

async function runCatalog(options: Record<string, string | boolean>): Promise<void> {
  const repoRoot = findRepoRoot(__dirname);
  const catalog = await loadCatalogFromSources(repoRoot, false);
  if (boolOption(options, "json", false)) {
    output.write(`${JSON.stringify(catalog, null, 2)}\n`);
    return;
  }

  output.write(`Catalog version: ${catalog.version}\n`);
  output.write(`Generated at: ${catalog.generatedAt}\n`);
  for (const skill of catalog.skills) {
    output.write(`- ${skill.skillId} [${skill.category}]\n`);
    output.write(`  ${skill.description}\n`);
    if (skill.resources.length > 0) {
      output.write(`  resources: ${skill.resources.map((resource) => `${resource.type}:${resource.path}`).join(", ")}\n`);
    }
  }
}

async function runOperation(command: OperationKind, options: Record<string, string | boolean>): Promise<void> {
  const repoRoot = findRepoRoot(__dirname);
  const request = boolOption(options, "yes", false)
    ? await buildRequestFromFlags(command, options)
    : await promptInteractive(command, options);

  const report = await executeOperation(repoRoot, request);

  if (boolOption(options, "json", false)) {
    output.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  for (const target of report.targets) {
    output.write(`\n[${target.target}] ${target.operation} -> ${target.installPath}\n`);
    output.write(`  applied: ${target.appliedSkills.join(", ") || "(none)"}\n`);
    output.write(`  removed: ${target.removedSkills.join(", ") || "(none)"}\n`);
    output.write(`  skipped: ${target.skippedSkills.join(", ") || "(none)"}\n`);

    if (target.warnings.length > 0) {
      for (const warning of target.warnings) {
        output.write(`  warning(${warning.code}): ${warning.message}\n`);
      }
    }

    if (target.errors.length > 0) {
      for (const error of target.errors) {
        output.write(`  error(${error.code}): ${error.message}\n`);
      }
    }
  }
}

async function runSources(positionals: string[], options: Record<string, string | boolean>): Promise<void> {
  const action = (positionals[0] || "list").toLowerCase();
  const json = boolOption(options, "json", false);
  const credentialProvider = createCredentialProvider();

  const loadRepositoryRows = async (): Promise<
    Array<{
      id: string;
      repoUrl: string;
      transport: "https" | "ssh";
      name: string;
      skills?: Awaited<ReturnType<typeof loadSources>>[number];
      hooks?: Awaited<ReturnType<typeof loadHookSources>>[number];
    }>
  > => {
    const skillSources = await ensureSourceRegistry();
    const hookSources = await loadHookSources();
    const byId = new Map<
      string,
      {
        id: string;
        repoUrl: string;
        transport: "https" | "ssh";
        name: string;
        skills?: Awaited<ReturnType<typeof loadSources>>[number];
        hooks?: Awaited<ReturnType<typeof loadHookSources>>[number];
      }
    >();

    for (const source of skillSources) {
      byId.set(source.id, {
        ...(byId.get(source.id) || {
          id: source.id,
          repoUrl: source.repoUrl,
          transport: source.transport,
          name: source.name,
        }),
        repoUrl: source.repoUrl,
        transport: source.transport,
        name: source.name,
        skills: source,
      });
    }
    for (const source of hookSources) {
      byId.set(source.id, {
        ...(byId.get(source.id) || {
          id: source.id,
          repoUrl: source.repoUrl,
          transport: source.transport,
          name: source.name,
        }),
        repoUrl: source.repoUrl,
        transport: source.transport,
        name: source.name,
        hooks: source,
      });
    }
    return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  };

  if (action === "list") {
    const repositories = await loadRepositoryRows();
    if (json) {
      output.write(`${JSON.stringify(repositories, null, 2)}\n`);
      return;
    }
    for (const repo of repositories) {
      const enabled = repo.skills?.enabled !== false || repo.hooks?.enabled !== false;
      output.write(`${repo.id} (${repo.transport}) ${enabled ? "enabled" : "disabled"}\n`);
      output.write(`  name: ${repo.name}\n`);
      output.write(`  repo: ${repo.repoUrl}\n`);
      if (repo.skills) {
        output.write(`  skillsRoot: ${repo.skills.skillsRoot}\n`);
        output.write(`  skillsSynced: ${repo.skills.lastSyncAt || "(never)"}\n`);
        if (repo.skills.lastError) output.write(`  skillsError: ${repo.skills.lastError}\n`);
      }
      if (repo.hooks) {
        output.write(`  hooksRoot: ${repo.hooks.hooksRoot}\n`);
        output.write(`  hooksSynced: ${repo.hooks.lastSyncAt || "(never)"}\n`);
        if (repo.hooks.lastError) output.write(`  hooksError: ${repo.hooks.lastError}\n`);
      }
    }
    return;
  }

  if (action === "add") {
    const repoUrlOption = stringOption(options, "repo-url", stringOption(options, "url", "")).trim();
    const repoPathOption = stringOption(options, "repo-path", stringOption(options, "path", "")).trim();
    const localRepoPath = path.resolve(repoPathOption || process.cwd());
    if (!repoUrlOption && (!fs.existsSync(localRepoPath) || !fs.statSync(localRepoPath).isDirectory())) {
      throw new Error(`Local repository path does not exist: ${localRepoPath}`);
    }
    const repoUrl = repoUrlOption || `file://${localRepoPath}`;
    const token = stringOption(options, "token", stringOption(options, "api-key", "")).trim();
    const registration = await registerRepository(
      {
        id: stringOption(options, "id", "") || undefined,
        name: stringOption(options, "name", "") || undefined,
        repoUrl,
        transport: (stringOption(options, "transport", "") as "https" | "ssh") || undefined,
        skillsRoot: stringOption(options, "skills-root", "") || undefined,
        hooksRoot: stringOption(options, "hooks-root", "") || undefined,
        enabled: !stringOption(options, "enabled", "true").toLowerCase().startsWith("f"),
        removable: true,
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
      throw new Error(`Repository added but auth check failed: ${auth.message}`);
    }

    if (json) {
      output.write(`${JSON.stringify(registration, null, 2)}\n`);
    } else {
      output.write(`Added repository '${source.id}'. Skills sync: ${registration.sync.skills.ok ? "OK" : "FAILED"}.\n`);
      output.write(`Hooks sync: ${registration.sync.hooks.ok ? "OK" : "FAILED"}.\n`);
      if (!registration.sync.skills.ok && registration.sync.skills.error) {
        output.write(`  skills error: ${registration.sync.skills.error}\n`);
      }
      if (!registration.sync.hooks.ok && registration.sync.hooks.error) {
        output.write(`  hooks error: ${registration.sync.hooks.error}\n`);
      }
    }
    return;
  }

  if (action === "remove") {
    const sourceId = stringOption(options, "id", "").trim();
    if (!sourceId) {
      throw new Error("Missing required option --id");
    }
    let removed: unknown = null;
    try {
      removed = await removeSource(sourceId);
    } catch {
      // allow hook-only removals in older setups
    }
    try {
      await removeHookSource(sourceId);
    } catch {
      // ignore missing hook mirror
    }
    await credentialProvider.delete(sourceId);
    output.write(json ? `${JSON.stringify(removed || { id: sourceId }, null, 2)}\n` : `Removed repository '${sourceId}'.\n`);
    return;
  }

  if (action === "update") {
    const sourceId = stringOption(options, "id", "").trim();
    if (!sourceId) {
      throw new Error("Missing required option --id");
    }
    const repoUrlOption = stringOption(options, "repo-url", "").trim();
    const repoPathOption = stringOption(options, "repo-path", "").trim();
    const repoUrl = repoUrlOption || (repoPathOption ? `file://${path.resolve(repoPathOption)}` : undefined);
    const source = await updateSource(sourceId, {
      name: stringOption(options, "name", "") || undefined,
      repoUrl,
      transport: (stringOption(options, "transport", "") as "https" | "ssh") || undefined,
      skillsRoot: stringOption(options, "skills-root", "") || undefined,
      enabled:
        options.enabled !== undefined
          ? !stringOption(options, "enabled", "true").toLowerCase().startsWith("f")
          : undefined,
    });
    try {
      await updateHookSource(sourceId, {
        name: stringOption(options, "name", "") || undefined,
        repoUrl,
        transport: (stringOption(options, "transport", "") as "https" | "ssh") || undefined,
        hooksRoot: stringOption(options, "hooks-root", "") || undefined,
        enabled:
          options.enabled !== undefined
            ? !stringOption(options, "enabled", "true").toLowerCase().startsWith("f")
            : undefined,
      });
    } catch {
      // Older environments may still have only skill sources configured.
    }

    const token = stringOption(options, "token", stringOption(options, "api-key", "")).trim();
    if (token) {
      await credentialProvider.store(sourceId, token);
      await updateSource(sourceId, { credentialRef: `${sourceId}:stored` });
      try {
        await updateHookSource(sourceId, { credentialRef: `${sourceId}:stored` });
      } catch {
        // ignore missing hook mirror
      }
    }

    output.write(json ? `${JSON.stringify(source, null, 2)}\n` : `Updated repository '${sourceId}'.\n`);
    return;
  }

  if (action === "auth") {
    const sourceId = stringOption(options, "id", "").trim();
    if (!sourceId) {
      throw new Error("Missing required option --id");
    }
    const token = stringOption(options, "token", stringOption(options, "api-key", "")).trim();
    if (token) {
      await credentialProvider.store(sourceId, token);
      try {
        await updateSource(sourceId, { credentialRef: `${sourceId}:stored` });
      } catch {
        // ignore missing skill mirror
      }
      try {
        await updateHookSource(sourceId, { credentialRef: `${sourceId}:stored` });
      } catch {
        // ignore missing hook mirror
      }
    }
    const source = (await loadSources()).find((item) => item.id === sourceId) || (await loadHookSources()).find((item) => item.id === sourceId);
    if (!source) {
      throw new Error(`Unknown source '${sourceId}'`);
    }
    const result = await checkSourceAuth(
      {
        id: source.id,
        repoUrl: source.repoUrl,
        transport: source.transport,
      },
      credentialProvider,
    );
    if (json) {
      output.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      output.write(`${result.ok ? "OK" : "FAILED"}: ${result.message}\n`);
    }
    return;
  }

  if (action === "refresh") {
    const sourceId = stringOption(options, "id", "").trim();
    const repositories = await loadRepositoryRows();
    const targets = sourceId
      ? repositories.filter((repo) => repo.id === sourceId)
      : repositories.filter((repo) => repo.skills?.enabled !== false || repo.hooks?.enabled !== false);
    if (targets.length === 0) {
      throw new Error(sourceId ? `Unknown source '${sourceId}'` : "No enabled sources found.");
    }

    const refreshed: Array<{
      id: string;
      skills?: { revision?: string; localPath?: string; error?: string };
      hooks?: { revision?: string; localPath?: string; error?: string };
    }> = [];
    for (const repo of targets) {
      const item: {
        id: string;
        skills?: { revision?: string; localPath?: string; error?: string };
        hooks?: { revision?: string; localPath?: string; error?: string };
      } = { id: repo.id };

      if (repo.skills) {
        try {
          const result = await syncSource(repo.skills, credentialProvider);
          item.skills = { revision: result.revision, localPath: result.localPath };
        } catch (error) {
          item.skills = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      if (repo.hooks) {
        try {
          const result = await syncHookSource(repo.hooks, credentialProvider);
          item.hooks = { revision: result.revision, localPath: result.localPath };
        } catch (error) {
          item.hooks = { error: error instanceof Error ? error.message : String(error) };
        }
      }
      refreshed.push(item);
    }
    output.write(json ? `${JSON.stringify(refreshed, null, 2)}\n` : `Refreshed ${refreshed.length} repositories.\n`);
    return;
  }

  throw new Error(`Unknown sources action '${action}'. Supported: list|add|remove|update|auth|refresh`);
}

async function runHooks(positionals: string[], options: Record<string, string | boolean>): Promise<void> {
  const action = (positionals[0] || "list").toLowerCase();
  const json = boolOption(options, "json", false);
  const repoRoot = findRepoRoot(__dirname);

  if (action === "catalog") {
    const catalog = await loadHookCatalogFromSources(repoRoot, false);
    if (json) {
      output.write(`${JSON.stringify(catalog, null, 2)}\n`);
      return;
    }
    output.write(`Hook catalog version: ${catalog.version}\n`);
    output.write(`Generated at: ${catalog.generatedAt}\n`);
    for (const hook of catalog.hooks) {
      output.write(`- ${hook.hookId}\n`);
      if (hook.description) {
        output.write(`  ${hook.description}\n`);
      }
    }
    return;
  }

  if (action === "list") {
    const scope = (stringOption(options, "scope", "user") === "project" ? "project" : "user") as "user" | "project";
    const projectPath = stringOption(options, "project-path", "").trim() || (scope === "project" ? process.cwd() : undefined);
    const targets = parseHookTargetsStrict(stringOption(options, "targets", ""));
    const resolved = resolveTargetPaths(targets, scope, projectPath, stringOption(options, "agent-dir-name", "") || undefined);

    const rows: Array<{ target: HookTargetPlatform; installPath: string; managedHooks: string[]; updatedAt?: string }> = [];
    for (const target of resolved) {
      const state = await loadHookInstallState(target.installPath);
      rows.push({
        target: target.target as HookTargetPlatform,
        installPath: target.installPath,
        managedHooks: (state?.managedHooks || []).map((hook) => hook.hookId || hook.name),
        updatedAt: state?.updatedAt,
      });
    }

    if (json) {
      output.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    for (const row of rows) {
      output.write(`${row.target}: ${row.installPath}\n`);
      output.write(`  Hooks: ${row.managedHooks.length > 0 ? row.managedHooks.join(", ") : "(none)"}\n`);
      if (row.updatedAt) {
        output.write(`  Updated: ${row.updatedAt}\n`);
      }
    }
    return;
  }

  if (!["install", "uninstall", "sync"].includes(action)) {
    throw new Error(`Unknown hooks action '${action}'. Supported: list|catalog|install|uninstall|sync`);
  }

  const catalog = await loadHookCatalogFromSources(repoRoot, false);
  const targets = parseHookTargetsStrict(stringOption(options, "targets", ""));
  const scope = (stringOption(options, "scope", "user") === "project" ? "project" : "user") as "user" | "project";
  const projectPath = scope === "project" ? stringOption(options, "project-path", "").trim() || process.cwd() : undefined;
  const mode = (stringOption(options, "mode", "symlink") === "copy" ? "copy" : "symlink") as "symlink" | "copy";

  const hooksRaw = stringOption(options, "hooks", "");
  const selectedTokens =
    hooksRaw.trim().length > 0
      ? splitCsv(hooksRaw)
      : action === "install" || action === "sync"
        ? catalog.hooks.map((hook) => hook.hookId)
        : [];
  const parsedHooks = parseHookSelectors(selectedTokens);

  const request: HookInstallRequest = {
    operation: action as "install" | "uninstall" | "sync",
    targets,
    scope,
    projectPath,
    agentDirName: stringOption(options, "agent-dir-name", "") || undefined,
    mode,
    hooks: parsedHooks.legacyHooks,
    hookSelections: parsedHooks.selections.length > 0 ? parsedHooks.selections : undefined,
    removeUnselected: action === "sync" ? true : boolOption(options, "remove-unselected", false),
    force: boolOption(options, "force", false),
  };

  const report = await executeHookOperation(repoRoot, request);
  if (json) {
    output.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  for (const target of report.targets) {
    output.write(`\n[${target.target}] ${target.operation} -> ${target.installPath}\n`);
    output.write(`  applied: ${target.appliedHooks.join(", ") || "(none)"}\n`);
    output.write(`  removed: ${target.removedHooks.join(", ") || "(none)"}\n`);
    output.write(`  skipped: ${target.skippedHooks.join(", ") || "(none)"}\n`);

    if (target.warnings.length > 0) {
      for (const warning of target.warnings) {
        output.write(`  warning(${warning.code}): ${warning.message}\n`);
      }
    }
    if (target.errors.length > 0) {
      for (const error of target.errors) {
        output.write(`  error(${error.code}): ${error.message}\n`);
      }
    }
  }
}

async function runContainer(positionals: string[], options: Record<string, string | boolean>): Promise<void> {
  const action = (positionals[0] || "mount-project").toLowerCase();
  if (action !== "mount-project") {
    throw new Error(`Unknown container action '${action}'. Supported: mount-project`);
  }
  const projectPath = stringOption(options, "project-path", "").trim();
  if (!projectPath) {
    throw new Error("Missing required option --project-path");
  }
  if (!boolOption(options, "confirm", false)) {
    throw new Error("Container mount requires --confirm");
  }

  const repoRoot = findRepoRoot(__dirname);
  await ensureHelperRunning(repoRoot);
  const payload = await helperRequest("/container/mount-project", {
    projectPath,
    containerName: stringOption(options, "container-name", "") || undefined,
    image: stringOption(options, "image", "") || undefined,
    port: stringOption(options, "port", "") || undefined,
    confirm: true,
  });
  if (boolOption(options, "json", false)) {
    output.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  output.write(`Mounted project path '${projectPath}' into container '${String(payload.containerName || "")}'.\n`);
  if (payload.command) {
    output.write(`Command: ${String(payload.command)}\n`);
  }
}

async function runLaunch(options: Record<string, string | boolean>): Promise<void> {
  const repoRoot = findRepoRoot(__dirname);
  const host = stringOption(options, "host", "127.0.0.1").trim() || "127.0.0.1";
  const port = stringOption(options, "port", "4173").trim() || "4173";
  const allowRemote = boolOption(options, "allow-remote", false);
  if (!isLoopbackHost(host) && !allowRemote) {
    throw new Error(
      `Refusing non-loopback dashboard host '${host}' without explicit consent. Use --allow-remote=true if you intentionally want remote API access.`,
    );
  }
  const dashboardUrl = `http://${host}:${port}`;
  const serverScript = path.join(repoRoot, "dist", "src", "installer-dashboard", "server", "index.js");

  if (!fs.existsSync(serverScript)) {
    throw new Error("Dashboard runtime is not built. Run: npm run build");
  }

  if (boolOption(options, "open", false)) {
    openBrowser(dashboardUrl);
  }

  output.write(`Launching ICA dashboard at ${dashboardUrl}\n`);
  const child = spawn(process.execPath, [serverScript], {
    stdio: "inherit",
    env: {
      ...process.env,
      ICA_DASHBOARD_HOST: host,
      ICA_DASHBOARD_PORT: port,
      ICA_DASHBOARD_ALLOW_REMOTE: allowRemote ? "true" : "false",
    },
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Dashboard process exited with code ${code ?? "unknown"}`));
    });
  });
}

async function main(): Promise<void> {
  const { command, options, positionals } = parseArgv(process.argv.slice(2));
  const normalized = command.toLowerCase();

  if (["install", "uninstall", "sync"].includes(normalized)) {
    await runOperation(normalized as OperationKind, options);
    return;
  }

  if (normalized === "list") {
    await runList(options);
    return;
  }

  if (normalized === "doctor") {
    await runDoctor(options);
    return;
  }

  if (normalized === "catalog") {
    await runCatalog(options);
    return;
  }

  if (normalized === "sources") {
    await runSources(positionals, options);
    return;
  }

  if (normalized === "hooks") {
    await runHooks(positionals, options);
    return;
  }

  if (normalized === "container") {
    await runContainer(positionals, options);
    return;
  }

  if (normalized === "launch") {
    await runLaunch(options);
    return;
  }

  printHelp();
}

main().catch((error) => {
  process.stderr.write(`ICA CLI failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

process.on("exit", () => {
  if (helperProcess && !helperProcess.killed) {
    helperProcess.kill();
  }
});
