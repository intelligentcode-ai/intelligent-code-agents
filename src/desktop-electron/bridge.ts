import type { RealtimeEvent } from "../installer-api/server/realtime";
import type { AppUpdateStatus } from "../installer-core/updateCheck";

export const CONTROL_PLANE_REQUEST_CHANNEL = "control-plane.request" as const;
export const REALTIME_EVENT_CHANNEL = "ica:realtime:event" as const;
export const REALTIME_SUBSCRIBE_CHANNEL = "ica:realtime:subscribe" as const;
export const REALTIME_UNSUBSCRIBE_CHANNEL = "ica:realtime:unsubscribe" as const;
export const CONTROL_PLANE_IPC_CHANNEL = "ica:control-plane:request" as const;
export const DESKTOP_PICK_PROJECT_IPC_CHANNEL = "ica:desktop:pick-project" as const;
export const DESKTOP_PICK_PUBLISH_IPC_CHANNEL = "ica:desktop:pick-publish" as const;
export const DESKTOP_RUNTIME_INFO_IPC_CHANNEL = "ica:desktop:runtime-info" as const;
export const DESKTOP_REPORT_FAILURE_IPC_CHANNEL = "ica:desktop:report-failure" as const;
export const DESKTOP_UPDATE_CHECK_IPC_CHANNEL = "ica:desktop:update-check" as const;
export const DESKTOP_UPDATE_DOWNLOAD_IPC_CHANNEL = "ica:desktop:update-download" as const;
export const DESKTOP_UPDATE_QUIT_AND_INSTALL_IPC_CHANNEL = "ica:desktop:update-quit-install" as const;

export interface DesktopControlPlaneRequest {
  pathname: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface DesktopControlPlaneResponse {
  status: number;
  body: unknown;
}

export interface DesktopRuntimeInfo {
  runtime: "desktop" | "web-preview";
  hostVersion: "ica-desktop-host-v1";
}

export interface DesktopHostFailureReport {
  reason: string;
  context?: string;
  details?: Record<string, unknown>;
}

export interface DesktopBridgeRequestMap {
  [CONTROL_PLANE_REQUEST_CHANNEL]: DesktopControlPlaneRequest;
}

export interface DesktopBridgeResponseMap {
  [CONTROL_PLANE_REQUEST_CHANNEL]: DesktopControlPlaneResponse;
}

export interface DesktopBridgeApi {
  request<K extends keyof DesktopBridgeRequestMap>(channel: K, payload: DesktopBridgeRequestMap[K]): Promise<DesktopBridgeResponseMap[K]>;
  subscribeRealtime(listener: (event: RealtimeEvent) => void): () => void;
  checkForAppUpdate(force?: boolean): Promise<AppUpdateStatus>;
  downloadAppUpdate(): Promise<AppUpdateStatus>;
  quitAndInstallAppUpdate(): Promise<{ accepted: boolean }>;
  pickProjectDirectory(initialPath?: string): Promise<{ path: string }>;
  pickPublishDirectory(initialPath?: string): Promise<{ path: string }>;
  getRuntimeInfo(): Promise<DesktopRuntimeInfo>;
  reportRendererFailure(payload: DesktopHostFailureReport): Promise<void>;
}

declare global {
  interface Window {
    icaDesktop?: DesktopBridgeApi;
  }
}

export type { RealtimeEvent };
