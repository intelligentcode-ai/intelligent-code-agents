import path from "node:path";
import { InstallScope } from "./types";

export function workflowNameFromSkillName(skillName: string): string {
  const normalized = skillName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized || "workflow";
}

export function antigravityWorkflowDirectory(scope: InstallScope): string {
  return scope === "user" ? "global_workflows" : "workflows";
}

export function antigravityWorkflowPath(basePath: string, scope: InstallScope): string {
  return path.join(basePath, antigravityWorkflowDirectory(scope));
}
