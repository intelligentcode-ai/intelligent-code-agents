import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

test("CLI help advertises serve/launch commands", () => {
  const cli = readFile("src/installer-cli/index.ts");
  assert.match(cli, /ica serve \[--host=127\.0\.0\.1\] \[--ui-port=4173\] \[--open=true\|false\]/);
  assert.match(cli, /ica launch \(alias for serve; deprecated\)/);
});

test("CLI main dispatch handles serve and launch", () => {
  const cli = readFile("src/installer-cli/index.ts");
  assert.match(cli, /if \(normalized === "serve"\) \{/);
  assert.match(cli, /if \(normalized === "launch"\) \{/);
  assert.match(cli, /await runServe\(options\);/);
});
