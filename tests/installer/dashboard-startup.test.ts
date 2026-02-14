import test from "node:test";
import assert from "node:assert/strict";
import { retryWithBackoff, runStartupTasks } from "../../src/installer-dashboard/web/src/startup";

test("retryWithBackoff retries transient startup calls before succeeding", async () => {
  let attempts = 0;
  const value = await retryWithBackoff(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("temporary");
      }
      return "ok";
    },
    { attempts: 3, initialDelayMs: 1 },
  );

  assert.equal(value, "ok");
  assert.equal(attempts, 3);
});

test("runStartupTasks degrades non-critical startup failures to warnings", async () => {
  const summary = await runStartupTasks([
    {
      id: "sources",
      critical: true,
      run: async () => undefined,
    },
    {
      id: "catalog",
      critical: false,
      run: async () => {
        throw new Error("catalog transient");
      },
    },
  ]);

  assert.deepEqual(summary.errors, []);
  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0], /catalog/i);
});

test("runStartupTasks returns blocking errors for critical startup failures", async () => {
  const summary = await runStartupTasks([
    {
      id: "targets",
      critical: true,
      run: async () => {
        throw new Error("targets unavailable");
      },
    },
  ]);

  assert.equal(summary.warnings.length, 0);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0], /targets/i);
});

test("runStartupTasks collapses API unreachable failures into one actionable error", async () => {
  const apiUnavailableError = Object.assign(new Error("Cannot reach ICA API at http://127.0.0.1:4174"), {
    code: "ICA_API_UNREACHABLE",
  });

  const summary = await runStartupTasks([
    {
      id: "health",
      critical: false,
      run: async () => {
        throw apiUnavailableError;
      },
    },
    {
      id: "targets",
      critical: true,
      run: async () => {
        throw new Error("should not run after api unavailable");
      },
    },
  ]);

  assert.equal(summary.warnings.length, 0);
  assert.equal(summary.errors.length, 1);
  assert.match(summary.errors[0], /Cannot reach ICA API/i);
});
