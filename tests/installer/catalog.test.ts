import test from "node:test";
import assert from "node:assert/strict";
import { buildLocalCatalog } from "../../src/installer-core/catalog";

test("buildLocalCatalog defaults to deterministic generatedAt", () => {
  const catalog = buildLocalCatalog(process.cwd(), "1.0.0");
  assert.equal(catalog.generatedAt, "1970-01-01T00:00:00.000Z");
});

test("buildLocalCatalog honors SOURCE_DATE_EPOCH when numeric", () => {
  const catalog = buildLocalCatalog(process.cwd(), "1.0.0", "1735689600");
  assert.equal(catalog.generatedAt, "2025-01-01T00:00:00.000Z");
});

test("buildLocalCatalog falls back when SOURCE_DATE_EPOCH is invalid", () => {
  const catalog = buildLocalCatalog(process.cwd(), "1.0.0", "not-a-number");
  assert.equal(catalog.generatedAt, "1970-01-01T00:00:00.000Z");
});
