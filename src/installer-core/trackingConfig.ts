import path from "node:path";

export type TrackingProvider = "github" | "file-based" | "linear" | "jira";

export interface TrackingConfig {
  issue_tracking?: {
    enabled?: boolean;
    provider?: TrackingProvider | string;
  };
  tdd?: {
    enabled?: boolean;
  };
  [key: string]: unknown;
}

export interface TrackingConfigDependencies {
  cwd: string;
  icaHome?: string;
  homeDir: string;
  pathExists: (targetPath: string) => Promise<boolean>;
  readText: (targetPath: string) => Promise<string>;
}

export interface EnsureTrackingConfigDependencies extends TrackingConfigDependencies {
  writeText: (targetPath: string, content: string) => Promise<void>;
}

export interface ResolveTrackingConfigOptions {
  detectGithub?: () => boolean | Promise<boolean>;
}

export interface EnsureTrackingConfigOptions extends ResolveTrackingConfigOptions {
  prompts?: {
    selectScope?: (context: { projectConfigPath: string; existingSystemConfigPath: string | null }) => Promise<"project" | "system">;
    selectProvider?: (context: { defaultProvider: TrackingProvider; targetScope: "project" | "system" }) => Promise<TrackingProvider>;
  };
}

export interface EnsureTddPreferenceOptions {
  resolution: TrackingConfigResolution;
  tddSkillActive: boolean;
  prompts?: {
    selectDefaultEnabled?: (context: { path: string | null; currentDefault: boolean | null }) => Promise<boolean>;
    selectApplyForScope?: (context: { defaultEnabled: boolean }) => Promise<boolean>;
  };
}

export interface TddPreferenceResolution {
  defaultEnabled: boolean;
  applyForScope: boolean;
  persistedDefault: boolean;
}

export interface TrackingConfigResolution {
  source: "project" | "system" | "agent-home" | "none";
  path: string | null;
  config: TrackingConfig | null;
  missingConfig: boolean;
  fallbackProvider: TrackingProvider;
  diagnostics: string[];
}

function normalizeProvider(value: unknown): TrackingProvider | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "github") return "github";
  if (normalized === "file-based") return "file-based";
  if (normalized === "linear") return "linear";
  if (normalized === "jira") return "jira";
  return null;
}

function getDefaultFallbackProvider(githubAvailable: boolean): TrackingProvider {
  return githubAvailable ? "github" : "file-based";
}

function candidatePaths(deps: TrackingConfigDependencies): Array<{ path: string; source: "project" | "system" | "agent-home" }> {
  const candidates: Array<{ path: string; source: "project" | "system" | "agent-home" }> = [];
  candidates.push({
    path: path.resolve(deps.cwd, ".agent", "tracking.config.json"),
    source: "project",
  });

  if (deps.icaHome && deps.icaHome.trim().length > 0) {
    candidates.push({
      path: path.resolve(deps.icaHome, "tracking.config.json"),
      source: "system",
    });
  }

  candidates.push({
    path: path.resolve(deps.homeDir, ".codex", "tracking.config.json"),
    source: "agent-home",
  });
  candidates.push({
    path: path.resolve(deps.homeDir, ".claude", "tracking.config.json"),
    source: "agent-home",
  });
  return candidates;
}

function defaultSystemConfigPath(deps: TrackingConfigDependencies): string {
  if (deps.icaHome && deps.icaHome.trim().length > 0) {
    return path.resolve(deps.icaHome, "tracking.config.json");
  }
  return path.resolve(deps.homeDir, ".codex", "tracking.config.json");
}

async function detectGithubDefault(options?: ResolveTrackingConfigOptions): Promise<boolean> {
  if (!options?.detectGithub) return false;
  return Boolean(await options.detectGithub());
}

function createDefaultTrackingConfig(provider: TrackingProvider): TrackingConfig {
  return {
    issue_tracking: {
      enabled: true,
      provider,
    },
    tdd: {
      enabled: false,
    },
  };
}

export async function resolveTrackingConfig(
  deps: TrackingConfigDependencies,
  options?: ResolveTrackingConfigOptions,
): Promise<TrackingConfigResolution> {
  const diagnostics: string[] = [];
  const candidates = candidatePaths(deps);
  for (const candidate of candidates) {
    if (!(await deps.pathExists(candidate.path))) continue;

    let parsed: TrackingConfig | null = null;
    try {
      const raw = await deps.readText(candidate.path);
      parsed = raw.trim().length > 0 ? (JSON.parse(raw) as TrackingConfig) : {};
    } catch {
      diagnostics.push(`Invalid JSON at ${candidate.path}`);
      parsed = null;
    }

    const issueTrackingEnabled = parsed?.issue_tracking?.enabled !== false;
    const configProvider = normalizeProvider(parsed?.issue_tracking?.provider);
    const fallbackProvider =
      !issueTrackingEnabled
        ? "file-based"
        : configProvider || getDefaultFallbackProvider(await detectGithubDefault(options));

    return {
      source: candidate.source,
      path: candidate.path,
      config: parsed,
      missingConfig: false,
      fallbackProvider,
      diagnostics,
    };
  }

  return {
    source: "none",
    path: null,
    config: null,
    missingConfig: true,
    fallbackProvider: getDefaultFallbackProvider(await detectGithubDefault(options)),
    diagnostics,
  };
}

export async function ensureTrackingConfig(
  deps: EnsureTrackingConfigDependencies,
  options?: EnsureTrackingConfigOptions,
): Promise<TrackingConfigResolution> {
  const projectConfigPath = path.resolve(deps.cwd, ".agent", "tracking.config.json");
  const resolution = await resolveTrackingConfig(deps, options);
  if (resolution.source === "project") {
    return resolution;
  }

  const projectExists = await deps.pathExists(projectConfigPath);
  if (projectExists) {
    return resolution;
  }

  if (resolution.source !== "none") {
    const selectedScope = options?.prompts?.selectScope
      ? await options.prompts.selectScope({
          projectConfigPath,
          existingSystemConfigPath: resolution.path,
        })
      : "system";
    if (selectedScope === "system") {
      return resolution;
    }

    const targetProvider = options?.prompts?.selectProvider
      ? await options.prompts.selectProvider({
          defaultProvider: resolution.fallbackProvider,
          targetScope: "project",
        })
      : resolution.fallbackProvider;
    const nextConfig = createDefaultTrackingConfig(targetProvider);
    await deps.writeText(projectConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
    return {
      source: "project",
      path: projectConfigPath,
      config: nextConfig,
      missingConfig: false,
      fallbackProvider: targetProvider,
      diagnostics: [...resolution.diagnostics, "Created project tracking config"],
    };
  }

  const systemConfigPath = defaultSystemConfigPath(deps);
  const targetProvider = options?.prompts?.selectProvider
    ? await options.prompts.selectProvider({
        defaultProvider: resolution.fallbackProvider,
        targetScope: "system",
      })
    : resolution.fallbackProvider;
  const nextConfig = createDefaultTrackingConfig(targetProvider);
  await deps.writeText(systemConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  return {
    source: "system",
    path: systemConfigPath,
    config: nextConfig,
    missingConfig: false,
    fallbackProvider: targetProvider,
    diagnostics: [...resolution.diagnostics, "Created system tracking config"],
  };
}

export async function ensureTddPreference(
  deps: EnsureTrackingConfigDependencies,
  options: EnsureTddPreferenceOptions,
): Promise<TddPreferenceResolution> {
  const resolution = options.resolution;
  const currentDefault = typeof resolution.config?.tdd?.enabled === "boolean" ? resolution.config.tdd.enabled : null;
  let defaultEnabled = currentDefault ?? false;
  let persistedDefault = false;

  if (options.tddSkillActive && currentDefault === null) {
    defaultEnabled = options.prompts?.selectDefaultEnabled
      ? await options.prompts.selectDefaultEnabled({
          path: resolution.path,
          currentDefault,
        })
      : false;

    if (resolution.path) {
      const nextConfig: TrackingConfig = {
        ...(resolution.config || {}),
        tdd: {
          enabled: defaultEnabled,
        },
      };
      await deps.writeText(resolution.path, `${JSON.stringify(nextConfig, null, 2)}\n`);
      resolution.config = nextConfig;
      persistedDefault = true;
    }
  }

  const applyForScope = options.tddSkillActive
    ? options.prompts?.selectApplyForScope
      ? await options.prompts.selectApplyForScope({ defaultEnabled })
      : defaultEnabled
    : false;

  return {
    defaultEnabled,
    applyForScope,
    persistedDefault,
  };
}

export async function updateTrackingProvider(
  deps: EnsureTrackingConfigDependencies,
  configPath: string,
  provider: TrackingProvider,
): Promise<TrackingConfig> {
  let current: TrackingConfig = {};
  try {
    const raw = await deps.readText(configPath);
    current = raw.trim().length > 0 ? (JSON.parse(raw) as TrackingConfig) : {};
  } catch {
    current = {};
  }

  const next: TrackingConfig = {
    ...current,
    issue_tracking: {
      enabled: true,
      ...(current.issue_tracking || {}),
      provider,
    },
    tdd: {
      enabled: current.tdd?.enabled ?? false,
    },
  };
  await deps.writeText(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
