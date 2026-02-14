import crypto from "node:crypto";

interface WsTicketRecord {
  sessionId: string;
  expiresAtMs: number;
}

export interface WsTicketStoreOptions {
  ttlMs?: number;
  now?: () => number;
}

export interface CreatedWsTicket {
  ticket: string;
  expiresAt: string;
}

export interface ConsumedWsTicket {
  ok: boolean;
  reason?: "missing" | "expired" | "session-mismatch";
}

export interface WsTicketStore {
  createTicket(sessionId: string): CreatedWsTicket;
  consumeTicket(ticket: string, sessionId: string): ConsumedWsTicket;
  cleanupExpired(): void;
}

const DEFAULT_TTL_MS = 60_000;

export function createWsTicketStore(options: WsTicketStoreOptions = {}): WsTicketStore {
  const now = options.now || (() => Date.now());
  const ttlMs = Math.max(10, options.ttlMs ?? DEFAULT_TTL_MS);
  const records = new Map<string, WsTicketRecord>();

  function cleanupExpired(): void {
    const nowMs = now();
    for (const [ticket, record] of records.entries()) {
      if (record.expiresAtMs <= nowMs) {
        records.delete(ticket);
      }
    }
  }

  function createTicket(sessionId: string): CreatedWsTicket {
    cleanupExpired();
    const ticket = `wst_${crypto.randomUUID().replace(/-/g, "")}`;
    const expiresAtMs = now() + ttlMs;
    records.set(ticket, {
      sessionId,
      expiresAtMs,
    });

    return {
      ticket,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  function consumeTicket(ticket: string, sessionId: string): ConsumedWsTicket {
    cleanupExpired();
    const record = records.get(ticket);
    if (!record) {
      return { ok: false, reason: "missing" };
    }
    records.delete(ticket);
    if (record.expiresAtMs <= now()) {
      return { ok: false, reason: "expired" };
    }
    if (record.sessionId !== sessionId) {
      return { ok: false, reason: "session-mismatch" };
    }
    return { ok: true };
  }

  return {
    createTicket,
    consumeTicket,
    cleanupExpired,
  };
}
