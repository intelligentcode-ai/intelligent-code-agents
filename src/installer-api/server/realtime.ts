import crypto from "node:crypto";
import type { WebSocket } from "ws";

export type RealtimeChannel = "system" | "operation" | "source";

export type RealtimeEventType =
  | "system.hello"
  | "system.heartbeat"
  | "operation.started"
  | "operation.completed"
  | "operation.failed"
  | "source.refresh.started"
  | "source.refresh.completed"
  | "source.refresh.failed";

export interface RealtimeEvent {
  id: string;
  ts: string;
  channel: RealtimeChannel;
  type: RealtimeEventType;
  opId?: string;
  payload: Record<string, unknown>;
}

export interface RealtimeHubOptions {
  heartbeatMs?: number;
}

export interface RealtimeHub {
  attach(socket: WebSocket): void;
  emit(channel: RealtimeChannel, type: RealtimeEventType, payload?: Record<string, unknown>, opId?: string): RealtimeEvent;
  close(): void;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

export function createRealtimeHub(options: RealtimeHubOptions = {}): RealtimeHub {
  const heartbeatMs = Math.max(5_000, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  const sockets = new Set<WebSocket>();
  const timers = new Map<WebSocket, NodeJS.Timeout>();

  function buildEvent(
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

  function send(socket: WebSocket, event: RealtimeEvent): void {
    try {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(event));
      }
    } catch {
      // ignore broken sockets; close handler will clean up
    }
  }

  function detach(socket: WebSocket): void {
    sockets.delete(socket);
    const timer = timers.get(socket);
    if (timer) {
      clearInterval(timer);
      timers.delete(socket);
    }
  }

  function emit(channel: RealtimeChannel, type: RealtimeEventType, payload: Record<string, unknown> = {}, opId?: string): RealtimeEvent {
    const event = buildEvent(channel, type, payload, opId);
    for (const socket of sockets) {
      send(socket, event);
    }
    return event;
  }

  function attach(socket: WebSocket): void {
    sockets.add(socket);

    const heartbeatTimer = setInterval(() => {
      send(socket, buildEvent("system", "system.heartbeat", {}));
    }, heartbeatMs);
    timers.set(socket, heartbeatTimer);

    socket.on("close", () => detach(socket));
    socket.on("error", () => detach(socket));

    send(socket, buildEvent("system", "system.hello", { protocolVersion: "ica-ws-v1" }));
  }

  function close(): void {
    for (const timer of timers.values()) {
      clearInterval(timer);
    }
    timers.clear();

    for (const socket of sockets) {
      try {
        socket.close(1000, "Server shutdown");
      } catch {
        // ignore close errors
      }
    }
    sockets.clear();
  }

  return {
    attach,
    emit,
    close,
  };
}
