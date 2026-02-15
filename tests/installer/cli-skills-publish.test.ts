import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function readCliSource(): string {
  return fs.readFileSync(path.resolve(process.cwd(), "src/installer-cli/index.ts"), "utf8");
}

test("CLI help advertises skills publish workflows", () => {
  const cli = readCliSource();
  assert.match(cli, /ica skills validate --path=<local-skill-dir> --profile=personal\|official/);
  assert.match(cli, /ica skills publish --source=<id> --path=<local-skill-dir>/);
  assert.match(cli, /ica skills contribute-official --path=<local-skill-dir>/);
});

test("CLI dispatch supports skills command", () => {
  const cli = readCliSource();
  assert.match(cli, /if \(normalized === "skills"\) \{/);
  assert.match(cli, /await runSkills\(positionals,\s*options\);/);
});

test("CLI source updates include publish defaults flags", () => {
  const cli = readCliSource();
  assert.match(cli, /publishDefaultMode:\s*parsePublishModeOption\(options,\s*"publish-default-mode"\)/);
  assert.match(cli, /defaultBaseBranch:\s*stringOption\(options,\s*"default-base-branch",\s*""\)\s*\|\|\s*undefined/);
  assert.match(cli, /providerHint:\s*parseProviderHintOption\(options,\s*"provider-hint"\)/);
});
