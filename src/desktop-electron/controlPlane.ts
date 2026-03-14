import crypto from "node:crypto";
import { createInstallerDashboardServer } from "../installer-dashboard/server/index";
import { createInstallerApplicationService, type InstallerApplicationService } from "../installer-core/applicationService";
import { findRepoRoot } from "../installer-core/repo";
import type { RealtimeChannel, RealtimeEvent, RealtimeEventType } from "../installer-api/server/realtime";
import type { DesktopBridgeRequestMap, DesktopBridgeResponseMap, DesktopHostFailureReport, DesktopRuntimeInfo } from "./bridge";

export interface DesktopControlPlane {
  request(payload: DesktopBridgeRequestMap["control-plane.request"]): Promise<DesktopBridgeResponseMap["control-plane.request"]>;
  subscribeRealtime(listener: (event: RealtimeEvent) => void): () => void;
  pickProjectDirectory(initialPath?: string): Promise<{ path: string }>;
  pickPublishDirectory(initialPath?: string): Promise<{ path: string }>;
  getRuntimeInfo(): Promise<DesktopRuntimeInfo>;
  reportRendererFailure(payload: DesktopHostFailureReport): Promise<void>;
  close(): Promise<void>;
}

export interface CreateDesktopControlPlaneOptions {
  repoRoot?: string;
  applicationService?: Partial<InstallerApplicationService>;
}

export interface OperationDescriptor {
  channel: RealtimeChannel;
  started: RealtimeEventType;
  completed: RealtimeEventType;
  failed: RealtimeEventType;
  payload: Record<string, unknown>;
}

function buildRealtimeEvent(
  channel: RealtimeChannel,
  type: RealtimeEventType,
  payload: Record<string, unknown> = {},
  opId?: string,
): RealtimeEvent {
  return {
    id: `evt_${crypto.randomUUID()}`,
    ts: new Date().toISOString(),
    channel,
    type,
    opId,
    payload,
  };
}

function parseJsonBody<T extends Record<string, unknown>>(value: unknown): T {
  if (!value || typeof value !== "object") {
    return {} as T;
  }
  return value as T;
}

export function describeDesktopOperation(payload: DesktopBridgeRequestMap["control-plane.request"]): OperationDescriptor | null {
  const method = (payload.method || "GET").toUpperCase();
  const body = parseJsonBody(payload.body);

  if (method === "POST" && payload.pathname === "/api/v1/install/apply") {
    return {
      channel: "operation",
      started: "operation.started",
      completed: "operation.completed",
      failed: "operation.failed",
      payload: {
        operation: "install",
        targets: Array.isArray(body.targets) ? body.targets : [],
      },
    };
  }

  if (method === "POST" && payload.pathname === "/api/v1/uninstall/apply") {
    return {
      channel: "operation",
      started: "operation.started",
      completed: "operation.completed",
      failed: "operation.failed",
      payload: {
        operation: "uninstall",
        targets: Array.isArray(body.targets) ? body.targets : [],
      },
    };
  }

  if (method === "POST" && payload.pathname === "/api/v1/sync/apply") {
    return {
      channel: "operation",
      started: "operation.started",
      completed: "operation.completed",
      failed: "operation.failed",
      payload: {
        operation: "sync",
        targets: Array.isArray(body.targets) ? body.targets : [],
      },
    };
  }

  if (method === "POST" && /^\/api\/v1\/hooks\/(install|uninstall|sync)\/apply$/.test(payload.pathname)) {
    const action = payload.pathname.replace(/^\/api\/v1\/hooks\/(.+)\/apply$/, "$1");
    return {
      channel: "operation",
      started: "operation.started",
      completed: "operation.completed",
      failed: "operation.failed",
      payload: {
        operation: `hooks.${action}`,
        targets: Array.isArray(body.targets) ? body.targets : [],
      },
    };
  }

  if (method === "POST" && /^\/api\/v1\/sources(?:\/[^/]+)?\/refresh(?:-all)?$/.test(payload.pathname)) {
    const match = payload.pathname.match(/^\/api\/v1\/sources\/([^/]+)\/refresh$/);
    const sourceId = match?.[1] || "all";
    return {
      channel: "source",
      started: "source.refresh.started",
      completed: "source.refresh.completed",
      failed: "source.refresh.failed",
      payload: {
        sourceId,
      },
    };
  }

  if (method === "POST" && payload.pathname === "/api/v1/skills/publish") {
    return {
      channel: "operation",
      started: "operation.started",
      completed: "operation.completed",
      failed: "operation.failed",
      payload: {
        operation: "publish",
        sourceId: typeof body.sourceId === "string" ? body.sourceId : undefined,
      },
    };
  }

  return null;
}

function parseInjectedBody(body: string): unknown {
  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export async function createDesktopControlPlane(options: CreateDesktopControlPlaneOptions = {}): Promise<DesktopControlPlane> {
  const repoRoot = options.repoRoot || findRepoRoot(__dirname);
  const applicationService = withApplicationService(repoRoot, options.applicationService);
  const app = await createInstallerDashboardServer({
    repoRoot,
    applicationService,
  });
  const listeners = new Set<(event: RealtimeEvent) => void>();

  function emit(event: RealtimeEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  return {
    async request(payload) {
      const operation = describeDesktopOperation(payload);
      const opId = operation ? `op_${crypto.randomUUID()}` : undefined;
      if (operation && opId) {
        emit(buildRealtimeEvent(operation.channel, operation.started, operation.payload, opId));
      }

      try {
        const response = (await app.inject({
          method: (payload.method || "GET").toUpperCase() as never,
          url: payload.pathname,
          remoteAddress: "127.0.0.1",
          headers: payload.body === undefined ? payload.headers || {} : { "content-type": "application/json", ...(payload.headers || {}) },
          payload: payload.body === undefined ? undefined : JSON.stringify(payload.body),
        } as never)) as { statusCode: number; body: string };
        const body = parseInjectedBody(response.body);

        if (operation && opId) {
          const eventType = response.statusCode >= 400 ? operation.failed : operation.completed;
          const eventPayload =
            response.statusCode >= 400
              ? { ...operation.payload, error: extractErrorMessage(body, `Request failed with status ${response.statusCode}.`) }
              : { ...operation.payload, status: response.statusCode };
          emit(buildRealtimeEvent(operation.channel, eventType, eventPayload, opId));
        }

        return {
          status: response.statusCode,
          body,
        };
      } catch (error) {
        if (operation && opId) {
          emit(
            buildRealtimeEvent(operation.channel, operation.failed, {
              ...operation.payload,
              error: error instanceof Error ? error.message : String(error),
            }, opId),
          );
        }
        throw error;
      }
    },

    subscribeRealtime(listener) {
      listeners.add(listener);
      listener(
        buildRealtimeEvent("system", "system.hello", {
          protocolVersion: "ica-ws-v1",
        }),
      );
      return () => {
        listeners.delete(listener);
      };
    },

    async pickProjectDirectory(initialPath) {
      return applicationService.pickProjectDirectory(initialPath);
    },

    async pickPublishDirectory(initialPath) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/skills/pick",
        remoteAddress: "127.0.0.1",
        headers: {
          "content-type": "application/json",
        },
        payload: JSON.stringify({
          initialPath,
        }),
      } as never);
      const body = parseInjectedBody(response.body);
      if (response.statusCode >= 400 || !body || typeof body !== "object" || typeof (body as { path?: unknown }).path !== "string") {
        throw new Error(extractErrorMessage(body, "Skill picker failed."));
      }
      return { path: (body as { path: string }).path };
    },

    async getRuntimeInfo() {
      return {
        runtime: "desktop",
        hostVersion: "ica-desktop-host-v1",
      };
    },

    async reportRendererFailure(payload) {
      const message = payload.context ? `[desktop] ${payload.context}: ${payload.reason}` : `[desktop] ${payload.reason}`;
      console.error(message, payload.details || {});
    },

    async close() {
      listeners.clear();
      await app.close();
    },
  };
}

function extractErrorMessage(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && "error" in value) {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) {
      return error;
    }
  }
  return fallback;
}

function withApplicationService(repoRoot: string, overrides?: Partial<InstallerApplicationService>): InstallerApplicationService {
  return {
    ...createInstallerApplicationService({ repoRoot }),
    ...(overrides || {}),
  };
}
