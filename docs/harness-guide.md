# Harness Guide

The Harness extends the local dashboard into a control loop orchestration plane.

## Overview

Flow:

1. Intake work item (`bug`, `finding`, `story`, `task`)
2. Dispatcher claims and plans
3. Executor stage runs
4. Tester/verifier stage runs
5. Blocking findings create child work items
6. Loop repeats until no open blocking findings

State persists in `.agent/harness/` by default.

## Storage

Default paths:

- `.agent/harness/harness.db`
- `.agent/harness/uploads`
- `.agent/harness/artifacts`
- `.agent/harness/logs`
- `.agent/harness/auth`

## API Endpoints

Base path: `/api/v1/harness`

- `GET /health`
- `GET /work-items`
- `POST /work-items`
- `GET /work-items/:id`
- `PATCH /work-items/:id`
- `POST /work-items/:id/attachments`
- `POST /work-items/:id/dispatch`
- `GET /runs`
- `GET /runs/:id/log`
- `GET /runs/:id/artifacts`
- `GET /profiles`
- `PUT /profiles`
- `POST /discovery/scan`
- `GET /discovery/agents`
- `POST /auth/sessions`
- `GET /auth/callback/:provider`
- `POST /auth/grants`
- `GET /auth/providers`
- `PUT /auth/providers/:provider/api-key`
- `DELETE /auth/providers/:provider/credential`
- `POST /auth/providers/:provider/native/check`
- `POST /auth/providers/:provider/native/start`
- `GET /auth/native/sessions/:id`
- `POST /auth/native/sessions/:id/stop`
- `POST /loop/start`
- `POST /loop/stop`
- `GET /loop/status`
- `GET /events`

## Environment Variables

- `ICA_HARNESS_ENABLED=true|false`
- `ICA_HARNESS_HOME=/abs/path`
- `ICA_HARNESS_DB_PATH=/abs/path/harness.db`
- `ICA_HARNESS_UPLOADS_PATH=/abs/path/uploads`
- `ICA_HARNESS_ARTIFACTS_PATH=/abs/path/artifacts`
- `ICA_HARNESS_LOGS_PATH=/abs/path/logs`
- `ICA_HARNESS_AUTH_PATH=/abs/path/auth`
- `ICA_HARNESS_DEFAULT_RUNTIME=host|docker`
- `ICA_HARNESS_PROMPT_INJECTION_MODE=block|warn|off` (default: `block`)
- `ICA_HARNESS_DISPATCHER_POLL_MS=2000`
- `ICA_HARNESS_MAX_PARALLEL_RUNS=1`
- `ICA_HARNESS_OAUTH_CALLBACK_HOST=127.0.0.1`
- `ICA_HARNESS_OAUTH_CALLBACK_PORT=4173`
- `ICA_HARNESS_OAUTH_ENCRYPTION_KEY=<secret>`

Gemini OAuth plugin (optional explicit endpoints):

- `ICA_GEMINI_OAUTH_AUTH_URL`
- `ICA_GEMINI_OAUTH_TOKEN_URL`
- `ICA_GEMINI_OAUTH_CLIENT_ID`
- `ICA_GEMINI_OAUTH_CLIENT_SECRET`
- `ICA_GEMINI_OAUTH_SCOPE`

## Notes

- Callback OAuth is brokered through dashboard host callbacks.
- Native CLI auth (subscription/device flow) is supported through provider commands:
  - `codex login --device-auth`
  - `claude setup-token`
  - `gemini` (native account login flow) or callback OAuth broker
- For `auth_mode=device_code`, Docker execution mounts provider auth homes when available
  (for example `~/.codex`, `~/.gemini`). Providers without portable auth mounts should run on `runtime=host`.
- Queue compatibility is DB -> `.agent/queue` projection.
- Prompt-injection protection is enabled by default (`block`) at intake and execution stages.
- Existing installer APIs remain unchanged.
