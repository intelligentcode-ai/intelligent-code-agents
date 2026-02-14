import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = process.cwd();

async function waitForApiReady(port: number, apiKey: string, retries = 40): Promise<void> {
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        headers: { "x-ica-api-key": apiKey },
      });
      if (res.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("API did not become ready in time.");
}

test("API requires x-ica-api-key for /api/v1 routes", async () => {
  const apiScript = path.join(repoRoot, "dist/src/installer-api/server/index.js");
  const port = 42740 + Math.floor(Math.random() * 2000);
  const apiKey = "test-api-key";

  const child = spawn(process.execPath, [apiScript], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ICA_API_HOST: "127.0.0.1",
      ICA_API_PORT: String(port),
      ICA_API_KEY: apiKey,
      ICA_UI_PORT: "4173",
    },
  });

  try {
    await waitForApiReady(port, apiKey);

    const missing = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    assert.equal(missing.status, 401);

    const wrong = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { "x-ica-api-key": "wrong-key" },
    });
    assert.equal(wrong.status, 401);

    const correct = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { "x-ica-api-key": apiKey },
    });
    assert.equal(correct.status, 200);
    const healthPayload = (await correct.json()) as { version?: string };
    assert.match(String(healthPayload.version || ""), /^\d+\.\d+\.\d+/, "health should include installer version");

    const preflightAllowed = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:4173",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-ica-api-key",
      },
    });
    assert.ok(preflightAllowed.status < 400, "allowed local preflight should succeed");

    const preflightBlocked = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://evil.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-ica-api-key",
      },
    });
    assert.ok(preflightBlocked.status >= 400, "non-local preflight should be rejected");
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1500);
    });
  }
});
