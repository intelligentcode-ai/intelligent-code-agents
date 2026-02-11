CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 3,
  severity TEXT,
  project_path TEXT NOT NULL,
  parent_id INTEGER,
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  FOREIGN KEY(parent_id) REFERENCES work_items(id)
);

CREATE TABLE IF NOT EXISTS work_item_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY(work_item_id) REFERENCES work_items(id)
);

CREATE TABLE IF NOT EXISTS work_item_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  relation_type TEXT NOT NULL,
  FOREIGN KEY(from_id) REFERENCES work_items(id),
  FOREIGN KEY(to_id) REFERENCES work_items(id)
);

CREATE TABLE IF NOT EXISTS mcp_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  skills_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  complexity TEXT NOT NULL,
  stage TEXT NOT NULL,
  runtime TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  auth_mode TEXT NOT NULL DEFAULT 'api_key',
  mcp_profile_id INTEGER,
  skill_profile_id INTEGER,
  timeout_s INTEGER NOT NULL DEFAULT 900,
  retries INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(complexity, stage),
  FOREIGN KEY(mcp_profile_id) REFERENCES mcp_profiles(id),
  FOREIGN KEY(skill_profile_id) REFERENCES skill_profiles(id)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  profile_id INTEGER,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  log_path TEXT NOT NULL,
  artifact_dir TEXT NOT NULL,
  error_text TEXT,
  FOREIGN KEY(work_item_id) REFERENCES work_items(id),
  FOREIGN KEY(profile_id) REFERENCES execution_profiles(id)
);

CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  details_md TEXT NOT NULL,
  blocking INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  child_work_item_id INTEGER,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY(work_item_id) REFERENCES work_items(id),
  FOREIGN KEY(run_id) REFERENCES runs(id),
  FOREIGN KEY(child_work_item_id) REFERENCES work_items(id)
);

CREATE TABLE IF NOT EXISTS agent_installations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  location TEXT NOT NULL,
  version TEXT NOT NULL,
  runtime TEXT NOT NULL,
  status TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  UNIQUE(agent, runtime)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  runtime_target TEXT NOT NULL,
  state_token TEXT NOT NULL UNIQUE,
  verifier TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL UNIQUE,
  token_encrypted TEXT NOT NULL,
  refresh_encrypted TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS harness_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
CREATE INDEX IF NOT EXISTS idx_work_items_parent ON work_items(parent_id);
CREATE INDEX IF NOT EXISTS idx_runs_work_item ON runs(work_item_id);
CREATE INDEX IF NOT EXISTS idx_findings_work_item ON findings(work_item_id);
