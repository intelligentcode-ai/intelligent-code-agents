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

test("bootstrap shell installer documents dashboard launch command", () => {
  const scriptPath = path.join(repoRoot, "scripts/bootstrap/install.sh");
  const source = fs.readFileSync(scriptPath, "utf8");

  assert.match(source, /\bica launch\b/, "install.sh should tell users how to launch the dashboard");
});

test("bootstrap powershell installer pulls source release artifact", () => {
  const scriptPath = path.join(repoRoot, "scripts/bootstrap/install.ps1");
  const source = fs.readFileSync(scriptPath, "utf8");

  assert.match(source, /source\.tar\.gz/, "install.ps1 should reference source tarball artifacts");
});

test("bootstrap powershell installer documents dashboard launch command", () => {
  const scriptPath = path.join(repoRoot, "scripts/bootstrap/install.ps1");
  const source = fs.readFileSync(scriptPath, "utf8");

  assert.match(source, /\bica launch\b/i, "install.ps1 should tell users how to launch the dashboard");
});

test("CLI help exposes dashboard launch command", () => {
  const cliPath = path.join(repoRoot, "dist/src/installer-cli/index.js");
  const result = spawnSync(process.execPath, [cliPath], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, "CLI help should exit cleanly");
  assert.match(result.stdout, /\bica launch\b/, "CLI help should include launch command");
});
