import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const cliPath = path.join(repoRoot, "dist", "src", "installer-cli", "index.js");

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 20000,
    killSignal: "SIGKILL",
  });
}

test("CLI help promotes desktop-first startup and no longer advertises browser serve workflows", () => {
  const result = runCli([]);

  assert.equal(result.status, 0, "CLI help should exit cleanly");
  assert.match(result.stdout, /npm run start:desktop/, "CLI help should direct local users to the desktop workflow");
  assert.match(
    result.stdout,
    /Legacy browser commands: `ica serve` and `ica launch` have been removed\./,
    "CLI help should explain the browser-command migration",
  );
  assert.doesNotMatch(
    result.stdout,
    /ica serve \[--host=127\.0\.0\.1\]/,
    "CLI help should not advertise the removed serve workflow as supported",
  );
  assert.doesNotMatch(
    result.stdout,
    /ica launch \(alias for serve; deprecated\)/,
    "CLI help should not advertise the removed launch alias as supported",
  );
});

for (const command of ["serve", "launch"]) {
  test(`CLI ${command} fails fast with the shared desktop migration message`, () => {
    const result = runCli([command]);
    const output = `${result.stdout}\n${result.stderr}`;

    assert.notEqual(result.status, 0, `${command} should exit non-zero once removed`);
    assert.match(
      output,
      /Legacy browser commands: `ica serve` and `ica launch` have been removed\./,
      `${command} should explain that the browser commands were removed`,
    );
    assert.match(output, /npm run start:desktop/, `${command} should point users to the desktop entrypoint`);
    assert.doesNotMatch(
      output,
      /alias of `ica serve`/,
      `${command} should not describe launch as a still-working alias`,
    );
  });
}
