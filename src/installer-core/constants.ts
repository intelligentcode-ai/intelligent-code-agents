import path from "node:path";
import { TargetPlatform } from "./types";

export const SUPPORTED_TARGETS: TargetPlatform[] = ["claude", "codex", "cursor", "gemini", "antigravity"];

export const TARGET_HOME_DIR: Record<TargetPlatform, string> = {
  claude: ".claude",
  codex: ".codex",
  cursor: ".cursor",
  gemini: ".gemini",
  antigravity: ".antigravity",
};

export const BASELINE_DIRECTORIES = ["behaviors", "roles", "agenttask-templates"];
export const BASELINE_FILES = ["VERSION", "ica.config.default.json", "ica.workflow.default.json"];

export function repoRootFromFile(fileDir: string): string {
  // src/installer-core -> repo root
  return path.resolve(fileDir, "../..");
}
