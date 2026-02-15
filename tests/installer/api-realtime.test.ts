import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { allowedUiOrigins, createInstallerApiServer, isAllowedUiOrigin } from "../../src/installer-api/server/index";

const API_KEY = "test-api-key";

function createCatalogFixture() {
  return {
    generatedAt: "1970-01-01T00:00:00.000Z",
    source: "multi-source" as const,
    version: "1.0.0",
    sources: [],
    skills: [],
  };
}

function createHookCatalogFixture() {
  return {
    generatedAt: "1970-01-01T00:00:00.000Z",
    source: "multi-source" as const,
    version: "1.0.0",
    sources: [],
    hooks: [],
  };
}

function attachEventCollector(socket: WebSocket): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  socket.on("message", (raw: WebSocket.RawData) => {
    try {
      const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
      events.push(parsed);
    } catch {
      // ignore malformed frames in tests
    }
  });
  return events;
}

async function waitForEventType(events: Array<Record<string, unknown>>, type: string, timeoutMs = 3_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const index = events.findIndex((event) => event.type === type);
    if (index >= 0) {
      const [event] = events.splice(index, 1);
      return event;
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for websocket event ${type}.`);
}

test("ws session endpoint enforces API key and returns v1 ticket contract", async (t) => {
  const app = await createInstallerApiServer({
    apiKey: API_KEY,
    dependencies: ({
      loadCatalogFromSources: async () => createCatalogFixture(),
      loadHookCatalogFromSources: async () => createHookCatalogFixture(),
      loadSources: async () => [],
      loadHookSources: async () => [],
    }) as never,
  });
  t.after(async () => {
    await app.close();
  });

  const unauthorized = await app.inject({
    method: "POST",
    url: "/api/v1/ws/session",
    headers: { "content-type": "application/json" },
    payload: {},
  });
  assert.equal(unauthorized.statusCode, 401);

  const authorized = await app.inject({
    method: "POST",
    url: "/api/v1/ws/session",
    headers: {
      "content-type": "application/json",
      "x-ica-api-key": API_KEY,
    },
    payload: {},
  });
  assert.equal(authorized.statusCode, 200);
  const payload = authorized.json() as {
    wsUrl: string;
    ticket: string;
    expiresAt: string;
    protocolVersion: string;
  };

  assert.match(payload.wsUrl, /\/ws\/events\?ticket=/);
  assert.match(payload.ticket, /^wst_/);
  assert.equal(payload.protocolVersion, "ica-ws-v1");
  assert.ok(Number.isFinite(Date.parse(payload.expiresAt)));
});

test("ws ticket is single-use and expires", async (t) => {
  const app = await createInstallerApiServer({
    apiKey: API_KEY,
    port: 43981,
    wsTicketTtlMs: 50,
    dependencies: ({
      loadCatalogFromSources: async () => createCatalogFixture(),
      loadHookCatalogFromSources: async () => createHookCatalogFixture(),
      loadSources: async () => [],
      loadHookSources: async () => [],
    }) as never,
  });
  t.after(async () => {
    await app.close();
  });

  await app.listen({ host: "127.0.0.1", port: 43981 });

  const ticketRes = await fetch("http://127.0.0.1:43981/api/v1/ws/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ica-api-key": API_KEY,
    },
    body: "{}",
  });
  const ticketPayload = (await ticketRes.json()) as { wsUrl: string };

  const first = new WebSocket(ticketPayload.wsUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("first websocket did not open")), 3_000);
    first.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    first.once("error", reject);
  });
  first.close();

  const second = new WebSocket(ticketPayload.wsUrl);
  const secondCloseCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("second websocket was not rejected in time")), 3_000);
    second.once("close", (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
    second.once("error", () => {
      // expected in some ws clients before close
    });
  });
  assert.equal(secondCloseCode, 1008);

  const expiredTicketRes = await fetch("http://127.0.0.1:43981/api/v1/ws/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ica-api-key": API_KEY,
    },
    body: "{}",
  });
  const expiredTicketPayload = (await expiredTicketRes.json()) as { wsUrl: string };
  await delay(75);

  const expiredSocket = new WebSocket(expiredTicketPayload.wsUrl);
  const expiredCloseCode = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("expired websocket was not rejected in time")), 3_000);
    expiredSocket.once("close", (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
    expiredSocket.once("error", () => {
      // expected in some ws clients before close
    });
  });
  assert.equal(expiredCloseCode, 1008);
});

test("ws emits hello and operation lifecycle events with operationId parity", async (t) => {
  const app = await createInstallerApiServer({
    apiKey: API_KEY,
    port: 43982,
    wsHeartbeatMs: 60_000,
    dependencies: ({
      executeOperation: async (_repoRoot: unknown, request: unknown) => ({ startedAt: "start", completedAt: "end", request, targets: [] }),
      loadCatalogFromSources: async () => createCatalogFixture(),
      loadHookCatalogFromSources: async () => createHookCatalogFixture(),
      loadSources: async () => [],
      loadHookSources: async () => [],
    }) as never,
  });
  t.after(async () => {
    await app.close();
  });

  await app.listen({ host: "127.0.0.1", port: 43982 });

  const ticketRes = await fetch("http://127.0.0.1:43982/api/v1/ws/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ica-api-key": API_KEY,
    },
    body: "{}",
  });
  const ticketPayload = (await ticketRes.json()) as { wsUrl: string };

  const socket = new WebSocket(ticketPayload.wsUrl);
  const events = attachEventCollector(socket);
  t.after(() => {
    socket.close();
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket did not open")), 3_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", reject);
  });

  const hello = await waitForEventType(events, "system.hello");
  assert.equal(hello.channel, "system");

  const applyRes = await fetch("http://127.0.0.1:43982/api/v1/install/apply", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ica-api-key": API_KEY,
    },
    body: JSON.stringify({
      operation: "install",
      targets: ["codex"],
      scope: "user",
      mode: "symlink",
      skills: [],
    }),
  });
  assert.equal(applyRes.status, 200);
  const applyPayload = (await applyRes.json()) as { operationId?: string };
  assert.match(String(applyPayload.operationId), /^op_/);

  const started = await waitForEventType(events, "operation.started");
  const completed = await waitForEventType(events, "operation.completed");
  assert.equal(started.opId, applyPayload.operationId);
  assert.equal(completed.opId, applyPayload.operationId);
});

test("ws emits source refresh lifecycle events", async (t) => {
  const app = await createInstallerApiServer({
    apiKey: API_KEY,
    port: 43983,
    wsHeartbeatMs: 60_000,
    dependencies: ({
      loadCatalogFromSources: async () => createCatalogFixture(),
      loadHookCatalogFromSources: async () => createHookCatalogFixture(),
      loadSources: async () => [
        {
          id: "demo-source",
          name: "demo-source",
          repoUrl: "https://example.com/demo.git",
          transport: "https" as const,
          official: false,
          enabled: true,
          skillsRoot: "/skills",
          removable: true,
        },
      ],
      loadHookSources: async () => [],
      syncSource: async () => ({
        source: {
          id: "demo-source",
          name: "demo-source",
          repoUrl: "https://example.com/demo.git",
          transport: "https" as const,
          official: false,
          enabled: true,
          skillsRoot: "/skills",
          removable: true,
        },
        localPath: "/tmp/source",
        skillsPath: "/tmp/skills",
        revision: "abc123",
      }),
    }) as never,
  });
  t.after(async () => {
    await app.close();
  });

  await app.listen({ host: "127.0.0.1", port: 43983 });

  const ticketRes = await fetch("http://127.0.0.1:43983/api/v1/ws/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ica-api-key": API_KEY,
    },
    body: "{}",
  });
  const ticketPayload = (await ticketRes.json()) as { wsUrl: string };

  const socket = new WebSocket(ticketPayload.wsUrl);
  const events = attachEventCollector(socket);
  t.after(() => {
    socket.close();
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket did not open")), 3_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", reject);
  });

  await waitForEventType(events, "system.hello");

  const refreshRes = await fetch("http://127.0.0.1:43983/api/v1/sources/refresh-all", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ica-api-key": API_KEY,
    },
    body: "{}",
  });
  assert.equal(refreshRes.status, 200);
  const refreshPayload = (await refreshRes.json()) as { operationId?: string };
  assert.match(String(refreshPayload.operationId), /^op_/);

  const started = await waitForEventType(events, "source.refresh.started");
  const completed = await waitForEventType(events, "source.refresh.completed");
  assert.equal(started.opId, refreshPayload.operationId);
  assert.equal(completed.opId, refreshPayload.operationId);
});

test("origin allowlist helper allows localhost UI origins and blocks foreign origins", () => {
  const allowlist = allowedUiOrigins(4173);
  assert.equal(isAllowedUiOrigin(allowlist, "http://127.0.0.1:4173"), true);
  assert.equal(isAllowedUiOrigin(allowlist, "http://localhost:4173"), true);
  assert.equal(isAllowedUiOrigin(allowlist, "http://[::1]:4173"), true);
  assert.equal(isAllowedUiOrigin(allowlist, "http://evil.example"), false);
  assert.equal(isAllowedUiOrigin(allowlist, undefined), true);
});

test("health endpoint includes update-check metadata", async (t) => {
  const app = await createInstallerApiServer({
    apiKey: API_KEY,
    dependencies: ({
      loadCatalogFromSources: async () => createCatalogFixture(),
      loadHookCatalogFromSources: async () => createHookCatalogFixture(),
      loadSources: async () => [],
      loadHookSources: async () => [],
      checkForAppUpdate: async () => ({
        currentVersion: "12.1.0",
        latestVersion: "12.2.0",
        latestReleaseUrl: "https://github.com/intelligentcode-ai/intelligent-code-agents/releases/tag/v12.2.0",
        checkedAt: "2026-02-15T00:00:00.000Z",
        updateAvailable: true,
      }),
    }) as never,
  });
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: "GET",
    url: "/api/v1/health",
    headers: {
      "x-ica-api-key": API_KEY,
    },
  });
  assert.equal(res.statusCode, 200);
  const payload = res.json() as {
    version?: string;
    update?: { latestVersion?: string; updateAvailable?: boolean };
  };
  assert.match(String(payload.version || ""), /^\d+\.\d+\.\d+/);
  assert.equal(payload.update?.latestVersion, "12.2.0");
  assert.equal(payload.update?.updateAvailable, true);
});

test("catalog failures return structured retryable JSON error", async (t) => {
  const app = await createInstallerApiServer({
    apiKey: API_KEY,
    dependencies: ({
      loadCatalogFromSources: async () => {
        throw new Error("transient catalog backend failure");
      },
      loadHookCatalogFromSources: async () => createHookCatalogFixture(),
      loadSources: async () => [],
      loadHookSources: async () => [],
    }) as never,
  });
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: "GET",
    url: "/api/v1/catalog/skills",
    headers: {
      "x-ica-api-key": API_KEY,
    },
  });

  assert.equal(res.statusCode, 503);
  const payload = res.json() as { error?: string; code?: string; retryable?: boolean };
  assert.equal(payload.code, "CATALOG_SKILLS_UNAVAILABLE");
  assert.equal(payload.retryable, true);
  assert.ok(payload.error && payload.error.length > 0);
});

test("skills catalog endpoint forwards refresh flag and stale diagnostics", async (t) => {
  const refreshCalls: boolean[] = [];
  const app = await createInstallerApiServer({
    apiKey: API_KEY,
    dependencies: ({
      loadCatalogFromSources: async (_repoRoot: string, refresh = false) => {
        refreshCalls.push(refresh);
        return {
          generatedAt: "2026-02-14T00:00:00.000Z",
          source: "multi-source" as const,
          version: "1.0.0",
          sources: [],
          skills: [],
          stale: true,
          catalogSource: "snapshot" as const,
          staleReason: "live catalog unavailable; serving snapshot",
          cacheAgeSeconds: 3600,
          nextRefreshAt: "2026-02-14T01:00:00.000Z",
        };
      },
      loadHookCatalogFromSources: async () => createHookCatalogFixture(),
      loadSources: async () => [],
      loadHookSources: async () => [],
    }) as never,
  });
  t.after(async () => {
    await app.close();
  });

  const res = await app.inject({
    method: "GET",
    url: "/api/v1/catalog/skills?refresh=on",
    headers: {
      "x-ica-api-key": API_KEY,
    },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(refreshCalls, [true]);
  const payload = res.json() as {
    stale?: boolean;
    catalogSource?: string;
    staleReason?: string;
    cacheAgeSeconds?: number;
    nextRefreshAt?: string;
  };
  assert.equal(payload.stale, true);
  assert.equal(payload.catalogSource, "snapshot");
  assert.match(String(payload.staleReason || ""), /snapshot/i);
  assert.equal(payload.cacheAgeSeconds, 3600);
  assert.equal(payload.nextRefreshAt, "2026-02-14T01:00:00.000Z");
});
