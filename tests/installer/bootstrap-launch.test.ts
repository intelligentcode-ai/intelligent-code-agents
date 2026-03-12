import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();

test("bootstrap shell installer pulls source release artifact", () => {
  const scriptPath = path.join(repoRoot, "scripts/bootstrap/install.sh");
  const source = fs.readFileSync(scriptPath, "utf8");

  assert.match(source, /source\.tar\.gz/, "install.sh should reference source tarball artifacts");
});

test("bootstrap shell installer documents the desktop startup workflow", () => {
  const scriptPath = path.join(repoRoot, "scripts/bootstrap/install.sh");
  const source = fs.readFileSync(scriptPath, "utf8");

  assert.match(source, /\bnpm run start:desktop\b/, "install.sh should point users to the desktop workflow");
  assert.doesNotMatch(source, /\bica serve\b/, "install.sh should not recommend the removed browser serve command");
});

test("bootstrap powershell installer pulls source release artifact", () => {
  const scriptPath = path.join(repoRoot, "scripts/bootstrap/install.ps1");
  const source = fs.readFileSync(scriptPath, "utf8");

  assert.match(source, /source\.tar\.gz/, "install.ps1 should reference source tarball artifacts");
});

test("bootstrap powershell installer documents the desktop startup workflow", () => {
  const scriptPath = path.join(repoRoot, "scripts/bootstrap/install.ps1");
  const source = fs.readFileSync(scriptPath, "utf8");

  assert.match(source, /\bnpm run start:desktop\b/i, "install.ps1 should point users to the desktop workflow");
  assert.doesNotMatch(source, /\bica serve\b/i, "install.ps1 should not recommend the removed browser serve command");
});

test("CLI help lists desktop startup guidance and removed browser command notice", () => {
  const cliPath = path.join(repoRoot, "dist/src/installer-cli/index.js");
  const result = spawnSync(process.execPath, [cliPath], { cwd: repoRoot, encoding: "utf8" });

  assert.equal(result.status, 0, "CLI help should exit cleanly");
  assert.match(result.stdout, /npm run start:desktop/, "CLI help should include desktop startup guidance");
  assert.match(
    result.stdout,
    /Legacy browser commands: `ica serve` and `ica launch` have been removed\./,
    "CLI help should describe the removed browser commands",
  );
  assert.doesNotMatch(result.stdout, /--build-image=auto\|always\|never/, "CLI help should not document removed serve-only flags");
  assert.doesNotMatch(result.stdout, /--reuse-ports=true\|false/, "CLI help should not document removed serve-only flags");
});
