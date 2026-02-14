import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket, { RawData } from "ws";
import { safeErrorMessage } from "../../installer-core/security";

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const ALLOWED_ORIGIN_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface InstallerBffServerOptions {
  host?: string;
  port?: number;
  staticOrigin?: string;
  apiOrigin?: string;
  apiKey?: string;
}

function sanitizeError(value: unknown, fallback = "Request failed."): string {
  return safeErrorMessage(value, fallback);
}

function headerValue(input: string | string[] | undefined): string | undefined {
  if (Array.isArray(input)) {
    return input.join(", ");
  }
  return input;
}

function buildForwardHeaders(request: FastifyRequest, injectApiKey?: string): Headers {
  const headers = new Headers();
  for (const [key, rawValue] of Object.entries(request.headers)) {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      lower === "connection" ||
      lower === "content-length" ||
      lower === "upgrade" ||
      lower.startsWith("sec-websocket-") ||
      lower === "x-ica-api-key"
    ) {
      continue;
    }
    const value = headerValue(rawValue);
    if (!value) continue;
    headers.set(key, value);
  }
  if (injectApiKey) {
    headers.set("x-ica-api-key", injectApiKey);
  }
  return headers;
}

function isLoopback(ip: string): boolean {
  return LOOPBACK_IPS.has(ip);
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  try {
    const url = new URL(origin);
    return ALLOWED_ORIGIN_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function toWsOrigin(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function proxyRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  targetOrigin: string,
  injectApiKey?: string,
): Promise<void> {
  const url = new URL(request.raw.url || "/", targetOrigin);
  const headers = buildForwardHeaders(request, injectApiKey);

  let body: BodyInit | undefined;
  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) {
    if (typeof request.body === "string" || request.body instanceof Uint8Array || request.body instanceof ArrayBuffer) {
      body = request.body as BodyInit;
    } else if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
  }

  const upstream = await fetch(url, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });

  for (const [key, value] of upstream.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === "transfer-encoding" || lower === "connection" || lower === "keep-alive") {
      continue;
    }
    reply.header(key, value);
  }

  const payload = Buffer.from(await upstream.arrayBuffer());
  await reply.code(upstream.status).send(payload);
}

export async function createInstallerBffServer(options: InstallerBffServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const host = options.host || process.env.ICA_BFF_HOST || "127.0.0.1";
  const port = options.port ?? Number(process.env.ICA_BFF_PORT || "4173");
  const staticOrigin = options.staticOrigin || process.env.ICA_BFF_STATIC_ORIGIN || "http://127.0.0.1:4180";
  const apiOrigin = options.apiOrigin || process.env.ICA_BFF_API_ORIGIN || "http://127.0.0.1:4174";
  const apiKey = options.apiKey || process.env.ICA_BFF_API_KEY || "";

  if (!apiKey) {
    throw new Error("ICA_BFF_API_KEY is required.");
  }
  if (!isLoopback(host)) {
    throw new Error(`ICA BFF host must be loopback. Received '${host}'.`);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`ICA BFF port must be a valid TCP port. Received '${String(port)}'.`);
  }

  await app.register(fastifyWebsocket);

  app.addHook("onRequest", async (request, reply) => {
    if (!isLoopback(request.ip)) {
      return reply.code(403).send({ error: "Forbidden: dashboard proxy accepts loopback requests only." });
    }

    const pathname = request.raw.url || "/";
    const isControlPlaneRoute =
      pathname === "/api/v1" || pathname.startsWith("/api/v1/") || pathname === "/ws/events" || pathname.startsWith("/ws/events?");
    const requestOrigin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
    if (isControlPlaneRoute && !isAllowedOrigin(requestOrigin)) {
      return reply.code(403).send({ error: "Forbidden: dashboard proxy only accepts local browser origins." });
    }
  });

  app.get("/health", async () => ({ ok: true, service: "ica-dashboard-bff" }));

  app.all("/api/v1/*", async (request, reply) => {
    try {
      await proxyRequest(request, reply, apiOrigin, apiKey);
    } catch (error) {
      await reply.code(502).send({ error: sanitizeError(error, "Failed to proxy API request.") });
    }
  });

  app.get("/ws/events", { websocket: true }, (downstream, request) => {
    if (!isLoopback(request.ip)) {
      downstream.close(1008, "Forbidden");
      return;
    }
    if (!isAllowedOrigin(typeof request.headers.origin === "string" ? request.headers.origin : undefined)) {
      downstream.close(1008, "Forbidden");
      return;
    }

    const upstream = new WebSocket(new URL(request.raw.url || "/ws/events", toWsOrigin(apiOrigin)).toString(), {
      headers: {
        origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
      },
    });

    downstream.on("message", (data: RawData, isBinary: boolean) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });
    upstream.on("message", (data: RawData, isBinary: boolean) => {
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.send(data, { binary: isBinary });
      }
    });

    downstream.on("close", () => {
      try {
        upstream.close();
      } catch {
        // ignore
      }
    });
    upstream.on("close", () => {
      try {
        downstream.close();
      } catch {
        // ignore
      }
    });

    downstream.on("error", () => {
      try {
        upstream.terminate();
      } catch {
        // ignore
      }
    });
    upstream.on("error", () => {
      try {
        downstream.close(1011, "Upstream websocket failed");
      } catch {
        // ignore
      }
    });
  });

  app.all("/*", async (request, reply) => {
    try {
      const path = request.raw.url || "/";
      const targetPath = path === "/" ? "/index.html" : path;
      const targetUrl = new URL(targetPath, staticOrigin);
      const headers = buildForwardHeaders(request);
      const upstream = await fetch(targetUrl, { method: request.method, headers, redirect: "manual" });

      let status = upstream.status;
      let headersToSend = upstream.headers;
      let payload = Buffer.from(await upstream.arrayBuffer());

      if (status === 404 && !path.includes(".")) {
        const fallback = await fetch(new URL("/index.html", staticOrigin), { method: "GET" });
        status = fallback.status;
        headersToSend = fallback.headers;
        payload = Buffer.from(await fallback.arrayBuffer());
      }

      for (const [key, value] of headersToSend.entries()) {
        const lower = key.toLowerCase();
        if (lower === "transfer-encoding" || lower === "connection" || lower === "keep-alive") {
          continue;
        }
        reply.header(key, value);
      }
      await reply.code(status).send(payload);
    } catch (error) {
      await reply.code(502).send({ error: sanitizeError(error, "Failed to proxy dashboard asset request.") });
    }
  });

  return app;
}

async function main(): Promise<void> {
  const host = process.env.ICA_BFF_HOST || "127.0.0.1";
  const port = Number(process.env.ICA_BFF_PORT || "4173");
  const staticOrigin = process.env.ICA_BFF_STATIC_ORIGIN || "http://127.0.0.1:4180";
  const apiOrigin = process.env.ICA_BFF_API_ORIGIN || "http://127.0.0.1:4174";
  const apiKey = process.env.ICA_BFF_API_KEY || "";

  const app = await createInstallerBffServer({
    host,
    port,
    staticOrigin,
    apiOrigin,
    apiKey,
  });
  await app.listen({ host, port });
  process.stdout.write(`ICA dashboard BFF listening at http://${host}:${port}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`BFF startup failed: ${sanitizeError(error)}\n`);
    process.exitCode = 1;
  });
}
