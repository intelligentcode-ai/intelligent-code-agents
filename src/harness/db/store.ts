import fs from "node:fs";
import path from "node:path";
import {
  AgentInstallation,
  AuthProvider,
  AuthSession,
  AuthTokenRecord,
  Complexity,
  ExecutionProfile,
  Finding,
  HarnessConfig,
  McpProfile,
  RunResult,
  SkillProfile,
  Stage,
  WorkItem,
  WorkItemAttachment,
  WorkItemInput,
  WorkItemPatch,
  WorkItemStatus,
} from "../types";
import { applyMigrations } from "./migrate";
import { SqliteCli, sqlValue } from "./sqlite";

interface ProfilePayload {
  executionProfiles?: Array<
    Omit<ExecutionProfile, "id" | "created_at" | "updated_at" | "enabled"> & { enabled?: number }
  >;
  mcpProfiles?: Array<Omit<McpProfile, "id" | "created_at" | "updated_at">>;
  skillProfiles?: Array<Omit<SkillProfile, "id" | "created_at" | "updated_at">>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseAcceptance(acceptanceJson: string): string[] {
  try {
    const parsed = JSON.parse(acceptanceJson) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

export class HarnessStore {
  private readonly db: SqliteCli;
  private readonly config: HarnessConfig;

  constructor(repoRoot: string, config: HarnessConfig) {
    this.config = config;
    this.db = new SqliteCli(config.dbPath);
    applyMigrations(this.db, repoRoot);
    this.seedDefaults();
  }

  private seedDefaults(): void {
    const count = this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM execution_profiles;");
    if ((count?.n || 0) > 0) {
      return;
    }

    const ts = nowIso();
    const defaults: Array<[Complexity, Stage, string, string]> = [
      ["simple", "plan", "codex", "gpt-5"],
      ["simple", "execute", "codex", "gpt-5"],
      ["simple", "test", "codex", "gpt-5"],
      ["medium", "plan", "claude", "sonnet"],
      ["medium", "execute", "codex", "gpt-5"],
      ["medium", "test", "claude", "sonnet"],
      ["complex", "plan", "claude", "opus"],
      ["complex", "execute", "codex", "gpt-5"],
      ["complex", "test", "claude", "opus"],
    ];

    for (const [complexity, stage, agent, model] of defaults) {
      this.db.exec(`
        INSERT INTO execution_profiles(
          name, complexity, stage, runtime, agent, model, auth_mode,
          timeout_s, retries, enabled, created_at, updated_at
        ) VALUES (
          ${sqlValue(`${complexity}-${stage}`)}, ${sqlValue(complexity)}, ${sqlValue(stage)}, ${sqlValue(this.config.defaultRuntime)},
          ${sqlValue(agent)}, ${sqlValue(model)}, 'device_code',
          900, 1, 1, ${sqlValue(ts)}, ${sqlValue(ts)}
        );
      `);
    }
  }

  listWorkItems(filters: { status?: WorkItemStatus; kind?: string; limit?: number } = {}): WorkItem[] {
    const where: string[] = [];
    if (filters.status) {
      where.push(`status=${sqlValue(filters.status)}`);
    }
    if (filters.kind) {
      where.push(`kind=${sqlValue(filters.kind)}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filters.limit || 200;
    return this.db.query<WorkItem>(`
      SELECT *
      FROM work_items
      ${whereSql}
      ORDER BY priority ASC, created_at ASC
      LIMIT ${sqlValue(limit)};
    `);
  }

  getWorkItem(id: number): WorkItem | null {
    return this.db.first<WorkItem>(`SELECT * FROM work_items WHERE id=${sqlValue(id)}`);
  }

  getWorkItemDetails(id: number): {
    workItem: WorkItem | null;
    attachments: WorkItemAttachment[];
    runs: RunResult[];
    findings: Finding[];
    acceptanceCriteria: string[];
  } {
    const workItem = this.getWorkItem(id);
    const attachments = this.db.query<WorkItemAttachment>(
      `SELECT * FROM work_item_attachments WHERE work_item_id=${sqlValue(id)} ORDER BY id DESC;`,
    );
    const runs = this.db.query<RunResult>(
      `SELECT * FROM runs WHERE work_item_id=${sqlValue(id)} ORDER BY id DESC;`,
    );
    const findings = this.db.query<Finding>(
      `SELECT * FROM findings WHERE work_item_id=${sqlValue(id)} ORDER BY id DESC;`,
    );
    return {
      workItem,
      attachments,
      runs,
      findings,
      acceptanceCriteria: workItem ? parseAcceptance(workItem.acceptance_json) : [],
    };
  }

  createWorkItem(input: WorkItemInput): WorkItem {
    const ts = nowIso();
    const status = input.status || "new";
    const projectPath = input.projectPath || process.cwd();
    const acceptance = input.acceptanceCriteria || [];

    this.db.exec(`
      INSERT INTO work_items(
        kind, title, body_md, body_html, status,
        priority, severity, project_path, parent_id,
        acceptance_json, created_at, updated_at
      ) VALUES (
        ${sqlValue(input.kind)}, ${sqlValue(input.title)}, ${sqlValue(input.bodyMd || "")}, ${sqlValue(input.bodyHtml || "")},
        ${sqlValue(status)}, ${sqlValue(input.priority ?? 3)}, ${sqlValue(input.severity ?? null)}, ${sqlValue(projectPath)}, ${sqlValue(input.parentId ?? null)},
        ${sqlValue(JSON.stringify(acceptance))}, ${sqlValue(ts)}, ${sqlValue(ts)}
      );
    `);

    const created = this.db.first<WorkItem>("SELECT * FROM work_items ORDER BY id DESC");
    if (!created) {
      throw new Error("Failed to create work item.");
    }

    this.addEvent("work_item_created", "work_item", created.id, created);
    return created;
  }

  updateWorkItem(id: number, patch: WorkItemPatch): WorkItem {
    const current = this.getWorkItem(id);
    if (!current) {
      throw new Error(`Work item ${id} not found.`);
    }

    const next = {
      title: patch.title ?? current.title,
      bodyMd: patch.bodyMd ?? current.body_md,
      bodyHtml: patch.bodyHtml ?? current.body_html,
      status: patch.status ?? current.status,
      priority: patch.priority ?? current.priority,
      severity: patch.severity === undefined ? current.severity : patch.severity,
      acceptanceJson:
        patch.acceptanceCriteria !== undefined
          ? JSON.stringify(patch.acceptanceCriteria)
          : current.acceptance_json,
      closedAt:
        (patch.status ?? current.status) === "completed"
          ? nowIso()
          : (patch.status ?? current.status) === current.status
            ? current.closed_at
            : null,
    };

    this.db.exec(`
      UPDATE work_items
      SET
        title=${sqlValue(next.title)},
        body_md=${sqlValue(next.bodyMd)},
        body_html=${sqlValue(next.bodyHtml)},
        status=${sqlValue(next.status)},
        priority=${sqlValue(next.priority)},
        severity=${sqlValue(next.severity)},
        acceptance_json=${sqlValue(next.acceptanceJson)},
        updated_at=${sqlValue(nowIso())},
        closed_at=${sqlValue(next.closedAt)}
      WHERE id=${sqlValue(id)};
    `);

    const updated = this.getWorkItem(id);
    if (!updated) {
      throw new Error(`Unable to load work item ${id} after update.`);
    }

    this.addEvent("work_item_updated", "work_item", id, patch);
    return updated;
  }

  addAttachment(input: {
    workItemId: number;
    filename: string;
    mimeType: string;
    dataBase64: string;
    width?: number;
    height?: number;
  }): WorkItemAttachment {
    const workItem = this.getWorkItem(input.workItemId);
    if (!workItem) {
      throw new Error(`Work item ${input.workItemId} does not exist.`);
    }

    const bytes = Buffer.from(input.dataBase64, "base64");
    const hash = require("node:crypto").createHash("sha256").update(bytes).digest("hex") as string;
    const ext = input.filename.includes(".") ? "" : input.mimeType.split("/")[1] || "bin";
    const safeName = `${Date.now()}-${hash.slice(0, 12)}-${input.filename}`.replace(/[^a-zA-Z0-9._-]/g, "_");
    const outputPath = path.join(this.config.uploadsPath, ext ? `${safeName}.${ext}` : safeName);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, bytes);
    const ts = nowIso();

    this.db.exec(`
      INSERT INTO work_item_attachments(
        work_item_id, filename, mime_type, file_path, sha256, width, height, created_at
      ) VALUES (
        ${sqlValue(input.workItemId)}, ${sqlValue(input.filename)}, ${sqlValue(input.mimeType)}, ${sqlValue(outputPath)},
        ${sqlValue(hash)}, ${sqlValue(input.width ?? null)}, ${sqlValue(input.height ?? null)}, ${sqlValue(ts)}
      );
    `);

    const row = this.db.first<WorkItemAttachment>("SELECT * FROM work_item_attachments ORDER BY id DESC");
    if (!row) {
      throw new Error("Failed to persist attachment.");
    }
    this.addEvent("attachment_added", "work_item", input.workItemId, {
      id: row.id,
      file_path: row.file_path,
      mime_type: row.mime_type,
    });
    return row;
  }

  createRun(input: { workItemId: number; stage: Stage; profileId: number | null; logPath: string; artifactDir: string }): RunResult {
    const ts = nowIso();
    this.db.exec(`
      INSERT INTO runs(work_item_id, stage, profile_id, status, started_at, log_path, artifact_dir)
      VALUES (
        ${sqlValue(input.workItemId)}, ${sqlValue(input.stage)}, ${sqlValue(input.profileId)}, 'running',
        ${sqlValue(ts)}, ${sqlValue(input.logPath)}, ${sqlValue(input.artifactDir)}
      );
    `);
    const run = this.db.first<RunResult>("SELECT * FROM runs ORDER BY id DESC");
    if (!run) {
      throw new Error("Failed to create run");
    }
    return run;
  }

  completeRun(id: number, patch: { status: RunResult["status"]; exitCode?: number; errorText?: string | null }): RunResult {
    this.db.exec(`
      UPDATE runs
      SET
        status=${sqlValue(patch.status)},
        exit_code=${sqlValue(patch.exitCode ?? null)},
        error_text=${sqlValue(patch.errorText ?? null)},
        ended_at=${sqlValue(nowIso())}
      WHERE id=${sqlValue(id)};
    `);
    const run = this.db.first<RunResult>(`SELECT * FROM runs WHERE id=${sqlValue(id)}`);
    if (!run) {
      throw new Error(`Run ${id} not found.`);
    }
    this.addEvent("run_completed", "run", id, run);
    return run;
  }

  listRuns(limit = 200): RunResult[] {
    return this.db.query<RunResult>(`SELECT * FROM runs ORDER BY id DESC LIMIT ${sqlValue(limit)};`);
  }

  getRun(id: number): RunResult | null {
    return this.db.first<RunResult>(`SELECT * FROM runs WHERE id=${sqlValue(id)};`);
  }

  addFinding(input: {
    workItemId: number;
    runId: number;
    severity: string;
    title: string;
    detailsMd: string;
    blocking: boolean;
    childWorkItemId?: number | null;
  }): Finding {
    const ts = nowIso();
    this.db.exec(`
      INSERT INTO findings(
        work_item_id, run_id, severity, title, details_md,
        blocking, status, child_work_item_id, created_at
      ) VALUES (
        ${sqlValue(input.workItemId)}, ${sqlValue(input.runId)}, ${sqlValue(input.severity)}, ${sqlValue(input.title)}, ${sqlValue(input.detailsMd)},
        ${sqlValue(input.blocking ? 1 : 0)}, 'open', ${sqlValue(input.childWorkItemId ?? null)}, ${sqlValue(ts)}
      );
    `);
    const row = this.db.first<Finding>("SELECT * FROM findings ORDER BY id DESC");
    if (!row) {
      throw new Error("Failed to persist finding");
    }
    this.addEvent("finding_created", "finding", row.id, row);
    return row;
  }

  linkWorkItems(fromId: number, toId: number, relationType: "blocks" | "caused_by" | "spawned_from"): void {
    this.db.exec(`
      INSERT INTO work_item_links(from_id, to_id, relation_type)
      VALUES (${sqlValue(fromId)}, ${sqlValue(toId)}, ${sqlValue(relationType)});
    `);
  }

  resolveFindingsForWorkItem(workItemId: number): void {
    this.db.exec(`
      UPDATE findings
      SET status='resolved', resolved_at=${sqlValue(nowIso())}
      WHERE work_item_id=${sqlValue(workItemId)} AND status='open';
    `);
  }

  resolveFindingsByChildWorkItem(childWorkItemId: number): void {
    this.db.exec(`
      UPDATE findings
      SET status='resolved', resolved_at=${sqlValue(nowIso())}
      WHERE child_work_item_id=${sqlValue(childWorkItemId)} AND status='open';
    `);
  }

  hasOpenBlockingFindings(workItemId: number): boolean {
    const row = this.db.first<{ n: number }>(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM work_items WHERE id=${sqlValue(workItemId)}
        UNION ALL
        SELECT wi.id
        FROM work_items wi
        JOIN descendants d ON wi.parent_id = d.id
      )
      SELECT COUNT(*) AS n
      FROM findings f
      JOIN descendants d ON d.id = f.work_item_id
      WHERE f.blocking=1 AND f.status='open';
    `);
    return (row?.n || 0) > 0;
  }

  getChildWorkItems(parentId: number): WorkItem[] {
    return this.db.query<WorkItem>(`
      SELECT *
      FROM work_items
      WHERE parent_id=${sqlValue(parentId)}
      ORDER BY id ASC;
    `);
  }

  claimNextWorkItem(): WorkItem | null {
    const row = this.db.first<WorkItem>(`
      SELECT *
      FROM work_items
      WHERE status IN ('new', 'triaged', 'planned')
      ORDER BY priority ASC, created_at ASC
    `);
    if (!row) {
      return null;
    }

    this.db.exec(`
      UPDATE work_items
      SET status='triaged', updated_at=${sqlValue(nowIso())}
      WHERE id=${sqlValue(row.id)};
    `);

    return this.getWorkItem(row.id);
  }

  listProfiles(): {
    executionProfiles: ExecutionProfile[];
    mcpProfiles: McpProfile[];
    skillProfiles: SkillProfile[];
  } {
    return {
      executionProfiles: this.db.query<ExecutionProfile>("SELECT * FROM execution_profiles ORDER BY complexity, stage, id"),
      mcpProfiles: this.db.query<McpProfile>("SELECT * FROM mcp_profiles ORDER BY id"),
      skillProfiles: this.db.query<SkillProfile>("SELECT * FROM skill_profiles ORDER BY id"),
    };
  }

  upsertProfiles(payload: ProfilePayload): {
    executionProfiles: ExecutionProfile[];
    mcpProfiles: McpProfile[];
    skillProfiles: SkillProfile[];
  } {
    const ts = nowIso();

    for (const profile of payload.mcpProfiles || []) {
      this.db.exec(`
        INSERT INTO mcp_profiles(name, config_json, created_at, updated_at)
        VALUES (${sqlValue(profile.name)}, ${sqlValue(profile.config_json)}, ${sqlValue(ts)}, ${sqlValue(ts)})
        ON CONFLICT(name)
        DO UPDATE SET config_json=excluded.config_json, updated_at=excluded.updated_at;
      `);
    }

    for (const profile of payload.skillProfiles || []) {
      this.db.exec(`
        INSERT INTO skill_profiles(name, skills_json, created_at, updated_at)
        VALUES (${sqlValue(profile.name)}, ${sqlValue(profile.skills_json)}, ${sqlValue(ts)}, ${sqlValue(ts)})
        ON CONFLICT(name)
        DO UPDATE SET skills_json=excluded.skills_json, updated_at=excluded.updated_at;
      `);
    }

    for (const profile of payload.executionProfiles || []) {
      this.db.exec(`
        INSERT INTO execution_profiles(
          name, complexity, stage, runtime, agent, model, auth_mode,
          mcp_profile_id, skill_profile_id, timeout_s, retries, enabled,
          created_at, updated_at
        ) VALUES (
          ${sqlValue(profile.name)}, ${sqlValue(profile.complexity)}, ${sqlValue(profile.stage)}, ${sqlValue(profile.runtime)},
          ${sqlValue(profile.agent)}, ${sqlValue(profile.model)}, ${sqlValue(profile.auth_mode)},
          ${sqlValue(profile.mcp_profile_id)}, ${sqlValue(profile.skill_profile_id)}, ${sqlValue(profile.timeout_s)},
          ${sqlValue(profile.retries)}, ${sqlValue(profile.enabled ?? 1)}, ${sqlValue(ts)}, ${sqlValue(ts)}
        )
        ON CONFLICT(complexity, stage)
        DO UPDATE SET
          name=excluded.name,
          runtime=excluded.runtime,
          agent=excluded.agent,
          model=excluded.model,
          auth_mode=excluded.auth_mode,
          mcp_profile_id=excluded.mcp_profile_id,
          skill_profile_id=excluded.skill_profile_id,
          timeout_s=excluded.timeout_s,
          retries=excluded.retries,
          enabled=excluded.enabled,
          updated_at=excluded.updated_at;
      `);
    }

    return this.listProfiles();
  }

  getExecutionProfile(complexity: Complexity, stage: Stage): ExecutionProfile | null {
    return this.db.first<ExecutionProfile>(`
      SELECT *
      FROM execution_profiles
      WHERE complexity=${sqlValue(complexity)}
        AND stage=${sqlValue(stage)}
        AND enabled=1
      ORDER BY id DESC
    `);
  }

  upsertAgentInstallation(input: {
    agent: string;
    location: string;
    version: string;
    runtime: "host" | "docker";
    status: "ready" | "degraded" | "missing";
    capabilitiesJson: string;
  }): AgentInstallation {
    const ts = nowIso();
    this.db.exec(`
      INSERT INTO agent_installations(agent, location, version, runtime, status, capabilities_json, last_checked_at)
      VALUES (
        ${sqlValue(input.agent)}, ${sqlValue(input.location)}, ${sqlValue(input.version)}, ${sqlValue(input.runtime)},
        ${sqlValue(input.status)}, ${sqlValue(input.capabilitiesJson)}, ${sqlValue(ts)}
      )
      ON CONFLICT(agent, runtime)
      DO UPDATE SET
        location=excluded.location,
        version=excluded.version,
        status=excluded.status,
        capabilities_json=excluded.capabilities_json,
        last_checked_at=excluded.last_checked_at;
    `);

    const row = this.db.first<AgentInstallation>(`
      SELECT *
      FROM agent_installations
      WHERE agent=${sqlValue(input.agent)} AND runtime=${sqlValue(input.runtime)}
      ORDER BY id DESC
    `);
    if (!row) {
      throw new Error("Failed to persist agent installation row");
    }
    return row;
  }

  listAgentInstallations(): AgentInstallation[] {
    return this.db.query<AgentInstallation>("SELECT * FROM agent_installations ORDER BY agent, runtime");
  }

  createAuthSession(input: {
    provider: AuthProvider;
    runtimeTarget: "host" | "docker";
    stateToken: string;
    verifier: string;
    codeChallenge: string;
    expiresAt: string;
  }): AuthSession {
    const ts = nowIso();
    this.db.exec(`
      INSERT INTO auth_sessions(
        provider, runtime_target, state_token, verifier, code_challenge,
        status, created_at, expires_at
      ) VALUES (
        ${sqlValue(input.provider)}, ${sqlValue(input.runtimeTarget)}, ${sqlValue(input.stateToken)},
        ${sqlValue(input.verifier)}, ${sqlValue(input.codeChallenge)}, 'pending', ${sqlValue(ts)}, ${sqlValue(input.expiresAt)}
      );
    `);
    const row = this.db.first<AuthSession>("SELECT * FROM auth_sessions ORDER BY id DESC");
    if (!row) {
      throw new Error("Failed to create auth session");
    }
    return row;
  }

  getAuthSessionByState(stateToken: string): AuthSession | null {
    return this.db.first<AuthSession>(`SELECT * FROM auth_sessions WHERE state_token=${sqlValue(stateToken)}`);
  }

  updateAuthSessionStatus(id: number, status: AuthSession["status"]): void {
    this.db.exec(`UPDATE auth_sessions SET status=${sqlValue(status)} WHERE id=${sqlValue(id)};`);
  }

  upsertAuthToken(input: {
    provider: AuthProvider;
    tokenEncrypted: string;
    refreshEncrypted: string;
    expiresAt?: string | null;
  }): AuthTokenRecord {
    const ts = nowIso();
    this.db.exec(`
      INSERT INTO auth_tokens(provider, token_encrypted, refresh_encrypted, expires_at, created_at, updated_at)
      VALUES (
        ${sqlValue(input.provider)}, ${sqlValue(input.tokenEncrypted)}, ${sqlValue(input.refreshEncrypted)},
        ${sqlValue(input.expiresAt ?? null)}, ${sqlValue(ts)}, ${sqlValue(ts)}
      )
      ON CONFLICT(provider)
      DO UPDATE SET
        token_encrypted=excluded.token_encrypted,
        refresh_encrypted=excluded.refresh_encrypted,
        expires_at=excluded.expires_at,
        updated_at=excluded.updated_at;
    `);

    const row = this.db.first<AuthTokenRecord>(`SELECT * FROM auth_tokens WHERE provider=${sqlValue(input.provider)}`);
    if (!row) {
      throw new Error("Failed to persist auth token");
    }
    return row;
  }

  getAuthToken(provider: AuthProvider): AuthTokenRecord | null {
    return this.db.first<AuthTokenRecord>(`SELECT * FROM auth_tokens WHERE provider=${sqlValue(provider)}`);
  }

  deleteAuthToken(provider: AuthProvider): void {
    this.db.exec(`DELETE FROM auth_tokens WHERE provider=${sqlValue(provider)};`);
  }

  addEvent(type: string, objectType: string, objectId: number, payload: unknown): void {
    this.db.exec(`
      INSERT INTO harness_events(type, object_type, object_id, payload_json, created_at)
      VALUES (
        ${sqlValue(type)}, ${sqlValue(objectType)}, ${sqlValue(objectId)}, ${sqlValue(JSON.stringify(payload || {}))}, ${sqlValue(nowIso())}
      );
    `);
  }

  listEvents(limit = 200): Array<{ id: number; type: string; object_type: string; object_id: number; payload_json: string; created_at: string }> {
    return this.db.query(`SELECT * FROM harness_events ORDER BY id DESC LIMIT ${sqlValue(limit)};`);
  }
}
