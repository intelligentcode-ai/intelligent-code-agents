import path from "node:path";
import { copyPath, ensureDir, pathExists, readText, writeText } from "./fs";

function mergeHooks(settings: Record<string, unknown>, installPath: string): Record<string, unknown> {
  const hooks = (settings.hooks as Record<string, unknown>) || {};
  const preToolUse = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as unknown[]) : [];

  const filtered = preToolUse.filter((entry) => {
    if (!entry || typeof entry !== "object") return true;
    const value = entry as { hooks?: Array<{ command?: string }> };
    return !value.hooks?.some((hook) =>
      (hook.command || "").includes("agent-infrastructure-protection.js") ||
      (hook.command || "").includes("summary-file-enforcement.js"),
    );
  });

  filtered.push(
    {
      matcher: { tools: ["BashTool", "Bash"] },
      hooks: [
        {
          type: "command",
          command: `node ${path.join(installPath, "hooks", "agent-infrastructure-protection.js")}`,
          timeout: 5000,
        },
      ],
    },
    {
      matcher: { tools: ["FileWriteTool", "FileEditTool", "Write", "Edit"] },
      hooks: [
        {
          type: "command",
          command: `node ${path.join(installPath, "hooks", "summary-file-enforcement.js")}`,
          timeout: 5000,
        },
      ],
    },
  );

  return {
    ...settings,
    hooks: {
      ...hooks,
      PreToolUse: filtered,
    },
  };
}

async function ensureClaudeMdImport(claudeMdPath: string, importLine: string): Promise<void> {
  const existing = (await pathExists(claudeMdPath)) ? await readText(claudeMdPath) : "";
  if (existing.includes(importLine)) {
    return;
  }

  const header = existing.trim().length > 0 ? `${existing.trim()}\n` : "# Virtual Development Team\n";
  await writeText(claudeMdPath, `${header}${importLine}\n`);
}

export async function applyClaudeIntegration(params: {
  repoRoot: string;
  installPath: string;
  scope: "user" | "project";
  projectPath?: string;
  agentDirName: string;
}): Promise<void> {
  const modesSource = path.join(params.repoRoot, "src", "targets", "claude", "modes");
  const hooksSource = path.join(params.repoRoot, "src", "targets", "claude", "hooks");

  await ensureDir(path.join(params.installPath, "modes"));
  await ensureDir(path.join(params.installPath, "hooks"));

  await copyPath(modesSource, path.join(params.installPath, "modes"));
  await copyPath(hooksSource, path.join(params.installPath, "hooks"));

  const settingsPath = path.join(params.installPath, "settings.json");
  const settings = (await pathExists(settingsPath))
    ? (JSON.parse(await readText(settingsPath)) as Record<string, unknown>)
    : {};

  const merged = mergeHooks(settings, params.installPath);
  await writeText(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);

  const claudeMdPath =
    params.scope === "project" ? path.join(params.projectPath || "", "CLAUDE.md") : path.join(params.installPath, "CLAUDE.md");

  const importLine =
    params.scope === "project"
      ? `@./${params.agentDirName}/modes/virtual-team.md`
      : `@~/${params.agentDirName}/modes/virtual-team.md`;

  await ensureClaudeMdImport(claudeMdPath, importLine);
}
