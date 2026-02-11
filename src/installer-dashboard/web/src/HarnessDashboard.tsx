import React, { useEffect, useMemo, useRef, useState } from "react";

type WorkItem = {
  id: number;
  kind: "bug" | "finding" | "story" | "task";
  title: string;
  body_md: string;
  body_html: string;
  status:
    | "new"
    | "triaged"
    | "planned"
    | "executing"
    | "verifying"
    | "completed"
    | "blocked"
    | "failed"
    | "needs_input";
  priority: number;
  severity: string | null;
  project_path: string;
  parent_id: number | null;
  acceptance_json: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

type Run = {
  id: number;
  work_item_id: number;
  stage: "plan" | "execute" | "test";
  profile_id: number | null;
  status: "running" | "passed" | "failed" | "needs_input";
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  log_path: string;
  artifact_dir: string;
  error_text: string | null;
};

type Finding = {
  id: number;
  work_item_id: number;
  run_id: number;
  severity: string;
  title: string;
  details_md: string;
  blocking: number;
  status: "open" | "resolved";
  child_work_item_id: number | null;
};

type Attachment = {
  id: number;
  file_path: string;
  filename: string;
  mime_type: string;
};

type DiscoveryAgent = {
  id?: number;
  agent: string;
  status: "ready" | "degraded" | "missing";
  runtime: "host" | "docker";
  location: string;
  version: string;
  capabilities: {
    auth_modes: string[];
    supports_headless: boolean;
    requires_browser_callback_for_oauth: boolean;
    token_mount_supported: boolean;
    runtime_support: Array<"host" | "docker">;
  };
};

type AuthProvider = "gemini" | "codex" | "claude";

type AuthProviderStatus = {
  provider: AuthProvider;
  authModes: string[];
  supportsApiKey: boolean;
  supportsCallbackOAuth: boolean;
  supportsNativeCli: boolean;
  requiresBrowserCallbackForOAuth: boolean;
  hasCredential: boolean;
  oauthConfigured: boolean;
  oauthIssues: string[];
  nativeStatus: "authenticated" | "missing" | "unknown";
  nativeStatusMessage: string;
  nativeStartCommand: string;
  nativeDocsUrl: string | null;
  nativeDockerMountSupported: boolean;
};

type PendingImage = {
  filename: string;
  mimeType: string;
  file: File;
  placeholder: string;
};

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const maybe = (payload as { error?: unknown }).error;
    if (typeof maybe === "string") {
      return maybe;
    }
  }
  return fallback;
}

function titleCase(provider: AuthProvider): string {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
  return "Gemini";
}

export function HarnessDashboard(): JSX.Element {
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<number | null>(null);
  const [details, setDetails] = useState<{
    workItem: WorkItem;
    runs: Run[];
    findings: Finding[];
    attachments: Attachment[];
    acceptanceCriteria: string[];
  } | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runLog, setRunLog] = useState<string>("");
  const [runLogId, setRunLogId] = useState<number | null>(null);
  const [agents, setAgents] = useState<DiscoveryAgent[]>([]);
  const [authProviders, setAuthProviders] = useState<AuthProviderStatus[]>([]);
  const [apiKeyDrafts, setApiKeyDrafts] = useState<Record<AuthProvider, string>>({
    gemini: "",
    codex: "",
    claude: "",
  });
  const [profilesJson, setProfilesJson] = useState<string>("{}");
  const [loopState, setLoopState] = useState<{ running: boolean; inFlight?: boolean }>({ running: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [oauthUrl, setOauthUrl] = useState("");
  const [nativeChecks, setNativeChecks] = useState<Record<AuthProvider, { status: string; message: string } | null>>({
    gemini: null,
    codex: null,
    claude: null,
  });
  const [nativeSessions, setNativeSessions] = useState<
    Record<AuthProvider, { id: number | null; status: string; output: string; command: string }>
  >({
    gemini: { id: null, status: "idle", output: "", command: "" },
    codex: { id: null, status: "idle", output: "", command: "" },
    claude: { id: null, status: "idle", output: "", command: "" },
  });

  const [kind, setKind] = useState<"bug" | "finding" | "story" | "task">("story");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState(3);
  const [severity, setSeverity] = useState("medium");
  const [editorMode, setEditorMode] = useState<"markdown" | "wysiwyg">("markdown");
  const [bodyMd, setBodyMd] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("Tests pass\nNo blocking findings");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);

  const wysiwygRef = useRef<HTMLDivElement>(null);

  const readyAgents = useMemo(() => agents.filter((item) => item.status === "ready"), [agents]);

  async function refreshWorkItems(): Promise<void> {
    const res = await fetch("/api/v1/harness/work-items");
    const payload = (await res.json()) as { workItems?: WorkItem[]; error?: string };
    if (!res.ok) {
      throw new Error(errorMessage(payload, "Failed to load work items."));
    }
    setWorkItems(Array.isArray(payload.workItems) ? payload.workItems : []);
  }

  async function refreshRuns(): Promise<void> {
    const res = await fetch("/api/v1/harness/runs?limit=100");
    const payload = (await res.json()) as { runs?: Run[]; error?: string };
    if (!res.ok) {
      throw new Error(errorMessage(payload, "Failed to load runs."));
    }
    setRuns(Array.isArray(payload.runs) ? payload.runs : []);
  }

  async function refreshProfiles(): Promise<void> {
    const res = await fetch("/api/v1/harness/profiles");
    const payload = (await res.json()) as unknown;
    if (!res.ok) {
      throw new Error(errorMessage(payload, "Failed to load profiles."));
    }
    setProfilesJson(JSON.stringify(payload, null, 2));
  }

  async function refreshAgents(readyOnly = false): Promise<void> {
    const url = readyOnly ? "/api/v1/harness/discovery/agents?readyOnly=1" : "/api/v1/harness/discovery/agents";
    const res = await fetch(url);
    const payload = (await res.json()) as { agents?: DiscoveryAgent[]; error?: string };
    if (!res.ok) {
      throw new Error(errorMessage(payload, "Failed to load discovered agents."));
    }
    setAgents(Array.isArray(payload.agents) ? payload.agents : []);
  }

  async function refreshAuthProviders(): Promise<void> {
    const res = await fetch("/api/v1/harness/auth/providers");
    const payload = (await res.json()) as { providers?: AuthProviderStatus[]; error?: string };
    if (!res.ok) {
      throw new Error(errorMessage(payload, "Failed to load auth providers."));
    }
    setAuthProviders(Array.isArray(payload.providers) ? payload.providers : []);
  }

  async function refreshLoopStatus(): Promise<void> {
    const res = await fetch("/api/v1/harness/loop/status");
    const payload = (await res.json()) as { running?: boolean; inFlight?: boolean; error?: string };
    if (!res.ok) {
      throw new Error(errorMessage(payload, "Failed to read loop status."));
    }
    setLoopState({ running: Boolean(payload.running), inFlight: payload.inFlight });
  }

  async function refreshDetails(id: number): Promise<void> {
    const res = await fetch(`/api/v1/harness/work-items/${id}`);
    const payload = (await res.json()) as {
      workItem?: WorkItem;
      runs?: Run[];
      findings?: Finding[];
      attachments?: Attachment[];
      acceptanceCriteria?: string[];
      error?: string;
    };
    if (!res.ok || !payload.workItem) {
      throw new Error(errorMessage(payload, "Failed to load work item details."));
    }
    setDetails({
      workItem: payload.workItem,
      runs: payload.runs || [],
      findings: payload.findings || [],
      attachments: payload.attachments || [],
      acceptanceCriteria: payload.acceptanceCriteria || [],
    });
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([
      refreshWorkItems(),
      refreshRuns(),
      refreshProfiles(),
      refreshAgents(),
      refreshAuthProviders(),
      refreshLoopStatus(),
    ]);
  }

  async function scanAgents(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/v1/harness/discovery/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runtime: "all" }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(errorMessage(payload, "Discovery scan failed."));
      }
      await refreshAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveProfiles(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const payload = JSON.parse(profilesJson);
      const res = await fetch("/api/v1/harness/profiles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(errorMessage(body, "Failed to save profiles."));
      }
      setProfilesJson(JSON.stringify(body, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function createWorkItem(): Promise<void> {
    setBusy(true);
    setError("");

    try {
      const bodyToCreate = editorMode === "markdown" ? bodyMd : bodyHtml;
      const htmlToCreate = editorMode === "wysiwyg" ? bodyHtml : bodyMd;
      const res = await fetch("/api/v1/harness/work-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          title,
          bodyMd: bodyToCreate,
          bodyHtml: htmlToCreate,
          priority,
          severity,
          acceptanceCriteria: acceptanceCriteria
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        }),
      });
      const payload = (await res.json()) as { workItem?: WorkItem; error?: string };
      if (!res.ok || !payload.workItem) {
        throw new Error(errorMessage(payload, "Failed to create work item."));
      }

      let finalBody = bodyToCreate;
      for (const image of pendingImages) {
        const form = new FormData();
        form.append("file", image.file, image.filename);

        const attachRes = await fetch(`/api/v1/harness/work-items/${payload.workItem.id}/attachments`, {
          method: "POST",
          body: form,
        });
        const attachPayload = (await attachRes.json()) as { attachment?: Attachment; error?: string };
        if (!attachRes.ok || !attachPayload.attachment) {
          throw new Error(errorMessage(attachPayload, `Failed to upload image ${image.filename}.`));
        }

        const replacement = `![${image.filename}](${attachPayload.attachment.file_path})`;
        finalBody = finalBody.replace(image.placeholder, replacement);
      }

      if (pendingImages.length > 0) {
        await fetch(`/api/v1/harness/work-items/${payload.workItem.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bodyMd: finalBody, bodyHtml: finalBody }),
        });
      }

      setTitle("");
      setBodyMd("");
      setBodyHtml("");
      setPendingImages([]);
      setSelectedWorkItemId(payload.workItem.id);
      await refreshWorkItems();
      await refreshDetails(payload.workItem.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement | HTMLDivElement>): Promise<void> {
    const files: File[] = [];
    for (const item of Array.from(event.clipboardData.items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length === 0) {
      return;
    }

    event.preventDefault();

    const nextImages: PendingImage[] = [];
    for (const file of files) {
      const placeholder = `![${file.name}](pending://${Date.now()}-${Math.random().toString(16).slice(2)})`;
      nextImages.push({
        filename: file.name,
        mimeType: file.type || "image/png",
        file,
        placeholder,
      });
    }

    const placeholders = nextImages.map((image) => image.placeholder).join("\n");
    if (editorMode === "markdown") {
      setBodyMd((prev) => `${prev}${prev.endsWith("\n") || prev.length === 0 ? "" : "\n"}${placeholders}\n`);
    } else {
      const html = `${bodyHtml}<p>${placeholders.replace(/\n/g, "<br/>")}</p>`;
      setBodyHtml(html);
      if (wysiwygRef.current) {
        wysiwygRef.current.innerHTML = html;
      }
    }

    setPendingImages((prev) => [...prev, ...nextImages]);
  }

  async function selectWorkItem(id: number): Promise<void> {
    setSelectedWorkItemId(id);
    try {
      await refreshDetails(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadRunLog(id: number): Promise<void> {
    try {
      const res = await fetch(`/api/v1/harness/runs/${id}/log`);
      const payload = (await res.json()) as { log?: string; error?: string };
      if (!res.ok || typeof payload.log !== "string") {
        throw new Error(errorMessage(payload, "Failed to load run log."));
      }
      setRunLog(payload.log);
      setRunLogId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function dispatchNow(id: number): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/v1/harness/work-items/${id}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(errorMessage(payload, "Dispatch failed."));
      }
      await Promise.all([refreshWorkItems(), refreshRuns(), refreshLoopStatus(), refreshDetails(id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleLoop(shouldRun: boolean): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const url = shouldRun ? "/api/v1/harness/loop/start" : "/api/v1/harness/loop/stop";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(errorMessage(payload, `Failed to ${shouldRun ? "start" : "stop"} loop.`));
      }
      await refreshLoopStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startOauthSession(provider: AuthProvider): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/v1/harness/auth/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, runtimeTarget: "docker" }),
      });
      const payload = (await res.json()) as { session?: { authorizeUrl: string }; error?: string };
      if (!res.ok || !payload.session) {
        throw new Error(errorMessage(payload, `Failed to create ${provider} OAuth session.`));
      }
      setOauthUrl(payload.session.authorizeUrl);
      window.open(payload.session.authorizeUrl, "_blank", "noopener,noreferrer");
      await refreshAuthProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveApiKey(provider: AuthProvider): Promise<void> {
    const apiKey = apiKeyDrafts[provider].trim();
    if (!apiKey) {
      setError(`Enter an API key for ${titleCase(provider)}.`);
      return;
    }

    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/v1/harness/auth/providers/${provider}/api-key`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(errorMessage(payload, `Failed to store API key for ${provider}.`));
      }
      setApiKeyDrafts((prev) => ({ ...prev, [provider]: "" }));
      await refreshAuthProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function clearCredential(provider: AuthProvider): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/v1/harness/auth/providers/${provider}/credential`, {
        method: "DELETE",
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(errorMessage(payload, `Failed to clear credential for ${provider}.`));
      }
      await refreshAuthProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function checkNativeAuth(provider: AuthProvider): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/v1/harness/auth/providers/${provider}/native/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = (await res.json()) as {
        state?: { status?: "authenticated" | "missing" | "unknown"; message?: string };
        error?: string;
      };
      if (!res.ok || !payload.state) {
        throw new Error(errorMessage(payload, `Failed native auth check for ${provider}.`));
      }
      setNativeChecks((prev) => ({
        ...prev,
        [provider]: {
          status: payload.state?.status || "unknown",
          message: payload.state?.message || "",
        },
      }));
      await refreshAuthProviders();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      window.setTimeout(() => resolve(), ms);
    });
  }

  async function pollNativeSession(provider: AuthProvider, sessionId: number): Promise<void> {
    for (let attempt = 0; attempt < 180; attempt++) {
      await sleep(1000);
      const res = await fetch(`/api/v1/harness/auth/native/sessions/${sessionId}`);
      const payload = (await res.json()) as {
        session?: { status?: string; output?: string; command?: string };
        error?: string;
      };
      if (!res.ok || !payload.session) {
        break;
      }

      setNativeSessions((prev) => ({
        ...prev,
        [provider]: {
          id: sessionId,
          status: payload.session?.status || "unknown",
          output: payload.session?.output || "",
          command: payload.session?.command || "",
        },
      }));

      if (payload.session.status !== "running") {
        break;
      }
    }

    await refreshAuthProviders();
  }

  async function startNativeAuth(provider: AuthProvider): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/v1/harness/auth/providers/${provider}/native/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = (await res.json()) as {
        session?: { id?: number; status?: string; output?: string; command?: string };
        error?: string;
      };
      if (!res.ok || !payload.session || !payload.session.id) {
        throw new Error(errorMessage(payload, `Failed to start native auth for ${provider}.`));
      }

      setNativeSessions((prev) => ({
        ...prev,
        [provider]: {
          id: payload.session?.id || null,
          status: payload.session?.status || "running",
          output: payload.session?.output || "",
          command: payload.session?.command || "",
        },
      }));
      void pollNativeSession(provider, payload.session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refreshAll().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!selectedWorkItemId) {
      return;
    }
    refreshDetails(selectedWorkItemId).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [selectedWorkItemId]);

  useEffect(() => {
    if (editorMode === "wysiwyg" && wysiwygRef.current) {
      wysiwygRef.current.innerHTML = bodyHtml;
    }
  }, [editorMode, bodyHtml]);

  return (
    <div className="shell harness-shell">
      <header className="hero">
        <div className="hero-topline">
          <p className="eyebrow">ICA HARNESS CONTROL PLANE</p>
          <p className="stamp">Blue Theme</p>
        </div>
        <h1>Agent Harness Dashboard</h1>
        <p>Intake work items, route plan/execute/test across agents, recurse findings, and close only when blockers are gone.</p>
        <div className="hero-stats">
          <article className="stat-card">
            <span>Work Items</span>
            <strong>{workItems.length}</strong>
          </article>
          <article className="stat-card">
            <span>Runs</span>
            <strong>{runs.length}</strong>
          </article>
          <article className="stat-card">
            <span>Ready Agents</span>
            <strong>{readyAgents.length}</strong>
          </article>
        </div>
      </header>

      {error && (
        <section className="status status-error">
          <strong>Action needed:</strong> {error}
        </section>
      )}

      <section className="harness-topbar panel">
        <div>
          <h2>Control Loop</h2>
          <p className="subtle">
            Status: {loopState.running ? "Running" : "Stopped"}
            {loopState.inFlight ? " (processing)" : ""}
          </p>
        </div>
        <div className="harness-inline-actions">
          <button className="btn btn-primary" disabled={busy || loopState.running} onClick={() => toggleLoop(true)}>
            Start Loop
          </button>
          <button className="btn btn-secondary" disabled={busy || !loopState.running} onClick={() => toggleLoop(false)}>
            Stop Loop
          </button>
          <button className="btn btn-tertiary" disabled={busy} onClick={() => refreshAll().catch((err) => setError(String(err)))}>
            Refresh All
          </button>
        </div>
      </section>

      <div className="workspace harness-layout">
        <aside className="control-rail harness-sidebar">
          <section className="panel harness-panel">
            <div className="harness-section-head">
              <h2>Agent Discovery</h2>
              <div className="harness-inline-actions">
                <button className="btn btn-secondary" disabled={busy} onClick={() => scanAgents()}>
                  Scan
                </button>
                <button className="btn btn-tertiary" disabled={busy} onClick={() => refreshAgents(true)}>
                  Ready Only
                </button>
              </div>
            </div>
            <div className="harness-agent-list">
              {agents.length === 0 ? <p className="subtle">No discovery data yet. Run scan.</p> : null}
              {agents.map((agent) => (
                <article key={`${agent.agent}-${agent.runtime}`} className="harness-agent-card">
                  <p>
                    <strong>{agent.agent}</strong> <span className={`badge status-${agent.status}`}>{agent.status}</span>
                  </p>
                  <p className="subtle">
                    {agent.runtime} • {agent.version}
                  </p>
                  <p className="subtle">Auth: {agent.capabilities.auth_modes.join(", ") || "none"}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="panel harness-panel">
            <div className="harness-section-head">
              <h2>Authentication</h2>
              <p className="subtle">Configure provider credentials once, then assign auth mode in execution profiles.</p>
            </div>
            <div className="harness-auth-grid">
              {authProviders.map((provider) => (
                <article key={provider.provider} className="harness-auth-card">
                  <div className="harness-auth-head">
                    <h3>{titleCase(provider.provider)}</h3>
                    <span
                      className={`badge ${
                        (nativeChecks[provider.provider]?.status || provider.nativeStatus) === "authenticated"
                          ? "status-completed"
                          : "status-failed"
                      }`}
                    >
                      {nativeChecks[provider.provider]?.status || provider.nativeStatus}
                    </span>
                  </div>
                  <p className="subtle">Modes: {provider.authModes.join(", ") || "none"}</p>
                  <p className="subtle">
                    {(nativeChecks[provider.provider]?.message || provider.nativeStatusMessage || "No native auth status.") +
                      (provider.nativeDockerMountSupported ? " Docker mount ready." : " Docker mount limited.")}
                  </p>

                  {provider.supportsNativeCli ? (
                    <div className="harness-auth-row">
                      <div className="harness-inline-actions">
                        <button className="btn btn-primary" disabled={busy} onClick={() => startNativeAuth(provider.provider)}>
                          Start Native Auth
                        </button>
                        <button className="btn btn-secondary" disabled={busy} onClick={() => checkNativeAuth(provider.provider)}>
                          Check Native Auth
                        </button>
                      </div>
                      <p className="subtle">
                        Command: <code>{provider.nativeStartCommand}</code>
                      </p>
                      {provider.nativeDocsUrl ? (
                        <p className="subtle">
                          Docs:{" "}
                          <a href={provider.nativeDocsUrl} target="_blank" rel="noreferrer">
                            {provider.nativeDocsUrl}
                          </a>
                        </p>
                      ) : null}
                      {nativeSessions[provider.provider].id ? (
                        <pre>{nativeSessions[provider.provider].output || "Native auth session running..."}</pre>
                      ) : null}
                    </div>
                  ) : null}

                  {provider.supportsApiKey ? (
                    <div className="harness-auth-row">
                      <p className="subtle">Fallback only: API key credential</p>
                      <input
                        className="input"
                        type="password"
                        value={apiKeyDrafts[provider.provider]}
                        onChange={(event) =>
                          setApiKeyDrafts((prev) => ({
                            ...prev,
                            [provider.provider]: event.target.value,
                          }))
                        }
                        placeholder={`Enter ${titleCase(provider.provider)} API key`}
                      />
                      <div className="harness-inline-actions">
                        <button className="btn btn-primary" disabled={busy} onClick={() => saveApiKey(provider.provider)}>
                          Save Key
                        </button>
                        <button className="btn btn-secondary" disabled={busy} onClick={() => clearCredential(provider.provider)}>
                          Clear
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {provider.supportsCallbackOAuth ? (
                    <div className="harness-auth-row">
                      <button
                        className="btn btn-tertiary"
                        disabled={busy || !provider.oauthConfigured}
                        onClick={() => startOauthSession(provider.provider)}
                      >
                        Start Callback OAuth
                      </button>
                      {provider.oauthIssues.length > 0 ? (
                        <ul className="harness-warning-list">
                          {provider.oauthIssues.map((issue) => (
                            <li key={issue}>{issue}</li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
            {oauthUrl ? (
              <p className="subtle">
                OAuth URL: <a href={oauthUrl}>{oauthUrl}</a>
              </p>
            ) : null}
          </section>

          <section className="panel harness-panel">
            <details className="collapsible">
              <summary>Execution Profiles JSON</summary>
              <textarea
                className="input"
                value={profilesJson}
                onChange={(event) => setProfilesJson(event.target.value)}
                rows={16}
                spellCheck={false}
              />
            </details>
            <div className="harness-inline-actions">
              <button className="btn btn-primary" disabled={busy} onClick={() => saveProfiles()}>
                Save Profiles
              </button>
            </div>
          </section>
        </aside>

        <main className="catalog-column harness-main">
          <section className="panel harness-panel">
            <div className="harness-section-head">
              <h2>Create Work Item</h2>
              <div className="toggle-row">
                <button
                  className={editorMode === "markdown" ? "chip is-active" : "chip"}
                  onClick={() => setEditorMode("markdown")}
                >
                  Markdown
                </button>
                <button
                  className={editorMode === "wysiwyg" ? "chip is-active" : "chip"}
                  onClick={() => setEditorMode("wysiwyg")}
                >
                  WYSIWYG
                </button>
              </div>
            </div>

            <div className="harness-form-grid">
              <label>
                Kind
                <select className="input" value={kind} onChange={(event) => setKind(event.target.value as any)}>
                  <option value="story">story</option>
                  <option value="bug">bug</option>
                  <option value="finding">finding</option>
                  <option value="task">task</option>
                </select>
              </label>
              <label>
                Priority
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={5}
                  value={priority}
                  onChange={(event) => setPriority(Number(event.target.value) || 3)}
                />
              </label>
              <label>
                Severity
                <select className="input" value={severity} onChange={(event) => setSeverity(event.target.value)}>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="critical">critical</option>
                </select>
              </label>
            </div>

            <label>
              Title
              <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Enter work item title" />
            </label>

            {editorMode === "markdown" ? (
              <textarea
                className="input harness-editor"
                value={bodyMd}
                onChange={(event) => setBodyMd(event.target.value)}
                onPaste={(event) => {
                  void handlePaste(event);
                }}
                rows={10}
                placeholder="Markdown body. Paste images directly into this field."
              />
            ) : (
              <div
                ref={wysiwygRef}
                className="wysiwyg harness-editor"
                contentEditable
                suppressContentEditableWarning
                onInput={(event) => setBodyHtml((event.target as HTMLDivElement).innerHTML)}
                onPaste={(event) => {
                  void handlePaste(event);
                }}
              />
            )}

            <label>
              Acceptance Criteria (one per line)
              <textarea
                className="input"
                value={acceptanceCriteria}
                onChange={(event) => setAcceptanceCriteria(event.target.value)}
                rows={4}
                placeholder="Tests pass&#10;No blocking findings"
              />
            </label>

            {pendingImages.length > 0 && (
              <div className="status">
                <strong>Pending image uploads:</strong> {pendingImages.map((item) => item.filename).join(", ")}
              </div>
            )}

            <div className="harness-inline-actions">
              <button className="btn btn-primary" disabled={busy || !title.trim()} onClick={() => createWorkItem()}>
                Create Work Item
              </button>
            </div>
          </section>

          <section className="panel harness-panel">
            <div className="harness-section-head">
              <h2>Work Queue</h2>
            </div>
            <div className="work-items-grid">
              <article>
                <h3>Items</h3>
                <div className="list">
                  {workItems.map((item) => (
                    <button
                      key={item.id}
                      className={`list-item ${selectedWorkItemId === item.id ? "selected" : ""}`}
                      onClick={() => {
                        void selectWorkItem(item.id);
                      }}
                    >
                      <strong>
                        #{item.id} {item.title}
                      </strong>
                      <span>
                        {item.kind} • P{item.priority}
                      </span>
                      <span className={`badge status-${item.status}`}>{item.status}</span>
                    </button>
                  ))}
                </div>
              </article>

              <article>
                <h3>Selected Item</h3>
                {details ? (
                  <div className="details">
                    <p>
                      <strong>#{details.workItem.id}</strong> {details.workItem.title}
                    </p>
                    <p className="subtle">Status: {details.workItem.status}</p>
                    <p className="subtle">Kind: {details.workItem.kind}</p>
                    <div className="harness-inline-actions">
                      <button className="btn btn-primary" disabled={busy} onClick={() => dispatchNow(details.workItem.id)}>
                        Dispatch Now
                      </button>
                      <button
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() => {
                          void refreshDetails(details.workItem.id);
                        }}
                      >
                        Refresh
                      </button>
                    </div>

                    <h4>Acceptance Criteria</h4>
                    <ul>
                      {details.acceptanceCriteria.map((criterion, index) => (
                        <li key={`${criterion}-${index}`}>{criterion}</li>
                      ))}
                    </ul>

                    <h4>Findings</h4>
                    <ul>
                      {details.findings.length === 0 ? <li>No findings yet.</li> : null}
                      {details.findings.map((finding) => (
                        <li key={finding.id}>
                          [{finding.status}] {finding.title}
                          {finding.child_work_item_id ? ` -> child #${finding.child_work_item_id}` : ""}
                        </li>
                      ))}
                    </ul>

                    <h4>Attachments</h4>
                    <ul>
                      {details.attachments.length === 0 ? <li>No attachments.</li> : null}
                      {details.attachments.map((file) => (
                        <li key={file.id}>
                          <a href={file.file_path} target="_blank" rel="noreferrer">
                            {file.filename}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="subtle">Select a work item to inspect runs/findings.</p>
                )}
              </article>
            </div>
          </section>

          <section className="panel harness-panel">
            <div className="harness-section-head">
              <h2>Runs</h2>
            </div>
            <div className="runs-grid">
              <div className="list">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    className={`list-item ${runLogId === run.id ? "selected" : ""}`}
                    onClick={() => {
                      void loadRunLog(run.id);
                    }}
                  >
                    <strong>Run #{run.id}</strong>
                    <span>
                      Item #{run.work_item_id} • {run.stage} • {run.status}
                    </span>
                  </button>
                ))}
              </div>
              <pre>{runLog || "Select a run to view logs."}</pre>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
