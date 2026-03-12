import type { RealtimeEvent } from "../../../desktop-electron/bridge";
import { startControlPlaneRealtimeClient } from "./control-plane-client";

export type { RealtimeEvent };
export type { RealtimeClientOptions, RealtimeStatus } from "./control-plane-client";

export const startRealtimeClient = startControlPlaneRealtimeClient;
