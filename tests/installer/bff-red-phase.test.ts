import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

test("RED: serve should not inject ICA_UI_API_KEY into container runtime env", () => {
  const cliPath = path.join(repoRoot, "src/installer-cli/index.ts");
  const source = fs.readFileSync(cliPath, "utf8");
  assert.doesNotMatch(source, /ICA_UI_API_KEY=/, "BFF architecture should remove browser/container API key injection.");
});

test("RED: frontend API client should not attach x-ica-api-key header", () => {
  const apiClientPath = path.join(repoRoot, "src/installer-dashboard/web/src/api-client.ts");
  const source = fs.readFileSync(apiClientPath, "utf8");
  assert.doesNotMatch(source, /x-ica-api-key/i, "Browser requests should be same-origin without API key headers.");
});

test("RED: dashboard index should not bootstrap runtime-config.js", () => {
  const indexPath = path.join(repoRoot, "src/installer-dashboard/web/index.html");
  const source = fs.readFileSync(indexPath, "utf8");
  assert.doesNotMatch(source, /runtime-config\.js/, "runtime-config.js should be removed in host-BFF mode.");
});

test("RED: host BFF server entrypoint should exist", () => {
  const bffServerPath = path.join(repoRoot, "src/installer-bff/server/index.ts");
  assert.equal(fs.existsSync(bffServerPath), true, "Host BFF module must exist for same-origin proxying.");
});
