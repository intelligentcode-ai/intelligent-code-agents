import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { safeErrorMessage } from "../../installer-core/security";
import { findRepoRoot } from "../../installer-core/repo";

function sanitizeError(value: unknown, fallback = "Operation failed."): string {
  return safeErrorMessage(value, fallback);
}

async function main(): Promise<void> {
  const app = Fastify({ logger: false });
  const repoRoot = findRepoRoot(__dirname);
  const webBuildPath = path.join(repoRoot, "dist", "installer-dashboard", "web-build");

  if (!fs.existsSync(path.join(webBuildPath, "index.html"))) {
    throw new Error("Dashboard web assets not built. Run: npm run build:dashboard:web");
  }

  await app.register(fastifyStatic, {
    root: webBuildPath,
    prefix: "/",
  });

  app.get("/health", async () => ({ ok: true, service: "ica-dashboard-static" }));

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.type("text/html").send(fs.readFileSync(path.join(webBuildPath, "index.html"), "utf8"));
  });

  const host = process.env.ICA_DASHBOARD_HOST || "127.0.0.1";
  const port = Number(process.env.ICA_DASHBOARD_PORT || "4173");
  await app.listen({ host, port });
  process.stdout.write(`ICA static dashboard listening at http://${host}:${port}\n`);
}

main().catch((error) => {
  process.stderr.write(`Dashboard startup failed: ${sanitizeError(error)}\n`);
  process.exitCode = 1;
});
