#!/usr/bin/env node
import os from "node:os";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { executeOperation } from "../installer-core/executor";
import { loadCatalog } from "../installer-core/catalog";
import { loadInstallState } from "../installer-core/state";
import { parseTargets, resolveTargetPaths } from "../installer-core/targets";
import { findRepoRoot } from "../installer-core/repo";
import { InstallMode, InstallRequest, InstallScope, OperationKind, TargetPlatform } from "../installer-core/types";

interface ParsedArgs {
  command: string;
  options: Record<string, string | boolean>;
}

function parseArgv(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const options: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) continue;

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

  return { command, options };
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

function parseTargetsStrict(rawValue: string): TargetPlatform[] {
  const parsed = parseTargets(rawValue);
  if (rawValue.trim().length > 0 && parsed.length === 0) {
    throw new Error(`No valid targets were parsed from '${rawValue}'. Supported: claude,codex,cursor,gemini,antigravity`);
  }
  return parsed;
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
  output.write(`Common flags:\n`);
  output.write(`  --targets=claude,codex\n`);
  output.write(`  --scope=user|project\n`);
  output.write(`  --project-path=/path/to/repo\n`);
  output.write(`  --mode=symlink|copy\n`);
  output.write(`  --skills=developer,architect\n`);
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
  const catalog = loadCatalog(repoRoot);
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

    const defaultSkills = catalog.skills.slice(0, 5).map((skill) => skill.name).join(",");
    const skillsInput =
      (await rl.question(
        `Skills (comma-separated, 'all' for every skill) [${command === "uninstall" ? "all-installed" : defaultSkills}]: `,
      )).trim() || (command === "uninstall" ? "" : defaultSkills);

    const skills =
      skillsInput.toLowerCase() === "all"
        ? catalog.skills.map((skill) => skill.name)
        : command === "uninstall" && skillsInput.toLowerCase() === "all-installed"
          ? []
          : splitCsv(skillsInput);

    const removeUnselected = command === "sync" ? true : boolOption(options, "remove-unselected", false);

    const request: InstallRequest = {
      operation: command,
      targets,
      scope,
      projectPath: projectPath || undefined,
      agentDirName: stringOption(options, "agent-dir-name", "") || undefined,
      mode,
      skills,
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

function buildRequestFromFlags(command: OperationKind, options: Record<string, string | boolean>): InstallRequest {
  const repoRoot = findRepoRoot(__dirname);
  const catalog = loadCatalog(repoRoot);
  const targets = parseTargetsStrict(stringOption(options, "targets", ""));
  const scope = (stringOption(options, "scope", "user") === "project" ? "project" : "user") as InstallScope;
  const projectPath = stringOption(options, "project-path", "") || undefined;
  const mode = (stringOption(options, "mode", "symlink") === "copy" ? "copy" : "symlink") as InstallMode;

  const skillsRaw = stringOption(options, "skills", "");
  const skills =
    skillsRaw.trim().length > 0
      ? splitCsv(skillsRaw)
      : command === "install" || command === "sync"
        ? catalog.skills.map((skill) => skill.name)
        : [];

  return {
    operation: command,
    targets,
    scope,
    projectPath,
    agentDirName: stringOption(options, "agent-dir-name", "") || undefined,
    mode,
    skills,
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
      managedSkills: (state?.managedSkills || []).map((skill) => skill.name),
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

function runDoctor(options: Record<string, string | boolean>): void {
  const repoRoot = findRepoRoot(__dirname);
  const catalog = loadCatalog(repoRoot);
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

function runCatalog(options: Record<string, string | boolean>): void {
  const repoRoot = findRepoRoot(__dirname);
  const catalog = loadCatalog(repoRoot);
  if (boolOption(options, "json", false)) {
    output.write(`${JSON.stringify(catalog, null, 2)}\n`);
    return;
  }

  output.write(`Catalog version: ${catalog.version}\n`);
  output.write(`Generated at: ${catalog.generatedAt}\n`);
  for (const skill of catalog.skills) {
    output.write(`- ${skill.name} [${skill.category}]\n`);
    output.write(`  ${skill.description}\n`);
    if (skill.resources.length > 0) {
      output.write(`  resources: ${skill.resources.map((resource) => `${resource.type}:${resource.path}`).join(", ")}\n`);
    }
  }
}

async function runOperation(command: OperationKind, options: Record<string, string | boolean>): Promise<void> {
  const repoRoot = findRepoRoot(__dirname);
  const request = boolOption(options, "yes", false)
    ? buildRequestFromFlags(command, options)
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

async function main(): Promise<void> {
  const { command, options } = parseArgv(process.argv.slice(2));
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
    runDoctor(options);
    return;
  }

  if (normalized === "catalog") {
    runCatalog(options);
    return;
  }

  printHelp();
}

main().catch((error) => {
  process.stderr.write(`ICA CLI failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
