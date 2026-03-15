import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { controlPlaneFetch, openSettingsWindow, startControlPlaneRealtimeClient } from "../../src/installer-dashboard/web/src/control-plane-client";
import type { RealtimeEvent } from "../../src/desktop-electron/bridge";

type DesktopWindow = Window & {
  icaDesktop?: {
    request: (channel: "control-plane.request", payload: unknown) => Promise<{ status: number; body: unknown }>;
    subscribeRealtime: (listener: (event: RealtimeEvent) => void) => () => void;
    openSettingsWindow?: () => Promise<void>;
  };
};

function setDesktopWindow(windowValue?: DesktopWindow): void {
  if (windowValue) {
    Object.defineProperty(globalThis, "window", {
      value: windowValue,
      configurable: true,
      writable: true,
    });
    return;
  }

  Reflect.deleteProperty(globalThis, "window");
}

test("controlPlaneFetch forwards renderer requests through the desktop bridge when available", async (t) => {
  const calls: Array<{ channel: string; payload: unknown }> = [];

  setDesktopWindow({
    icaDesktop: {
      async request(channel: "control-plane.request", payload: unknown) {
        calls.push({ channel, payload });
        return {
          status: 200,
          body: { ok: true, via: "desktop" },
        };
      },
      subscribeRealtime() {
        return () => undefined;
      },
    },
  } as unknown as DesktopWindow);

  t.after(() => {
    setDesktopWindow(undefined);
  });

  const response = await controlPlaneFetch("/api/v1/install/apply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ targets: ["codex"] }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, via: "desktop" });
  assert.deepEqual(calls, [
    {
      channel: "control-plane.request",
      payload: {
        pathname: "/api/v1/install/apply",
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: {
          targets: ["codex"],
        },
      },
    },
  ]);
});

test("controlPlaneFetch falls back to browser fetch when no desktop bridge is available", async (t) => {
  const originalFetch = globalThis.fetch;
  setDesktopWindow(undefined);
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true, via: "http" }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    })) as typeof fetch;

  t.after(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
      return;
    }
    Reflect.deleteProperty(globalThis, "fetch");
  });

  const response = await controlPlaneFetch("/api/v1/sources");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, via: "http" });
});

test("desktop-mode renderer must fail explicitly instead of silently falling back to browser fetch when the host bridge is unavailable", () => {
  const clientSource = fs.readFileSync(`${process.cwd()}/src/installer-dashboard/web/src/control-plane-client.ts`, "utf8");

  assert.match(clientSource, /type RealtimeStatus = "connected" \| "reconnecting" \| "disconnected" \| "web-preview"/);
  assert.match(clientSource, /getRuntimeInfo/);
  assert.match(clientSource, /host bridge unavailable/i);
  assert.doesNotMatch(clientSource, /if \(!desktopBridge\) {\s*return fetch\(pathname, init\);\s*}/m);
});

test("openSettingsWindow routes through the desktop bridge when available", async (t) => {
  let openCalls = 0;

  setDesktopWindow({
    icaDesktop: {
      async request() {
        return {
          status: 200,
          body: {},
        };
      },
      subscribeRealtime() {
        return () => undefined;
      },
      async openSettingsWindow() {
        openCalls += 1;
      },
    },
  } as unknown as DesktopWindow);

  t.after(() => {
    setDesktopWindow(undefined);
  });

  await openSettingsWindow();

  assert.equal(openCalls, 1);
});

test("startControlPlaneRealtimeClient consumes realtime events from the desktop bridge", async (t) => {
  const statuses: string[] = [];
  const events: RealtimeEvent[] = [];
  let disposeCalled = false;
  let listener: ((event: RealtimeEvent) => void) | null = null;

  setDesktopWindow({
    icaDesktop: {
      async request() {
        return {
          status: 200,
          body: {},
        };
      },
      subscribeRealtime(nextListener: (event: RealtimeEvent) => void) {
        listener = nextListener;
        return () => {
          disposeCalled = true;
        };
      },
    },
  } as unknown as DesktopWindow);

  t.after(() => {
    setDesktopWindow(undefined);
  });

  const stop = startControlPlaneRealtimeClient({
    onStatusChange(status) {
      statuses.push(status);
    },
    onEvent(event) {
      events.push(event);
    },
  });

  assert.deepEqual(statuses, ["connected"]);
  assert.equal(typeof listener, "function");

  if (!listener) {
    throw new Error("Realtime desktop listener was not registered.");
  }

  const emitRealtimeEvent = listener as (event: RealtimeEvent) => void;
  emitRealtimeEvent({
    id: "evt_1",
    ts: "2026-03-11T00:00:00.000Z",
    channel: "operation",
    type: "operation.completed",
    payload: {
      ok: true,
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "operation.completed");

  stop();
  assert.equal(disposeCalled, true);
});

test("web preview mode remains allowed to use browser realtime fallback", () => {
  const clientSource = fs.readFileSync(`${process.cwd()}/src/installer-dashboard/web/src/control-plane-client.ts`, "utf8");

  assert.match(clientSource, /web-preview/);
  assert.match(clientSource, /new WebSocket\(/);
  assert.match(clientSource, /controlPlaneFetch\("\/api\/v1\/ws\/session"/);
});
