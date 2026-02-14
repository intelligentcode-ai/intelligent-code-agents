import test from "node:test";
import assert from "node:assert/strict";
import { assertPathWithin, hasExecutable, redactSensitive, safeErrorMessage, stripUrlCredentials } from "../../src/installer-core/security";

test("assertPathWithin allows in-tree paths", () => {
  assert.doesNotThrow(() => assertPathWithin("/tmp/base", "/tmp/base/skills/developer"));
});

test("assertPathWithin blocks path traversal", () => {
  assert.throws(() => assertPathWithin("/tmp/base", "/tmp/base/../etc/passwd"));
});

test("redactSensitive strips URL credentials and token-like values", () => {
  const input = "failed to fetch https://oauth2:mySecretCredential@github.com/org/repo.git token=abc123";
  const redacted = redactSensitive(input);
  assert.equal(redacted.includes("mySecretCredential"), false);
  assert.equal(redacted.includes("abc123"), false);
  assert.equal(redacted.includes("<redacted>"), true);
});

test("stripUrlCredentials removes credentials from https URLs", () => {
  const clean = stripUrlCredentials("https://oauth2:myCredential1234567890@github.com/org/repo.git");
  assert.equal(clean, "https://github.com/org/repo.git");
});

test("safeErrorMessage redacts secrets", () => {
  const message = safeErrorMessage(new Error("authorization: bearer super-secret-token"));
  assert.equal(message.includes("super-secret-token"), false);
  assert.equal(message.includes("<redacted>"), true);
});

test("hasExecutable probes with which on unix-like platforms", async () => {
  let calledWith: { command: string; args: string[] } | null = null;
  const found = await hasExecutable(
    "git",
    "linux",
    async (command, args) => {
      calledWith = { command, args };
    },
  );
  assert.equal(found, true);
  assert.deepEqual(calledWith, { command: "which", args: ["git"] });
});
