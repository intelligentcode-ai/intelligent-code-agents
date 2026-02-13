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
import { addSource, ensureSourceRegistry, loadSources, removeSource, updateSource } from "../installer-core/sources";
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

function parseTargetsStrict(rawValue: string): TargetPlatform[] {
  const parsed = parseTargets(rawValue);
  if (rawValue.trim().length > 0 && parsed.length === 0) {
    throw new Error(`No valid targets were parsed from '${rawValue}'. Supported: claude,codex,cursor,gemini,antigravity`);
  }
  return parsed;
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
  output.write(`  ica sources update --id=<source-id> [--name=<name>] [--repo-url=<url>] [--transport=https|ssh] [--skills-root=/skills] [--enabled=true|false]\n`);
  output.write(`  ica sources auth --id=<source-id> [--token=<pat-or-api-key>]\n`);
  output.write(`  ica sources refresh [--id=<source-id>]\n\n`);
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

  if (action === "list") {
    const sources = await ensureSourceRegistry();
    if (json) {
      output.write(`${JSON.stringify(sources, null, 2)}\n`);
      return;
    }
    for (const source of sources) {
      output.write(`${source.id} (${source.transport}) ${source.enabled ? "enabled" : "disabled"}\n`);
      output.write(`  name: ${source.name}\n`);
      output.write(`  repo: ${source.repoUrl}\n`);
      output.write(`  root: ${source.skillsRoot}\n`);
      output.write(`  synced: ${source.lastSyncAt || "(never)"}\n`);
      if (source.lastError) {
        output.write(`  lastError: ${source.lastError}\n`);
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

    const source = await addSource({
      id: stringOption(options, "id", "") || undefined,
      name: stringOption(options, "name", "") || undefined,
      repoUrl,
      transport: (stringOption(options, "transport", "") as "https" | "ssh") || undefined,
      skillsRoot: stringOption(options, "skills-root", "") || undefined,
      enabled: !stringOption(options, "enabled", "true").toLowerCase().startsWith("f"),
      removable: true,
    });
    const token = stringOption(options, "token", stringOption(options, "api-key", "")).trim();
    if (token) {
      await credentialProvider.store(source.id, token);
    }

    const auth = await checkSourceAuth(source, credentialProvider);
    if (!auth.ok) {
      throw new Error(`Source added but auth check failed: ${auth.message}`);
    }
    const sync = await syncSource(source, credentialProvider);
    if (!fs.existsSync(sync.skillsPath) || !fs.statSync(sync.skillsPath).isDirectory()) {
      throw new Error(`Source '${source.id}' is invalid: missing required skills root '${source.skillsRoot}'.`);
    }

    output.write(json ? `${JSON.stringify(source, null, 2)}\n` : `Added source '${source.id}' and completed initial sync.\n`);
    return;
  }

  if (action === "remove") {
    const sourceId = stringOption(options, "id", "").trim();
    if (!sourceId) {
      throw new Error("Missing required option --id");
    }
    const removed = await removeSource(sourceId);
    await credentialProvider.delete(sourceId);
    output.write(json ? `${JSON.stringify(removed, null, 2)}\n` : `Removed source '${sourceId}'.\n`);
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

    const token = stringOption(options, "token", stringOption(options, "api-key", "")).trim();
    if (token) {
      await credentialProvider.store(sourceId, token);
      await updateSource(sourceId, { credentialRef: `${sourceId}:stored` });
    }

    output.write(json ? `${JSON.stringify(source, null, 2)}\n` : `Updated source '${sourceId}'.\n`);
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
      await updateSource(sourceId, { credentialRef: `${sourceId}:stored` });
    }
    const source = (await loadSources()).find((item) => item.id === sourceId);
    if (!source) {
      throw new Error(`Unknown source '${sourceId}'`);
    }
    const result = await checkSourceAuth(source, credentialProvider);
    if (json) {
      output.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      output.write(`${result.ok ? "OK" : "FAILED"}: ${result.message}\n`);
    }
    return;
  }

  if (action === "refresh") {
    const sourceId = stringOption(options, "id", "").trim();
    const sources = await loadSources();
    const targets = sourceId ? sources.filter((source) => source.id === sourceId) : sources.filter((source) => source.enabled);
    if (targets.length === 0) {
      throw new Error(sourceId ? `Unknown source '${sourceId}'` : "No enabled sources found.");
    }

    const refreshed: Array<{ id: string; revision: string; localPath: string }> = [];
    for (const source of targets) {
      const result = await syncSource(source, credentialProvider);
      refreshed.push({ id: source.id, revision: result.revision, localPath: result.localPath });
    }
    output.write(json ? `${JSON.stringify(refreshed, null, 2)}\n` : `Refreshed ${refreshed.length} source(s).\n`);
    return;
  }

  throw new Error(`Unknown sources action '${action}'. Supported: list|add|remove|update|auth|refresh`);
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

  if (normalized === "container") {
    await runContainer(positionals, options);
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
