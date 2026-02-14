import test from "node:test";
import assert from "node:assert/strict";
import http, { IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { createInstallerBffServer } from "../../src/installer-bff/server/index";

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => void,
): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

test("BFF startup rejects non-loopback host", async () => {
  await assert.rejects(
    createInstallerBffServer({
      host: "0.0.0.0",
      port: 41731,
      staticOrigin: "http://127.0.0.1:65535",
      apiOrigin: "http://127.0.0.1:65535",
      apiKey: "secret",
    }),
    /loopback/i,
  );
});

test("BFF onRequest hook blocks non-loopback clients", async (t) => {
  const app = await createInstallerBffServer({
    host: "127.0.0.1",
    port: 41731,
    staticOrigin: "http://127.0.0.1:65535",
    apiOrigin: "http://127.0.0.1:65535",
    apiKey: "secret",
  });
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/health",
    remoteAddress: "8.8.8.8",
  });

  assert.equal(response.statusCode, 403);
});

test("BFF strips browser api key and injects server api key upstream", async (t) => {
  const upstream = await startServer((req, res) => {
    if (req.url === "/api/v1/echo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          apiKey: req.headers["x-ica-api-key"],
          custom: req.headers["x-custom"],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  t.after(async () => {
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  });

  const app = await createInstallerBffServer({
    host: "127.0.0.1",
    port: 41731,
    staticOrigin: upstream.origin,
    apiOrigin: upstream.origin,
    apiKey: "server-secret",
  });
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/echo",
    headers: {
      "x-ica-api-key": "attacker-supplied",
      "x-custom": "kept",
    },
    remoteAddress: "127.0.0.1",
  });

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body) as { apiKey?: string; custom?: string };
  assert.equal(payload.apiKey, "server-secret");
  assert.equal(payload.custom, "kept");
});

test("BFF rejects non-local browser origins on API routes", async (t) => {
  let upstreamCalled = false;
  const upstream = await startServer((req, res) => {
    upstreamCalled = true;
    if (req.url === "/api/v1/echo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end();
  });
  t.after(async () => {
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  });

  const app = await createInstallerBffServer({
    host: "127.0.0.1",
    port: 41731,
    staticOrigin: upstream.origin,
    apiOrigin: upstream.origin,
    apiKey: "server-secret",
  });
  t.after(async () => {
    await app.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/echo",
    headers: {
      origin: "https://evil.example",
    },
    remoteAddress: "127.0.0.1",
  });

  assert.equal(response.statusCode, 403);
  assert.equal(upstreamCalled, false);
});
