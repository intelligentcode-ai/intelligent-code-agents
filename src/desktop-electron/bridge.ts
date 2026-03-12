import type { RealtimeEvent } from "../installer-api/server/realtime";

export const CONTROL_PLANE_REQUEST_CHANNEL = "control-plane.request" as const;
export const REALTIME_EVENT_CHANNEL = "ica:realtime:event" as const;
export const REALTIME_SUBSCRIBE_CHANNEL = "ica:realtime:subscribe" as const;
export const REALTIME_UNSUBSCRIBE_CHANNEL = "ica:realtime:unsubscribe" as const;
export const CONTROL_PLANE_IPC_CHANNEL = "ica:control-plane:request" as const;

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

export interface DesktopBridgeRequestMap {
  [CONTROL_PLANE_REQUEST_CHANNEL]: DesktopControlPlaneRequest;
}

export interface DesktopBridgeResponseMap {
  [CONTROL_PLANE_REQUEST_CHANNEL]: DesktopControlPlaneResponse;
}

export interface DesktopBridgeApi {
  request<K extends keyof DesktopBridgeRequestMap>(channel: K, payload: DesktopBridgeRequestMap[K]): Promise<DesktopBridgeResponseMap[K]>;
  subscribeRealtime(listener: (event: RealtimeEvent) => void): () => void;
}

declare global {
  interface Window {
    icaDesktop?: DesktopBridgeApi;
  }
}

export type { RealtimeEvent };
