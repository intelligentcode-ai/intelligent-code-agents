import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { applyClaudeIntegration } from "../../src/installer-core/claudeIntegration";

const repoRoot = path.resolve(__dirname, "../../..");

test("applyClaudeIntegration writes string matchers for managed PreToolUse hooks", async () => {
  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), "ica-claude-integration-"));
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "ica-claude-project-"));

  fs.writeFileSync(
    path.join(installPath, "settings.json"),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Read",
              hooks: [{ type: "command", command: "node /tmp/existing.js" }],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  await applyClaudeIntegration({
    repoRoot,
    installPath,
    scope: "project",
    projectPath,
    agentDirName: ".claude",
  });

  const settings = JSON.parse(fs.readFileSync(path.join(installPath, "settings.json"), "utf8")) as {
    hooks?: { PreToolUse?: Array<{ matcher?: unknown; hooks?: Array<{ command?: string }> }> };
  };

  const preToolUse = settings.hooks?.PreToolUse ?? [];
  const managed = preToolUse.filter((entry) =>
    entry.hooks?.some((hook) =>
      (hook.command || "").includes("agent-infrastructure-protection.js") ||
      (hook.command || "").includes("summary-file-enforcement.js"),
    ),
  );

  assert.equal(managed.length, 2);
  assert.ok(managed.every((entry) => typeof entry.matcher === "string"));
  const matchers = managed.map((entry) => String(entry.matcher)).sort();
  assert.deepEqual(matchers, ["^(BashTool|Bash)$", "^(FileWriteTool|FileEditTool|Write|Edit)$"]);
});

test("applyClaudeIntegration keeps unrelated hooks and replaces prior managed entries", async () => {
  const installPath = fs.mkdtempSync(path.join(os.tmpdir(), "ica-claude-integration-"));
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "ica-claude-project-"));

  fs.writeFileSync(
    path.join(installPath, "settings.json"),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "Read",
              hooks: [{ type: "command", command: "node /tmp/keep-me.js" }],
            },
            {
              matcher: "legacy",
              hooks: [{ type: "command", command: "node /tmp/hooks/agent-infrastructure-protection.js" }],
            },
            {
              matcher: "legacy",
              hooks: [{ type: "command", command: "node /tmp/hooks/summary-file-enforcement.js" }],
            },
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  await applyClaudeIntegration({
    repoRoot,
    installPath,
    scope: "project",
    projectPath,
    agentDirName: ".claude",
  });

  const settings = JSON.parse(fs.readFileSync(path.join(installPath, "settings.json"), "utf8")) as {
    hooks?: { PreToolUse?: Array<{ matcher?: unknown; hooks?: Array<{ command?: string }> }> };
  };
  const preToolUse = settings.hooks?.PreToolUse ?? [];

  const userReadHooks = preToolUse.filter((entry) =>
    entry.hooks?.some((hook) => (hook.command || "").includes("keep-me.js")),
  );
  assert.equal(userReadHooks.length, 1);

  const infraHooks = preToolUse.filter((entry) =>
    entry.hooks?.some((hook) => (hook.command || "").includes("agent-infrastructure-protection.js")),
  );
  assert.equal(infraHooks.length, 1);
  assert.equal(infraHooks[0].matcher, "^(BashTool|Bash)$");

  const summaryHooks = preToolUse.filter((entry) =>
    entry.hooks?.some((hook) => (hook.command || "").includes("summary-file-enforcement.js")),
  );
  assert.equal(summaryHooks.length, 1);
  assert.equal(summaryHooks[0].matcher, "^(FileWriteTool|FileEditTool|Write|Edit)$");
});
