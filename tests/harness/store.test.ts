import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HarnessStore } from "../../src/harness/db/store";
import { OAuthBroker } from "../../src/harness/auth/broker";
import { syncQueueItem } from "../../src/harness/queue/projection";
import { HarnessConfig, WorkItem } from "../../src/harness/types";

function makeConfig(root: string): HarnessConfig {
  const home = path.join(root, ".agent", "harness");
  fs.mkdirSync(home, { recursive: true });
  return {
    enabled: true,
    dbPath: path.join(home, "harness.db"),
    uploadsPath: path.join(home, "uploads"),
    artifactsPath: path.join(home, "artifacts"),
    logsPath: path.join(home, "logs"),
    authPath: path.join(home, "auth"),
    dispatcherPollMs: 2000,
    maxParallelRuns: 1,
    defaultRuntime: "docker",
    promptInjectionMode: "block",
    oauthCallbackHost: "127.0.0.1",
    oauthCallbackPort: 4173,
    oauthEncryptionKey: "test-encryption-key",
  };
}

test("store resolves blocking findings linked to child work item", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ica-harness-store-"));
  const config = makeConfig(tmp);
  const store = new HarnessStore(process.cwd(), config);

  const parent = store.createWorkItem({
    kind: "story",
    title: "Parent",
    bodyMd: "parent",
    projectPath: tmp,
  });

  const child = store.createWorkItem({
    kind: "finding",
    title: "Child",
    bodyMd: "child",
    parentId: parent.id,
    projectPath: tmp,
  });

  const run = store.createRun({
    workItemId: parent.id,
    stage: "test",
    profileId: null,
    logPath: path.join(tmp, "run.log"),
    artifactDir: path.join(tmp, "artifacts"),
  });

  store.addFinding({
    workItemId: parent.id,
    runId: run.id,
    severity: "high",
    title: "Blocking",
    detailsMd: "needs fix",
    blocking: true,
    childWorkItemId: child.id,
  });

  assert.equal(store.hasOpenBlockingFindings(parent.id), true);
  store.resolveFindingsByChildWorkItem(child.id);
  assert.equal(store.hasOpenBlockingFindings(parent.id), false);
});

test("oauth broker can complete gemini callback and mint runtime grant", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ica-harness-auth-"));
  const config = makeConfig(tmp);
  const store = new HarnessStore(process.cwd(), config);
  const tokenServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "gemini-access-token", refresh_token: "gemini-refresh-token", expires_in: 3600 }));
  });
  await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", () => resolve()));
  const address = tokenServer.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const oldClientId = process.env.ICA_GEMINI_OAUTH_CLIENT_ID;
  const oldClientSecret = process.env.ICA_GEMINI_OAUTH_CLIENT_SECRET;
  const oldTokenUrl = process.env.ICA_GEMINI_OAUTH_TOKEN_URL;
  process.env.ICA_GEMINI_OAUTH_CLIENT_ID = "test-client-id";
  process.env.ICA_GEMINI_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.ICA_GEMINI_OAUTH_TOKEN_URL = `http://127.0.0.1:${port}/token`;

  const broker = new OAuthBroker({
    store,
    callbackBaseUrl: "http://127.0.0.1:4173",
    encryptionSecret: config.oauthEncryptionKey,
  });

  const session = await broker.startSession("gemini", "docker");
  assert.ok(session.authorizeUrl.includes("state="));

  const callback = await broker.handleCallback("gemini", {
    code: "sample-code",
    state: session.state,
  });

  assert.equal(callback.ok, true);
  assert.equal(broker.hasStoredToken("gemini"), true);

  const grant = broker.mintRuntimeGrant(1, "gemini");
  assert.ok(grant.grantToken.length > 0);
  const consumed = broker.consumeRuntimeGrant(grant.grantToken);
  assert.equal(consumed.provider, "gemini");
  assert.ok(consumed.accessToken.length > 0);

  await new Promise<void>((resolve, reject) => {
    tokenServer.close((err) => (err ? reject(err) : resolve()));
  });
  if (oldClientId !== undefined) process.env.ICA_GEMINI_OAUTH_CLIENT_ID = oldClientId;
  else delete process.env.ICA_GEMINI_OAUTH_CLIENT_ID;
  if (oldClientSecret !== undefined) process.env.ICA_GEMINI_OAUTH_CLIENT_SECRET = oldClientSecret;
  else delete process.env.ICA_GEMINI_OAUTH_CLIENT_SECRET;
  if (oldTokenUrl !== undefined) process.env.ICA_GEMINI_OAUTH_TOKEN_URL = oldTokenUrl;
  else delete process.env.ICA_GEMINI_OAUTH_TOKEN_URL;
});

test("queue projection creates status file from work item", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ica-harness-queue-"));
  const workItem: WorkItem = {
    id: 7,
    kind: "task",
    title: "Implement queue projection",
    body_md: "details",
    body_html: "",
    status: "executing",
    priority: 2,
    severity: null,
    project_path: tmp,
    parent_id: null,
    acceptance_json: "[]",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closed_at: null,
  };

  const filePath = syncQueueItem(workItem);
  assert.equal(fs.existsSync(filePath), true);
  const content = fs.readFileSync(filePath, "utf8");
  assert.ok(content.includes("Implement queue projection"));
});
