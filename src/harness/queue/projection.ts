import fs from "node:fs";
import path from "node:path";
import { WorkItem, WorkItemStatus } from "../types";

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 64);
}

function queueStatus(status: WorkItemStatus): "pending" | "in_progress" | "completed" | "blocked" {
  if (status === "executing" || status === "verifying") {
    return "in_progress";
  }
  if (status === "completed") {
    return "completed";
  }
  if (status === "blocked" || status === "failed" || status === "needs_input") {
    return "blocked";
  }
  return "pending";
}

export function syncQueueItem(workItem: WorkItem): string {
  const queueDir = path.join(workItem.project_path, ".agent", "queue");
  fs.mkdirSync(queueDir, { recursive: true });

  const prefix = String(workItem.id).padStart(3, "0");
  const status = queueStatus(workItem.status);
  const name = `${prefix}-${status}-${slug(workItem.title || workItem.kind)}.md`;
  const nextPath = path.join(queueDir, name);

  for (const existing of fs.readdirSync(queueDir)) {
    if (existing.startsWith(`${prefix}-`) && existing !== name) {
      fs.rmSync(path.join(queueDir, existing), { force: true });
    }
  }

  const content = [
    `# ${workItem.title}`,
    "",
    `- Work Item ID: ${workItem.id}`,
    `- Kind: ${workItem.kind}`,
    `- Status: ${workItem.status}`,
    `- Priority: ${workItem.priority}`,
    `- Updated At: ${workItem.updated_at}`,
    "",
    "## Body (Markdown)",
    workItem.body_md || "",
  ].join("\n");

  fs.writeFileSync(nextPath, content);
  return nextPath;
}
