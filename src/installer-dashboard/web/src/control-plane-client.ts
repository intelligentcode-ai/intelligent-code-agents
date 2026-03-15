import type { DesktopHostFailureReport, DesktopRuntimeInfo, RealtimeEvent } from "../../../desktop-electron/bridge";
import { CONTROL_PLANE_REQUEST_CHANNEL } from "../../../desktop-electron/bridge";
import type { AppUpdateStatus } from "../../../installer-core/updateCheck";

export type RealtimeStatus = "connected" | "reconnecting" | "disconnected" | "web-preview";

interface WsSessionResponse {
  wsUrl: string;
  ticket: string;
  expiresAt: string;
  protocolVersion: "ica-ws-v1";
}

export interface RealtimeClientOptions {
  reconnectDelayMs?: number;
  onStatusChange?: (status: RealtimeStatus) => void;
  onEvent?: (event: RealtimeEvent) => void;
  onError?: (message: string) => void;
}

interface HealthPayload {
  update?: AppUpdateStatus;
}

function getDesktopBridge() {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.icaDesktop;
}

async function resolveRuntimeInfo(): Promise<DesktopRuntimeInfo> {
  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    return desktopBridge.getRuntimeInfo();
  }

  if (typeof navigator !== "undefined" && /\bElectron\b/i.test(navigator.userAgent || "")) {
    return {
      runtime: "desktop",
      hostVersion: "ica-desktop-host-v1",
    };
  }

  return {
    runtime: "web-preview",
    hostVersion: "ica-desktop-host-v1",
  };
}

function createHostBridgeUnavailableError(): Error {
  return new Error("Desktop host bridge unavailable.");
}

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) {
    return normalized;
  }

  const source = new Headers(headers);
  source.forEach((value, key) => {
    normalized[key.toLowerCase()] = value;
  });
  return normalized;
}

async function normalizeBody(body: BodyInit | null | undefined, headers: Record<string, string>): Promise<unknown> {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === "string") {
    if ((headers["content-type"] || "").includes("application/json")) {
      try {
        return JSON.parse(body);
      } catch {
        return body;
      }
    }
    return body;
  }

  if (body instanceof URLSearchParams) {
    return Object.fromEntries(body.entries());
  }

  return body;
}

function toJsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload ?? {}), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function asErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export async function controlPlaneFetch(pathname: string, init?: RequestInit): Promise<Response> {
  const desktopBridge = getDesktopBridge();
  if (!desktopBridge) {
    const runtimeInfo = await resolveRuntimeInfo();
    if (runtimeInfo.runtime === "desktop") {
      throw createHostBridgeUnavailableError();
    }
    return fetch(pathname, init);
  }

  const headers = normalizeHeaders(init?.headers);
  const method = (init?.method || "GET").toUpperCase();
  const body = await normalizeBody(init?.body, headers);
  const response = await desktopBridge.request(CONTROL_PLANE_REQUEST_CHANNEL, {
    pathname,
    method,
    headers,
    body,
  });

  return toJsonResponse(response.body, response.status);
}

export async function pickProjectDirectory(initialPath?: string): Promise<{ path: string }> {
  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    return desktopBridge.pickProjectDirectory(initialPath);
  }

  const response = await controlPlaneFetch("/api/v1/projects/pick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      initialPath,
    }),
  });
  const payload = (await response.json()) as { path?: string; error?: string };
  if (!response.ok || typeof payload.path !== "string") {
    throw new Error(asErrorMessage(payload, "Project picker failed."));
  }
  return { path: payload.path };
}

export async function checkAppUpdate(force = false): Promise<AppUpdateStatus> {
  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    return desktopBridge.checkForAppUpdate(force);
  }

  const response = await controlPlaneFetch("/api/v1/health");
  const payload = (await response.json()) as HealthPayload & { error?: string };
  if (!response.ok || !payload.update) {
    throw new Error(asErrorMessage(payload, "Update status unavailable."));
  }
  return payload.update;
}

export async function downloadAppUpdate(): Promise<AppUpdateStatus> {
  const desktopBridge = getDesktopBridge();
  if (!desktopBridge) {
    throw createHostBridgeUnavailableError();
  }
  return desktopBridge.downloadAppUpdate();
}

export async function quitAndInstallAppUpdate(): Promise<{ accepted: boolean }> {
  const desktopBridge = getDesktopBridge();
  if (!desktopBridge) {
    throw createHostBridgeUnavailableError();
  }
  return desktopBridge.quitAndInstallAppUpdate();
}

export async function pickPublishDirectory(initialPath?: string): Promise<{ path: string }> {
  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    return desktopBridge.pickPublishDirectory(initialPath);
  }

  const response = await controlPlaneFetch("/api/v1/skills/pick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      initialPath,
    }),
  });
  const payload = (await response.json()) as { path?: string; error?: string };
  if (!response.ok || typeof payload.path !== "string") {
    throw new Error(asErrorMessage(payload, "Skill picker failed."));
  }
  return { path: payload.path };
}

export async function openSettingsWindow(): Promise<void> {
  const desktopBridge = getDesktopBridge();
  if (!desktopBridge) {
    throw createHostBridgeUnavailableError();
  }
  await desktopBridge.openSettingsWindow();
}

export async function reportRendererFailure(payload: DesktopHostFailureReport): Promise<void> {
  const desktopBridge = getDesktopBridge();
  if (!desktopBridge) {
    return;
  }
  await desktopBridge.reportRendererFailure(payload);
}

export function startControlPlaneRealtimeClient(options: RealtimeClientOptions = {}): () => void {
  const desktopBridge = getDesktopBridge();
  if (desktopBridge) {
    options.onStatusChange?.("connected");
    return desktopBridge.subscribeRealtime((event) => {
      options.onEvent?.(event);
    });
  }

  if (typeof window === "undefined" || typeof WebSocket === "undefined") {
    options.onStatusChange?.("disconnected");
    return () => undefined;
  }

  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  const reconnectDelayMs = Math.max(500, options.reconnectDelayMs ?? 2_500);
  let hasConnected = false;

  const cleanupSocket = (): void => {
    if (!socket) {
      return;
    }
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    try {
      socket.close();
    } catch {
      // ignore close issues
    }
    socket = null;
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer !== null) {
      return;
    }
    options.onStatusChange?.("reconnecting");
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectDelayMs);
  };

  const connect = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    try {
      const runtimeInfo = await resolveRuntimeInfo();
      if (runtimeInfo.runtime === "desktop") {
        options.onStatusChange?.("disconnected");
        options.onError?.(createHostBridgeUnavailableError().message);
        return;
      }

      const response = await controlPlaneFetch("/api/v1/ws/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const payload = (await response.json()) as WsSessionResponse | { error?: string };
      if (!response.ok || !payload || typeof (payload as WsSessionResponse).wsUrl !== "string") {
        throw new Error(typeof (payload as { error?: string }).error === "string" ? (payload as { error?: string }).error : "Realtime unavailable");
      }

      cleanupSocket();
      socket = new WebSocket((payload as WsSessionResponse).wsUrl);
      socket.onopen = () => {
        hasConnected = true;
        options.onStatusChange?.("connected");
      };
      socket.onerror = () => {
        if (!stopped && hasConnected) {
          options.onError?.("Live updates temporarily unavailable.");
        }
      };
      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as RealtimeEvent;
          options.onEvent?.(parsed);
        } catch {
          // ignore malformed event frames
        }
      };
      socket.onclose = () => {
        if (stopped) {
          return;
        }
        if (!hasConnected) {
          options.onStatusChange?.("web-preview");
        }
        scheduleReconnect();
      };
    } catch (error) {
      if (!stopped) {
        if (hasConnected) {
          options.onError?.(asErrorMessage(error, "Live updates unavailable; continuing in web preview mode."));
        }
        options.onStatusChange?.(hasConnected ? "reconnecting" : "web-preview");
        scheduleReconnect();
      }
    }
  };

  void connect();

  return () => {
    stopped = true;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanupSocket();
  };
}
