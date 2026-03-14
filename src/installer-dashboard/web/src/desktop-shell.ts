import type { RealtimeEvent } from "../../../desktop-electron/bridge";
import type { RealtimeStatus } from "./realtime-client";

export interface RealtimeStatusDescriptor {
  tone: "positive" | "warning" | "danger" | "busy";
  badge: string;
  title: string;
  detail: string;
}

export interface RealtimeStatusContext {
  busy: boolean;
  catalogLoading: boolean;
  error: string;
  hasProjectPath: boolean;
}

export function describeRealtimeStatus(status: RealtimeStatus, context: RealtimeStatusContext): RealtimeStatusDescriptor {
  if (context.error.trim()) {
    return {
      tone: "danger",
      badge: "Needs attention",
      title: "Desktop shell needs attention",
      detail: context.error.trim(),
    };
  }

  if (context.busy || context.catalogLoading) {
    return {
      tone: "busy",
      badge: "Working",
      title: "Operation running",
      detail: context.catalogLoading
        ? "Refreshing catalog and desktop shell context."
        : "Applying your latest desktop action and tracking progress.",
    };
  }

  if (status === "connected") {
    return {
      tone: "positive",
      badge: "Connected",
      title: "Desktop bridge online",
      detail: context.hasProjectPath
        ? "Native dialogs and local operations are available for the selected project."
        : "Desktop bridge is active. Add a project path when you want native workspace actions.",
    };
  }

  if (status === "reconnecting") {
    return {
      tone: "warning",
      badge: "Reconnecting",
      title: "Live connection is recovering",
      detail: "Realtime updates are reconnecting. Existing actions stay available while the shell recovers.",
    };
  }

  if (status === "web-preview") {
    return {
      tone: "warning",
      badge: "Preview",
      title: "Web preview active",
      detail: "Browser preview is active. Native desktop host actions are only available in the desktop runtime.",
    };
  }

  return {
    tone: "warning",
    badge: "Disconnected",
    title: "Desktop host unavailable",
    detail: "The desktop host bridge is unavailable. Reconnect the desktop host to restore native actions.",
  };
}

export function summarizeRealtimeEvent(event: RealtimeEvent): string {
  if (event.channel === "operation") {
    const operation = typeof event.payload.operation === "string" ? event.payload.operation : "operation";
    const targets = Array.isArray(event.payload.targets) ? event.payload.targets.join(", ") : "";
    if (event.type === "operation.started") {
      return `Started ${operation}${targets ? ` for ${targets}` : ""}.`;
    }
    if (event.type === "operation.completed") {
      return `Completed ${operation}${targets ? ` for ${targets}` : ""}.`;
    }
    if (event.type === "operation.failed") {
      const error = typeof event.payload.error === "string" ? event.payload.error : "Unknown failure";
      return `Failed ${operation}: ${error}.`;
    }
  }

  if (event.channel === "source") {
    const sourceId = typeof event.payload.sourceId === "string" ? event.payload.sourceId : "source";
    if (event.type === "source.refresh.started") {
      return `Refreshing ${sourceId}.`;
    }
    if (event.type === "source.refresh.completed") {
      return `Finished refreshing ${sourceId}.`;
    }
    if (event.type === "source.refresh.failed") {
      const error = typeof event.payload.error === "string" ? event.payload.error : "Unknown failure";
      return `Refresh failed for ${sourceId}: ${error}.`;
    }
  }

  return "Desktop shell heartbeat received.";
}
