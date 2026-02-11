export type WorkItemKind = "bug" | "finding" | "story" | "task";

export type WorkItemStatus =
  | "new"
  | "triaged"
  | "planned"
  | "executing"
  | "verifying"
  | "completed"
  | "blocked"
  | "failed"
  | "needs_input";

export type Complexity = "simple" | "medium" | "complex";

export type Stage = "plan" | "execute" | "test";

export type RuntimeTarget = "host" | "docker";

export type AuthProvider = "gemini" | "codex" | "claude";

export type AuthMode = "api_key" | "oauth_callback" | "device_code" | "adc";

export interface WorkItem {
  id: number;
  kind: WorkItemKind;
  title: string;
  body_md: string;
  body_html: string;
  status: WorkItemStatus;
  priority: number;
  severity: string | null;
  project_path: string;
  parent_id: number | null;
  acceptance_json: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface WorkItemInput {
  kind: WorkItemKind;
  title: string;
  bodyMd?: string;
  bodyHtml?: string;
  status?: WorkItemStatus;
  priority?: number;
  severity?: string | null;
  projectPath?: string;
  parentId?: number | null;
  acceptanceCriteria?: string[];
}

export interface WorkItemPatch {
  title?: string;
  bodyMd?: string;
  bodyHtml?: string;
  status?: WorkItemStatus;
  priority?: number;
  severity?: string | null;
  acceptanceCriteria?: string[];
}

export interface WorkItemAttachment {
  id: number;
  work_item_id: number;
  filename: string;
  mime_type: string;
  file_path: string;
  sha256: string;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface WorkItemLink {
  id: number;
  from_id: number;
  to_id: number;
  relation_type: "blocks" | "caused_by" | "spawned_from";
}

export interface Finding {
  id: number;
  work_item_id: number;
  run_id: number;
  severity: string;
  title: string;
  details_md: string;
  blocking: number;
  status: "open" | "resolved";
  child_work_item_id: number | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ExecutionProfile {
  id: number;
  name: string;
  complexity: Complexity;
  stage: Stage;
  runtime: RuntimeTarget;
  agent: string;
  model: string;
  auth_mode: AuthMode;
  mcp_profile_id: number | null;
  skill_profile_id: number | null;
  timeout_s: number;
  retries: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface McpProfile {
  id: number;
  name: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface SkillProfile {
  id: number;
  name: string;
  skills_json: string;
  created_at: string;
  updated_at: string;
}

export interface RunResult {
  id: number;
  work_item_id: number;
  stage: Stage;
  profile_id: number | null;
  status: "running" | "passed" | "failed" | "needs_input";
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  log_path: string;
  artifact_dir: string;
  error_text: string | null;
}

export interface AgentCapabilities {
  auth_modes: AuthMode[];
  supports_headless: boolean;
  requires_browser_callback_for_oauth: boolean;
  token_mount_supported: boolean;
  runtime_support: RuntimeTarget[];
}

export interface AgentInstallation {
  id: number;
  agent: string;
  location: string;
  version: string;
  runtime: RuntimeTarget;
  status: "ready" | "degraded" | "missing";
  capabilities_json: string;
  last_checked_at: string;
}

export interface HarnessEvent {
  id: number;
  type: string;
  object_type: string;
  object_id: number;
  payload_json: string;
  created_at: string;
}

export interface AuthSession {
  id: number;
  provider: AuthProvider;
  runtime_target: RuntimeTarget;
  state_token: string;
  verifier: string;
  code_challenge: string;
  status: "pending" | "completed" | "failed";
  created_at: string;
  expires_at: string;
}

export interface AuthTokenRecord {
  id: number;
  provider: AuthProvider;
  token_encrypted: string;
  refresh_encrypted: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HarnessConfig {
  enabled: boolean;
  dbPath: string;
  uploadsPath: string;
  artifactsPath: string;
  logsPath: string;
  authPath: string;
  dispatcherPollMs: number;
  maxParallelRuns: number;
  defaultRuntime: RuntimeTarget;
  promptInjectionMode: "block" | "warn" | "off";
  oauthCallbackHost: string;
  oauthCallbackPort: number;
  oauthEncryptionKey: string;
}

export interface RuntimeAuthMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface AuthSessionStartResult {
  sessionId: number;
  provider: AuthProvider;
  authorizeUrl: string;
  state: string;
  expiresAt: string;
}

export interface OAuthCallbackResult {
  ok: boolean;
  provider: AuthProvider;
  message: string;
}

export interface DiscoveryResult {
  agent: string;
  status: "ready" | "degraded" | "missing";
  runtime: RuntimeTarget;
  location: string;
  version: string;
  capabilities: AgentCapabilities;
  notes: string[];
}

export interface StageExecutionContext {
  workItem: WorkItem;
  stage: Stage;
  profile: ExecutionProfile;
  runId: number;
  prompt: string;
  authEnv?: Record<string, string>;
  authMounts?: RuntimeAuthMount[];
}
