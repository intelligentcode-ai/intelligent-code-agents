import { apiFetch } from "./api-client";

export type RealtimeStatus = "connected" | "reconnecting" | "http-only";

export interface RealtimeEvent {
  id: string;
  ts: string;
  channel: "system" | "operation" | "source";
  type:
    | "system.hello"
    | "system.heartbeat"
    | "operation.started"
    | "operation.completed"
    | "operation.failed"
    | "source.refresh.started"
    | "source.refresh.completed"
    | "source.refresh.failed";
  opId?: string;
  payload: Record<string, unknown>;
}

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

function asErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export function startRealtimeClient(options: RealtimeClientOptions = {}): () => void {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") {
    options.onStatusChange?.("http-only");
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
      const response = await apiFetch("/api/v1/ws/session", {
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
          options.onStatusChange?.("http-only");
        }
        scheduleReconnect();
      };
    } catch (error) {
      if (!stopped) {
        if (hasConnected) {
          options.onError?.(asErrorMessage(error, "Live updates unavailable; continuing in HTTP-only mode."));
        }
        options.onStatusChange?.(hasConnected ? "reconnecting" : "http-only");
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
