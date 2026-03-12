import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

function readCliSource(): string {
  return fs.readFileSync(path.join(repoRoot, "src/installer-cli/index.ts"), "utf8");
}

test("serve and launch share a single removed-command helper", () => {
  const source = readCliSource();

  assert.match(source, /async function runRemovedBrowserCommand\(/, "CLI should define one shared browser-command removal helper");
  assert.match(source, /if \(normalized === "serve" \|\| normalized === "launch"\) \{/, "serve and launch should use the same dispatch path");
});

test("launch no longer delegates to the legacy serve runtime", () => {
  const source = readCliSource();

  assert.doesNotMatch(source, /await runLaunch\(options\);/, "main dispatch should not invoke a dedicated launch alias path");
  assert.doesNotMatch(source, /await runServe\(options\);/, "legacy browser runtime should not remain reachable from CLI dispatch");
  assert.doesNotMatch(source, /alias of `ica serve`/, "source should not describe launch as a still-working alias");
});

test("help text treats serve-only flags as removed browser-runtime details", () => {
  const source = readCliSource();

  assert.match(source, /npm run start:desktop/, "help text should direct users to the desktop workflow");
  assert.doesNotMatch(source, /--build-image=auto\|always\|never/, "help text should not advertise removed serve-only flags");
  assert.doesNotMatch(source, /--reuse-ports=true\|false/, "help text should not advertise removed serve-only flags");
  assert.doesNotMatch(source, /--sources-refresh-minutes=60 \(serve only/, "help text should not advertise removed serve-only flags");
});
