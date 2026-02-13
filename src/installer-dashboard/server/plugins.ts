import { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from "fastify";
import { InstallRequest, ResolvedTargetPath, TargetOperationReport } from "../../installer-core/types";
import { ExecuteOperationHooks, InstallHookContext, PostInstallHookContext } from "../../installer-core/executor";

export interface Capability {
  id: string;
  title: string;
  enabled: boolean;
}

export interface PluginScopedApp {
  route(options: Omit<RouteOptions, "url"> & { url: string }): void;
  get(url: string, handler: (request: FastifyRequest, reply: FastifyReply) => unknown): void;
  post(url: string, handler: (request: FastifyRequest, reply: FastifyReply) => unknown): void;
  patch(url: string, handler: (request: FastifyRequest, reply: FastifyReply) => unknown): void;
  put(url: string, handler: (request: FastifyRequest, reply: FastifyReply) => unknown): void;
  delete(url: string, handler: (request: FastifyRequest, reply: FastifyReply) => unknown): void;
}

type DashboardBeforeInstallHook = (context: InstallHookContext) => Promise<void> | void;
type DashboardAfterInstallHook = (context: PostInstallHookContext) => Promise<void> | void;

export interface DashboardServerPluginContext {
  id: string;
  mountPath: string;
  app: FastifyInstance;
  scopedApp: PluginScopedApp;
  config: Record<string, unknown>;
  capabilities: {
    add(capability: Capability): void;
  };
  hooks: {
    onBeforeInstall(handler: DashboardBeforeInstallHook): void;
    onAfterInstall(handler: DashboardAfterInstallHook): void;
  };
}

export interface DashboardServerPlugin {
  id: string;
  register(context: DashboardServerPluginContext): Promise<void> | void;
}

export type DashboardServerPluginRegistry = Record<string, DashboardServerPlugin>;

export interface DashboardServerPluginRuntime {
  loadedPluginIds: string[];
  capabilities: Capability[];
  installHooks: ExecuteOperationHooks;
}

function normalizePluginUrlPath(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed === "/") return "";
  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return normalized.replace(/\/+$/g, "");
}

function buildScopedRoutePath(mountPath: string, url: string): string {
  const normalizedPath = normalizePluginUrlPath(url);
  return `${mountPath}${normalizedPath}`;
}

function createScopedApp(app: FastifyInstance, mountPath: string): PluginScopedApp {
  return {
    route(options) {
      const { url, ...rest } = options;
      app.route({
        ...rest,
        url: buildScopedRoutePath(mountPath, url),
      });
    },
    get(url, handler) {
      app.route({
        method: "GET",
        url: buildScopedRoutePath(mountPath, url),
        handler,
      });
    },
    post(url, handler) {
      app.route({
        method: "POST",
        url: buildScopedRoutePath(mountPath, url),
        handler,
      });
    },
    patch(url, handler) {
      app.route({
        method: "PATCH",
        url: buildScopedRoutePath(mountPath, url),
        handler,
      });
    },
    put(url, handler) {
      app.route({
        method: "PUT",
        url: buildScopedRoutePath(mountPath, url),
        handler,
      });
    },
    delete(url, handler) {
      app.route({
        method: "DELETE",
        url: buildScopedRoutePath(mountPath, url),
        handler,
      });
    },
  };
}

export function parseEnabledDashboardPlugins(value: string | undefined): string[] {
  if (!value) return [];
  const parsed = value
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  return Array.from(new Set(parsed));
}

export async function loadDashboardServerPlugins(params: {
  app: FastifyInstance;
  enabledPluginIds: string[];
  registry: DashboardServerPluginRegistry;
  pluginConfigs?: Record<string, Record<string, unknown>>;
}): Promise<DashboardServerPluginRuntime> {
  const { app, enabledPluginIds, registry, pluginConfigs } = params;
  const capabilityMap = new Map<string, Capability>();
  const beforeInstallHandlers: DashboardBeforeInstallHook[] = [];
  const afterInstallHandlers: DashboardAfterInstallHook[] = [];
  const loadedPluginIds: string[] = [];

  for (const pluginId of enabledPluginIds) {
    const plugin = registry[pluginId];
    if (!plugin) continue;
    const mountPath = `/api/v1/plugins/${plugin.id}`;
    const context: DashboardServerPluginContext = {
      id: plugin.id,
      mountPath,
      app,
      scopedApp: createScopedApp(app, mountPath),
      config: pluginConfigs?.[plugin.id] || {},
      capabilities: {
        add(capability) {
          capabilityMap.set(capability.id, capability);
        },
      },
      hooks: {
        onBeforeInstall(handler) {
          beforeInstallHandlers.push(handler);
        },
        onAfterInstall(handler) {
          afterInstallHandlers.push(handler);
        },
      },
    };
    await plugin.register(context);
    loadedPluginIds.push(plugin.id);
  }

  return {
    loadedPluginIds,
    capabilities: Array.from(capabilityMap.values()).sort((a, b) => a.id.localeCompare(b.id)),
    installHooks: {
      async onBeforeInstall(context: InstallHookContext): Promise<void> {
        for (const handler of beforeInstallHandlers) {
          await handler(context);
        }
      },
      async onAfterInstall(context: PostInstallHookContext): Promise<void> {
        for (const handler of afterInstallHandlers) {
          await handler(context);
        }
      },
    },
  };
}

export function parseDashboardPluginConfig(value: string | undefined): Record<string, Record<string, unknown>> {
  if (!value || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const normalized: Record<string, Record<string, unknown>> = {};
    for (const [pluginId, config] of Object.entries(parsed)) {
      if (config && typeof config === "object" && !Array.isArray(config)) {
        normalized[pluginId] = config as Record<string, unknown>;
      }
    }
    return normalized;
  } catch {
    return {};
  }
}

export function mergeCapabilities(base: Capability[], contributed: Capability[]): Capability[] {
  const map = new Map<string, Capability>();
  for (const capability of base) {
    map.set(capability.id, capability);
  }
  for (const capability of contributed) {
    map.set(capability.id, capability);
  }
  return Array.from(map.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export function createInstallHookContext(input: {
  repoRoot: string;
  request: InstallRequest;
  resolvedTarget: ResolvedTargetPath;
}): InstallHookContext {
  return {
    repoRoot: input.repoRoot,
    request: input.request,
    resolvedTarget: input.resolvedTarget,
  };
}

export function createPostInstallHookContext(input: {
  repoRoot: string;
  request: InstallRequest;
  resolvedTarget: ResolvedTargetPath;
  report: TargetOperationReport;
}): PostInstallHookContext {
  return {
    repoRoot: input.repoRoot,
    request: input.request,
    resolvedTarget: input.resolvedTarget,
    report: input.report,
  };
}
