import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

test("serve orchestrates both API and BFF runtimes", () => {
  const cliPath = path.join(repoRoot, "src/installer-cli/index.ts");
  const source = fs.readFileSync(cliPath, "utf8");

  assert.match(source, /"installer-api",\s*"server",\s*"index\.js"/, "serve should reference installer API runtime");
  assert.match(source, /"installer-bff",\s*"server",\s*"index\.js"/, "serve should reference installer BFF runtime");
  assert.match(source, /spawn\(process\.execPath,\s*\[apiScript\]/, "serve should spawn API runtime process");
  assert.match(source, /spawn\(process\.execPath,\s*\[bffScript\]/, "serve should spawn BFF runtime process");
});

test("serve maps frontend container to localhost-only internal port without bind mounts", () => {
  const cliPath = path.join(repoRoot, "src/installer-cli/index.ts");
  const source = fs.readFileSync(cliPath, "utf8");

  assert.match(source, /127\.0\.0\.1:\$\{uiContainerPort\}:80/, "serve should publish container on loopback only");
  assert.doesNotMatch(source, /\b-v\b|\s--volume\b/, "serve docker run args should not include bind mounts");
});

test("serve configures BFF with API key injection upstream, not browser runtime config", () => {
  const cliPath = path.join(repoRoot, "src/installer-cli/index.ts");
  const source = fs.readFileSync(cliPath, "utf8");

  assert.match(source, /ICA_BFF_API_KEY/, "serve should pass API key to BFF process");
  assert.match(source, /ICA_BFF_API_ORIGIN/, "serve should pass API origin to BFF process");
  assert.match(source, /ICA_BFF_STATIC_ORIGIN/, "serve should pass static UI origin to BFF process");
  assert.doesNotMatch(source, /ICA_UI_API_KEY/, "serve should not expose API key to browser/container env");
});
