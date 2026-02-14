import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

test("dashboard index does not load runtime-config bootstrap script", () => {
  const indexPath = path.join(repoRoot, "src/installer-dashboard/web/index.html");
  const source = fs.readFileSync(indexPath, "utf8");
  assert.doesNotMatch(source, /runtime-config\.js/, "index.html should not include runtime-config.js in BFF mode");
});

test("runtime config public fallback file is removed", () => {
  const runtimePath = path.join(repoRoot, "src/installer-dashboard/web/public/runtime-config.js");
  assert.equal(fs.existsSync(runtimePath), false, "runtime-config.js should not exist in frontend assets");
});

test("container image no longer injects runtime config", () => {
  const dockerfilePath = path.join(repoRoot, "src/installer-dashboard/Dockerfile");
  const source = fs.readFileSync(dockerfilePath, "utf8");
  assert.doesNotMatch(source, /40-ica-runtime-config\.sh/, "Dockerfile should not include runtime-config entrypoint script");
  assert.doesNotMatch(source, /ICA_UI_API_KEY/, "Dockerfile should not reference browser API key env");
});

test("nginx config does not expose runtime-config route", () => {
  const nginxConfigPath = path.join(repoRoot, "src/installer-dashboard/nginx/default.conf");
  const source = fs.readFileSync(nginxConfigPath, "utf8");
  assert.doesNotMatch(source, /runtime-config\.js/, "nginx should not define runtime-config.js route");
});
