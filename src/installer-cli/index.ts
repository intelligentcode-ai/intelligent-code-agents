#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { refreshSourcesAndHooks } from "../installer-core/sourceRefresh";
import { loadInstallState } from "../installer-core/state";
import { parseTargets, resolveTargetPaths } from "../installer-core/targets";
import { checkForAppUpdate } from "../installer-core/updateCheck";
import { findRepoRoot } from "../installer-core/repo";
import { InstallMode, InstallRequest, InstallScope, InstallSelection, OperationKind, TargetPlatform } from "../installer-core/types";

interface ParsedArgs {
  command: string;
  options: Record<string, string | boolean>;
  positionals: string[];
}

const execFileAsync = promisify(execFile);
const DEFAULT_DASHBOARD_IMAGE = "ghcr.io/intelligentcode-ai/ica-installer-dashboard:main";

export type ServeImageBuildMode = "auto" | "always" | "never";
export type ServeReusePortsMode = boolean;

export function redactCliErrorMessage(message: string): string {
  return message
    .replace(/(ICA_(?:UI_)?API_KEY=)[^\s]+/g, "$1[REDACTED]")
    .replace(/(--(?:token|api-key)=)[^\s]+/g, "$1[REDACTED]")
    .replace(/(x-ica-api-key["']?\s*[:=]\s*["']?)[^"',\s]+/gi, "$1[REDACTED]");
}

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

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["--version"], { maxBuffer: 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function isLoopbackPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function getListeningPids(port: number): Promise<number[]> {
  const pids = new Set<number>();

  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], { maxBuffer: 4 * 1024 * 1024 });
      const lines = stdout.split(/\r?\n/);
      const matcher = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "i");
      for (const line of lines) {
        const match = line.match(matcher);
        if (!match) continue;
        const pid = Number.parseInt(match[1], 10);
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
          pids.add(pid);
        }
      }
      return Array.from(pids);
    }

    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { maxBuffer: 1024 * 1024 });
    for (const line of stdout.split(/\r?\n/)) {
      const pid = Number.parseInt(line.trim(), 10);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        pids.add(pid);
      }
    }
  } catch {
    return [];
  }

  return Array.from(pids);
}

function canSignalPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPortAvailable(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isLoopbackPortAvailable(port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return await isLoopbackPortAvailable(port);
}

async function reclaimLoopbackPort(port: number, flagName: "ui-port" | "api-port"): Promise<void> {
  if (await isLoopbackPortAvailable(port)) {
    return;
  }

  const pids = await getListeningPids(port);
  if (pids.length === 0) {
    throw new Error(
      `Requested --${flagName}=${port} is in use, but ICA could not identify the owning process to stop it automatically.`,
    );
  }

  output.write(`Notice: ${flagName} ${port} is busy; stopping existing process on that port.\n`);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore individual process signal failures
    }
  }

  if (await waitForPortAvailable(port, 2000)) {
    return;
  }

  for (const pid of pids) {
    if (!canSignalPid(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore individual process signal failures
    }
  }

  if (await waitForPortAvailable(port, 1500)) {
    return;
  }

  throw new Error(`Requested --${flagName}=${port} is still in use after attempting to stop the existing process.`);
}

export function parseServeImageBuildMode(rawValue: string): ServeImageBuildMode {
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "auto" || normalized === "always" || normalized === "never") {
    return normalized;
  }
  throw new Error(`Invalid --build-image value '${rawValue}'. Supported: auto|always|never`);
}

export function parseServeReusePorts(rawValue: string): ServeReusePortsMode {
  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid --reuse-ports value '${rawValue}'. Supported: true|false`);
}

export function parseServeRefreshMinutes(rawValue: string): number {
  const trimmed = rawValue.trim();
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --sources-refresh-minutes value '${rawValue}'. Use 0 to disable or a positive number.`);
  }
  return Math.floor(parsed);
}

export function shouldBuildDashboardImage(input: {
  mode: ServeImageBuildMode;
  image: string;
  imageExists: boolean;
  defaultImage: string;
}): boolean {
  if (input.mode === "always") {
    return true;
  }
  if (input.mode === "never") {
    return false;
  }
  if (input.imageExists) {
    return false;
  }
  if (input.image.trim().toLowerCase().startsWith("ghcr.io/")) {
    return false;
  }
  return input.image === input.defaultImage;
}

export function shouldFallbackToSourceBuild(pullErrorMessage: string): boolean {
  const normalized = pullErrorMessage.toLowerCase();
  return (
    normalized.includes("no matching manifest") ||
    normalized.includes("no match for platform in manifest") ||
    normalized.includes("manifest unknown") ||
    normalized.includes("manifest not found") ||
    normalized.includes("not found: manifest")
  );
}

function toDockerRunArgs(base: {
  containerName: string;
  image: string;
  env?: string[];
  ports?: string[];
}): string[] {
  const args: string[] = ["run", "-d", "--name", base.containerName];
  for (const envItem of base.env || []) {
    args.push("-e", envItem);
  }
  for (const port of base.ports || []) {
    args.push("-p", port);
  }
  args.push(base.image);
  return args;
}

async function allocateLoopbackPort(input: {
  preferredPort: number;
  explicit: boolean;
  flagName: "ui-port" | "api-port";
  blockedPorts?: Set<number>;
}): Promise<number> {
  const blocked = input.blockedPorts || new Set<number>();
  if (!blocked.has(input.preferredPort) && (await isLoopbackPortAvailable(input.preferredPort))) {
    return input.preferredPort;
  }
  if (input.explicit) {
    throw new Error(`Requested --${input.flagName}=${input.preferredPort} is unavailable. Choose a different port.`);
  }
  for (let candidate = input.preferredPort + 1; candidate <= Math.min(65535, input.preferredPort + 100); candidate += 1) {
    if (blocked.has(candidate)) {
      continue;
    }
    if (await isLoopbackPortAvailable(candidate)) {
      output.write(`Notice: ${input.flagName} ${input.preferredPort} is busy; using ${candidate}.\n`);
      return candidate;
    }
  }
  throw new Error(`Unable to find a free localhost port for --${input.flagName} near ${input.preferredPort}.`);
}

async function waitForApiReady(port: number, apiKey: string, retries = 40): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        headers: { "x-ica-api-key": apiKey },
      });
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("ICA API did not become ready in time.");
}

async function waitForHttpReady(url: string, retries = 40): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Service did not become ready in time: ${url}`);
}

async function dockerInspect(containerName: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["inspect", containerName], { maxBuffer: 8 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function reclaimDockerPublishedPort(port: number, expectedContainerName: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "--filter", `publish=${port}`, "--format", "{{.ID}} {{.Names}}"],
      {
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const ids = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      return 0;
    }
    let removed = 0;
    for (const row of ids) {
      const [id, name] = row.split(/\s+/, 2);
      if (!id || !name || name !== expectedContainerName) {
        continue;
      }
      await execFileAsync("docker", ["rm", "-f", id], { maxBuffer: 8 * 1024 * 1024 });
      removed += 1;
    }
    return removed;
  } catch {
    return 0;
  }
}

async function dockerImageExists(image: string): Promise<boolean> {
  try {
    await execFileAsync("docker", ["image", "inspect", image], { maxBuffer: 8 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function ensureDashboardImage(options: {
  repoRoot: string;
  image: string;
  mode: ServeImageBuildMode;
  defaultImage: string;
}): Promise<void> {
  const dockerfilePath = path.join(options.repoRoot, "src", "installer-dashboard", "Dockerfile");
  const buildFromSource = async (): Promise<void> => {
    if (!fs.existsSync(dockerfilePath)) {
      throw new Error(`Dashboard Dockerfile not found at ${dockerfilePath}. Provide --image=<image> or run with --build-image=never.`);
    }
    output.write(`Building dashboard image '${options.image}' from source...\n`);
    await execFileAsync("docker", ["build", "-f", dockerfilePath, "-t", options.image, options.repoRoot], { maxBuffer: 16 * 1024 * 1024 });
    output.write(`Built dashboard image '${options.image}'.\n`);
  };

  const imageExists = await dockerImageExists(options.image);
  const shouldBuild = shouldBuildDashboardImage({
    mode: options.mode,
    image: options.image,
    imageExists,
    defaultImage: options.defaultImage,
  });
  if (!shouldBuild) {
    if (!imageExists && options.image.trim().toLowerCase().startsWith("ghcr.io/")) {
      output.write(`Pulling dashboard image '${options.image}'...\n`);
      try {
        await execFileAsync("docker", ["pull", options.image], { maxBuffer: 16 * 1024 * 1024 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const canFallback = options.mode !== "never" && fs.existsSync(dockerfilePath) && shouldFallbackToSourceBuild(message);
        if (!canFallback) {
          throw error;
        }
        output.write("Dashboard image pull failed for this platform; falling back to source build.\n");
        await buildFromSource();
      }
    }
    return;
  }
  await buildFromSource();
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
  output.write(
    `  ica serve [--host=127.0.0.1] [--ui-port=4173] [--api-port=4174] [--reuse-ports=true|false] [--open=true|false] [--image=ghcr.io/intelligentcode-ai/ica-installer-dashboard:main] [--build-image=auto|always|never]\n`,
  );
  output.write(`  ica launch (alias for serve; deprecated)\n\n`);
  output.write(`  Note: repository registration is unified. Adding one source auto-registers both skills and hooks mirrors.\n\n`);
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
  output.write(`  --refresh (for catalog: force live source refresh)\n`);
  output.write(`  --sources-refresh-minutes=60 (serve only; set 0 to disable periodic source refresh)\n`);
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

async function maybePrintUpdateNotifier(repoRoot: string, options: Record<string, string | boolean>): Promise<void> {
  if (boolOption(options, "json", false)) {
    return;
  }
  const currentVersion = resolveInstallerVersion(repoRoot);
  const update = await checkForAppUpdate(currentVersion);
  if (!update.updateAvailable || !update.latestVersion) {
    return;
  }
  const targetVersion = update.latestVersion.replace(/^v/i, "");
  const link = update.latestReleaseUrl || "https://github.com/intelligentcode-ai/intelligent-code-agents/releases/latest";
  output.write(`Update available: ICA ${targetVersion} (current ${currentVersion}). ${link}\n`);
}

async function refreshSourcesOnCliStart(): Promise<void> {
  try {
    const result = await refreshSourcesAndHooks({
      credentials: createCredentialProvider(),
      loadSources,
      loadHookSources,
      syncSource,
      syncHookSource,
    });
    const errors = result.refreshed.flatMap((entry) => [entry.skills?.error, entry.hooks?.error]).filter((item): item is string => Boolean(item));
    if (errors.length > 0) {
      output.write(`Warning: startup source refresh completed with ${errors.length} error(s).\n`);
    }
  } catch (error) {
    output.write(`Warning: startup source refresh failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }
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
  return normalized === "127.0.0.1" || normalized === "localhost";
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
  const refresh = boolOption(options, "refresh", false);
  const catalog = await loadCatalogFromSources(repoRoot, refresh);
  if (boolOption(options, "json", false)) {
    output.write(`${JSON.stringify(catalog, null, 2)}\n`);
    return;
  }

  output.write(`Catalog version: ${catalog.version}\n`);
  output.write(`Generated at: ${catalog.generatedAt}\n`);
  output.write(`Source: ${catalog.catalogSource || "live"}\n`);
  if (catalog.stale) {
    output.write(`Stale: yes\n`);
    if (catalog.staleReason) {
      output.write(`Reason: ${catalog.staleReason}\n`);
    }
  } else {
    output.write(`Stale: no\n`);
  }
  if (typeof catalog.cacheAgeSeconds === "number") {
    output.write(`Cache age: ${catalog.cacheAgeSeconds}s\n`);
  }
  if (catalog.nextRefreshAt) {
    output.write(`Next refresh: ${catalog.nextRefreshAt}\n`);
  }
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
    const result = await refreshSourcesAndHooks(
      {
        credentials: credentialProvider,
        loadSources,
        loadHookSources,
        syncSource,
        syncHookSource,
      },
      { sourceId, onlyEnabled: true },
    );
    if (!result.matched) {
      throw new Error(sourceId ? `Unknown source '${sourceId}'` : "No enabled sources found.");
    }
    const refreshed = result.refreshed.map((item) => ({
      id: item.sourceId,
      skills: item.skills,
      hooks: item.hooks,
    }));
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

async function runServe(options: Record<string, string | boolean>): Promise<void> {
  const repoRoot = findRepoRoot(__dirname);
  const host = stringOption(options, "host", "127.0.0.1").trim() || "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(`Refusing non-loopback host '${host}'. The ICA API is localhost-only.`);
  }
  const uiPortInput = Number(stringOption(options, "ui-port", stringOption(options, "port", "4173")).trim() || "4173");
  const apiPortInput = Number(stringOption(options, "api-port", "4174").trim() || "4174");
  if (!Number.isInteger(uiPortInput) || uiPortInput <= 0) {
    throw new Error("Invalid --ui-port value.");
  }
  if (!Number.isInteger(apiPortInput) || apiPortInput <= 0) {
    throw new Error("Invalid --api-port value.");
  }
  const uiPortExplicit = options["ui-port"] !== undefined || options.port !== undefined;
  const apiPortExplicit = options["api-port"] !== undefined;
  const reusePorts = parseServeReusePorts(stringOption(options, "reuse-ports", process.env.ICA_REUSE_PORTS || "true"));
  if (uiPortInput === apiPortInput) {
    throw new Error("API and UI ports must be different. Choose distinct --api-port and --ui-port values.");
  }
  const containerName = stringOption(options, "container-name", process.env.ICA_DASHBOARD_CONTAINER_NAME || "ica-dashboard");
  const image = stringOption(options, "image", process.env.ICA_DASHBOARD_IMAGE || DEFAULT_DASHBOARD_IMAGE);
  const buildMode = parseServeImageBuildMode(stringOption(options, "build-image", process.env.ICA_DASHBOARD_BUILD_IMAGE || "auto"));
  const sourcesRefreshMinutes = parseServeRefreshMinutes(
    stringOption(options, "sources-refresh-minutes", process.env.ICA_SOURCE_REFRESH_INTERVAL_MINUTES || "60"),
  );
  if (!(await commandExists("docker"))) {
    throw new Error("Docker CLI is not available.");
  }
  if (await dockerInspect(containerName)) {
    await execFileAsync("docker", ["rm", "-f", containerName], { maxBuffer: 8 * 1024 * 1024 });
  }

  let apiPort = apiPortInput;
  let uiPort = uiPortInput;
  let uiContainerPort = 0;
  if (reusePorts) {
    await reclaimLoopbackPort(apiPort, "api-port");
    await reclaimLoopbackPort(uiPort, "ui-port");
  } else {
    apiPort = await allocateLoopbackPort({
      preferredPort: apiPortInput,
      explicit: apiPortExplicit,
      flagName: "api-port",
    });
    uiPort = await allocateLoopbackPort({
      preferredPort: uiPortInput,
      explicit: uiPortExplicit,
      flagName: "ui-port",
      blockedPorts: new Set([apiPort]),
    });
  }
  const preferredInternalUiPort = Math.max(uiPort, apiPort) + 1;
  if (reusePorts) {
    uiContainerPort = preferredInternalUiPort;
    await reclaimDockerPublishedPort(uiContainerPort, containerName);
    if (!(await isLoopbackPortAvailable(uiContainerPort))) {
      throw new Error(
        `Requested internal dashboard port ${uiContainerPort} is in use by another process. Choose a different --ui-port.`,
      );
    }
  } else {
    uiContainerPort = await allocateLoopbackPort({
      preferredPort: preferredInternalUiPort,
      explicit: false,
      flagName: "ui-port",
      blockedPorts: new Set([apiPort, uiPort]),
    });
  }

  const apiScript = path.join(repoRoot, "dist", "src", "installer-api", "server", "index.js");
  const bffScript = path.join(repoRoot, "dist", "src", "installer-bff", "server", "index.js");
  if (!fs.existsSync(apiScript)) {
    throw new Error("ICA API runtime is not built. Run: npm run build");
  }
  if (!fs.existsSync(bffScript)) {
    throw new Error("ICA dashboard BFF runtime is not built. Run: npm run build");
  }
  const apiKey = crypto.randomBytes(24).toString("hex");
  const hostForUrl = host.includes(":") ? `[${host}]` : host;
  const apiBaseUrl = `http://${hostForUrl}:${apiPort}`;
  const staticOrigin = `http://${hostForUrl}:${uiContainerPort}`;
  const dashboardUrl = `http://${hostForUrl}:${uiPort}`;
  const open = boolOption(options, "open", false);

  await ensureDashboardImage({
    repoRoot,
    image,
    mode: buildMode,
    defaultImage: DEFAULT_DASHBOARD_IMAGE,
  });

  const apiProcess = spawn(process.execPath, [apiScript], {
    stdio: "inherit",
    env: {
      ...process.env,
      ICA_API_HOST: "127.0.0.1",
      ICA_API_PORT: String(apiPort),
      ICA_API_KEY: apiKey,
      ICA_UI_PORT: String(uiPort),
      ICA_SOURCE_REFRESH_INTERVAL_MINUTES: String(sourcesRefreshMinutes),
    },
  });
  let shutdownRequested = false;
  let containerStarted = false;
  let bffStarted = false;
  let apiProcessError: Error | null = null;
  let bffProcessError: Error | null = null;
  apiProcess.once("error", (error) => {
    apiProcessError = error;
    shutdownRequested = true;
  });
  const bffProcess = spawn(process.execPath, [bffScript], {
    stdio: "inherit",
    env: {
      ...process.env,
      ICA_BFF_HOST: "127.0.0.1",
      ICA_BFF_PORT: String(uiPort),
      ICA_BFF_STATIC_ORIGIN: `http://127.0.0.1:${uiContainerPort}`,
      ICA_BFF_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
      ICA_BFF_API_KEY: apiKey,
    },
  });
  bffProcess.once("error", (error) => {
    bffProcessError = error;
    shutdownRequested = true;
  });

  const shutdown = async (): Promise<void> => {
    if (!shutdownRequested) {
      shutdownRequested = true;
    }
    if (containerStarted) {
      try {
        await execFileAsync("docker", ["rm", "-f", containerName], { maxBuffer: 8 * 1024 * 1024 });
      } catch {
        // ignore cleanup failure
      }
    }
    if (apiProcess.exitCode === null && !apiProcess.killed) {
      apiProcess.kill("SIGTERM");
    }
    if (bffProcess.exitCode === null && !bffProcess.killed) {
      bffProcess.kill("SIGTERM");
    }
  };

  try {
    await waitForApiReady(apiPort, apiKey);
    const runArgs = toDockerRunArgs({
      containerName,
      image,
      ports: [`127.0.0.1:${uiContainerPort}:80`],
    });
    const dockerRunResult = await execFileAsync("docker", runArgs, { maxBuffer: 8 * 1024 * 1024 });
    containerStarted = true;
    await waitForHttpReady(`http://127.0.0.1:${uiContainerPort}/`);
    await waitForHttpReady(`http://127.0.0.1:${uiPort}/health`);
    bffStarted = true;

    output.write(`ICA dashboard listening at ${dashboardUrl}\n`);
    output.write(`Dashboard proxy: http://${hostForUrl}:${uiPort} -> ${staticOrigin} + ${apiBaseUrl}\n`);
    output.write(`Container: ${containerName} (${(dockerRunResult.stdout || "").trim()})\n`);
    output.write(
      sourcesRefreshMinutes > 0
        ? `Source auto-refresh: every ${sourcesRefreshMinutes} minute(s)\n`
        : "Source auto-refresh: disabled\n",
    );
    if (open) {
      openBrowser(dashboardUrl);
    }

    const requestShutdown = (): void => {
      shutdownRequested = true;
    };
    process.once("SIGINT", requestShutdown);
    process.once("SIGTERM", requestShutdown);

    while (!shutdownRequested) {
      if (apiProcess.exitCode !== null) {
        throw new Error(`ICA API process exited with code ${apiProcess.exitCode}`);
      }
      if (bffProcess.exitCode !== null) {
        throw new Error(`ICA dashboard BFF process exited with code ${bffProcess.exitCode}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (apiProcessError) {
      throw apiProcessError;
    }
    if (bffProcessError) {
      throw bffProcessError;
    }
    if (!bffStarted) {
      throw new Error("ICA dashboard BFF did not start correctly.");
    }
    await shutdown();
  } catch (error) {
    await shutdown();
    throw error;
  }
}

async function runLaunch(options: Record<string, string | boolean>): Promise<void> {
  output.write("Deprecation notice: `ica launch` is now an alias of `ica serve` and will be removed in a future release.\n");
  await runServe(options);
}

async function main(): Promise<void> {
  const { command, options, positionals } = parseArgv(process.argv.slice(2));
  const normalized = command.toLowerCase();
  const repoRoot = findRepoRoot(__dirname);

  if (normalized !== "help") {
    await refreshSourcesOnCliStart();
    await maybePrintUpdateNotifier(repoRoot, options);
  }

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

  if (normalized === "serve") {
    await runServe(options);
    return;
  }

  if (normalized === "launch") {
    await runLaunch(options);
    return;
  }

  printHelp();
}

if (require.main === module) {
  main().catch((error) => {
    const rawMessage = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ICA CLI failed: ${redactCliErrorMessage(rawMessage)}\n`);
    process.exitCode = 1;
  });
}
