import test from "node:test";
import assert from "node:assert/strict";
import { assertPathWithin } from "../../src/installer-core/security";

test("assertPathWithin allows in-tree paths", () => {
  assert.doesNotThrow(() => assertPathWithin("/tmp/base", "/tmp/base/skills/developer"));
});

test("assertPathWithin blocks path traversal", () => {
  assert.throws(() => assertPathWithin("/tmp/base", "/tmp/base/../etc/passwd"));
});
