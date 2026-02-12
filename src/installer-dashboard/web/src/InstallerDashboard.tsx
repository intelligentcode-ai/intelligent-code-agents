import React, { useEffect, useMemo, useState } from "react";

type Target = "claude" | "codex" | "cursor" | "gemini" | "antigravity";

type Source = {
  id: string;
  name: string;
  repoUrl: string;
  transport: "https" | "ssh";
  official: boolean;
  enabled: boolean;
  skillsRoot: string;
  credentialRef?: string;
  removable: boolean;
  lastSyncAt?: string;
  lastError?: string;
  revision?: string;
};

type Skill = {
  skillId: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  skillName: string;
  name: string;
  description: string;
  category: string;
  resources: Array<{ type: string; path: string }>;
  version?: string;
  updatedAt?: string;
};

type InstallationSkill = {
  name: string;
  skillId?: string;
  sourceId?: string;
  installMode: string;
  effectiveMode: string;
  orphaned?: boolean;
};

type InstallationRow = {
  target: Target;
  installPath: string;
  scope: "user" | "project";
  projectPath?: string;
  installed: boolean;
  managedSkills: InstallationSkill[];
  updatedAt?: string;
};

type OperationTargetReport = {
  target: string;
  installPath: string;
  operation: string;
  appliedSkills: string[];
  removedSkills: string[];
  skippedSkills: string[];
  warnings: Array<{ code: string; message: string }>;
  errors: Array<{ code: string; message: string }>;
};

type OperationReport = {
  startedAt: string;
  completedAt: string;
  request?: unknown;
  targets: OperationTargetReport[];
};

const allTargets: Target[] = ["claude", "codex", "cursor", "gemini", "antigravity"];

function asErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const candidate = (payload as { error?: unknown }).error;
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return fallback;
}

export function InstallerDashboard(): JSX.Element {
  const [sources, setSources] = useState<Source[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [targets, setTargets] = useState<Set<Target>>(new Set(["codex"]));
  const [searchQuery, setSearchQuery] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [projectPath, setProjectPath] = useState("");
  const [mode, setMode] = useState<"symlink" | "copy">("symlink");
  const [installations, setInstallations] = useState<InstallationRow[]>([]);
  const [report, setReport] = useState<OperationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectionCustomized, setSelectionCustomized] = useState(false);
  const [sourceRepoUrl, setSourceRepoUrl] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [sourceTransport, setSourceTransport] = useState<"https" | "ssh">("https");
  const [sourceToken, setSourceToken] = useState("");

  const selectedTargetList = useMemo(() => Array.from(targets).sort(), [targets]);
  const trimmedProjectPath = projectPath.trim();
  const targetKey = selectedTargetList.join(",");
  const skillById = useMemo(() => new Map(skills.map((skill) => [skill.skillId, skill])), [skills]);

  const categorized = useMemo(() => {
    const byCategory = new Map<string, Skill[]>();
    for (const skill of skills) {
      const current = byCategory.get(skill.category) || [];
      current.push(skill);
      byCategory.set(skill.category, current);
    }
    return Array.from(byCategory.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [skills]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredCategorized = useMemo(() => {
    if (!normalizedQuery) {
      return categorized;
    }
    return categorized
      .map(([category, categorySkills]) => {
        const filtered = categorySkills.filter((skill) => {
          const resourceText = skill.resources.map((item) => `${item.type} ${item.path}`).join(" ");
          const haystack = `${skill.skillId} ${skill.description} ${skill.category} ${resourceText}`.toLowerCase();
          return haystack.includes(normalizedQuery);
        });
        return [category, filtered] as [string, Skill[]];
      })
      .filter(([, categorySkills]) => categorySkills.length > 0);
  }, [categorized, normalizedQuery]);

  const installedSkillIds = useMemo(() => {
    const names = new Set<string>();
    for (const row of installations) {
      for (const skill of row.managedSkills || []) {
        if (skill.skillId) {
          names.add(skill.skillId);
        } else {
          const match = skills.find((item) => item.skillName === skill.name);
          if (match) names.add(match.skillId);
        }
      }
    }
    return names;
  }, [installations, skills]);

  async function fetchSources(): Promise<void> {
    const res = await fetch("/api/v1/sources");
    const payload = (await res.json()) as { sources?: Source[]; error?: string };
    if (!res.ok) {
      throw new Error(asErrorMessage(payload, "Failed to load sources."));
    }
    setSources(Array.isArray(payload.sources) ? payload.sources : []);
  }

  async function refreshSources(runRefresh = false): Promise<void> {
    if (runRefresh) {
      await fetch("/api/v1/sources/refresh-all", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
    }
    await fetchSources();
  }

  async function fetchSkills(runRefresh = false): Promise<void> {
    if (runRefresh) {
      await refreshSources(true);
    }
    const res = await fetch("/api/v1/catalog/skills");
    const payload = (await res.json()) as { skills?: Skill[]; error?: string };
    if (!res.ok) {
      throw new Error(asErrorMessage(payload, "Failed to load skills catalog."));
    }
    setSkills(Array.isArray(payload.skills) ? payload.skills : []);
  }

  async function fetchDiscoveredTargets(): Promise<void> {
    const res = await fetch("/api/v1/targets/discovered");
    const payload = (await res.json()) as { targets?: Target[]; error?: string };
    if (!res.ok) {
      throw new Error(asErrorMessage(payload, "Failed to discover targets."));
    }
    if (!Array.isArray(payload.targets) || payload.targets.length === 0) {
      return;
    }
    const validTargets = payload.targets.filter((target): target is Target => allTargets.includes(target));
    if (validTargets.length > 0) {
      setTargets(new Set(validTargets));
    }
  }

  async function fetchInstallations(): Promise<void> {
    if (scope === "project" && !trimmedProjectPath) {
      setInstallations([]);
      return;
    }

    const query = new URLSearchParams({
      scope,
      ...(scope === "project" ? { projectPath: trimmedProjectPath } : {}),
      targets: targetKey,
    });

    const res = await fetch(`/api/v1/installations?${query.toString()}`);
    const payload = (await res.json()) as { installations?: InstallationRow[]; error?: string };
    if (!res.ok) {
      throw new Error(asErrorMessage(payload, "Failed to load installed state."));
    }
    setInstallations(Array.isArray(payload.installations) ? payload.installations : []);
  }

  function setSkillsSelection(skillIds: string[], shouldSelect: boolean): void {
    setSelectionCustomized(true);
    setSelectedSkills((current) => {
      const next = new Set(current);
      for (const id of skillIds) {
        if (shouldSelect) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function toggleSkill(skillId: string): void {
    setSelectionCustomized(true);
    setSelectedSkills((current) => {
      const next = new Set(current);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return next;
    });
  }

  function toggleTarget(target: Target): void {
    setTargets((current) => {
      const next = new Set(current);
      if (next.has(target)) {
        if (next.size === 1) {
          return current;
        }
        next.delete(target);
      } else {
        next.add(target);
      }
      return next;
    });
  }

  async function runOperation(operation: "install" | "uninstall" | "sync"): Promise<void> {
    setBusy(true);
    setError("");
    setReport(null);

    if (selectedTargetList.length === 0) {
      setBusy(false);
      setError("Select at least one target.");
      return;
    }
    if (scope === "project" && !trimmedProjectPath) {
      setBusy(false);
      setError("Project scope requires a project path.");
      return;
    }

    try {
      const selections = Array.from(selectedSkills)
        .map((skillId) => {
          const skill = skillById.get(skillId);
          if (!skill) return null;
          return {
            sourceId: skill.sourceId,
            skillName: skill.skillName,
            skillId: skill.skillId,
          };
        })
        .filter((item): item is { sourceId: string; skillName: string; skillId: string } => Boolean(item));

      const res = await fetch(`/api/v1/${operation}/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operation,
          targets: selectedTargetList,
          scope,
          projectPath: scope === "project" ? trimmedProjectPath : undefined,
          mode,
          skills: [],
          skillSelections: selections,
          removeUnselected: operation === "sync",
          installClaudeIntegration: true,
        }),
      });

      const payload = (await res.json()) as OperationReport | { error?: string };
      if (!res.ok) {
        throw new Error(asErrorMessage(payload, "Operation failed."));
      }
      setReport(payload as OperationReport);
      await fetchInstallations();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addSourceFromForm(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: sourceName.trim() || undefined,
          repoUrl: sourceRepoUrl.trim(),
          transport: sourceTransport,
          token: sourceToken.trim() || undefined,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(asErrorMessage(payload, "Failed to add source."));
      }
      setSourceRepoUrl("");
      setSourceName("");
      setSourceToken("");
      await fetchSources();
      await fetchSkills(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function refreshSource(sourceId?: string): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const endpoint = sourceId ? `/api/v1/sources/${sourceId}/refresh` : "/api/v1/sources/refresh-all";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(asErrorMessage(payload, "Source refresh failed."));
      }
      await fetchSources();
      await fetchSkills();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSource(source: Source): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/v1/sources/${source.id}`, { method: "DELETE" });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(asErrorMessage(payload, "Source removal failed."));
      }
      await fetchSources();
      await fetchSkills();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function pickProjectPath(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/v1/projects/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          initialPath: trimmedProjectPath || undefined,
        }),
      });
      const payload = (await res.json()) as { path?: string; error?: string };
      if (!res.ok) {
        throw new Error(asErrorMessage(payload, "Project picker failed."));
      }
      if (payload.path) {
        setProjectPath(payload.path);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function mountProjectInContainer(): Promise<void> {
    if (!trimmedProjectPath) {
      setError("Set a project path first.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/v1/container/mount-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath: trimmedProjectPath,
          confirm: true,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(asErrorMessage(payload, "Container mount failed."));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    fetchDiscoveredTargets().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    fetchSources()
      .then(() => fetchSkills(true))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    setSelectionCustomized(false);
    fetchInstallations().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [scope, trimmedProjectPath, targetKey]);

  useEffect(() => {
    if (selectionCustomized) return;
    setSelectedSkills(new Set(installedSkillIds));
  }, [installedSkillIds, selectionCustomized]);

  const totalSkills = skills.length;
  const filteredSkillsCount = filteredCategorized.reduce((sum, [, categorySkills]) => sum + categorySkills.length, 0);
  const selectedSkillCount = selectedSkills.size;
  const installedSkillCount = installedSkillIds.size;

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero-topline">
          <p className="eyebrow">ICA COMMAND CENTER</p>
          <p className="stamp">Multi-source</p>
        </div>
        <h1>Skills Dashboard</h1>
        <p>Manage source repositories, pick project paths natively, and install source-pinned skills across targets.</p>
        <div className="hero-stats">
          <article className="stat-card">
            <span>Sources</span>
            <strong>{sources.length}</strong>
          </article>
          <article className="stat-card">
            <span>Installed Skills</span>
            <strong>{installedSkillCount}</strong>
          </article>
          <article className="stat-card">
            <span>Selected Skills</span>
            <strong>{selectedSkillCount}</strong>
          </article>
        </div>
      </header>

      {error && (
        <section className="status status-error">
          <strong>Action needed:</strong> {error}
        </section>
      )}

      <div className="workspace">
        <aside className="control-rail">
          <section className="panel">
            <h2>Sources</h2>
            <div className="subtle">{sources.length} configured</div>
            <div className="source-list">
              {sources.map((source) => (
                <article key={source.id} className="source-item">
                  <strong>{source.id}</strong>
                  <span>{source.repoUrl}</span>
                  <span>{source.lastSyncAt ? `synced ${new Date(source.lastSyncAt).toLocaleString()}` : "never synced"}</span>
                  {source.lastError && <span className="source-error">{source.lastError}</span>}
                  <div className="source-actions">
                    <button className="btn btn-inline" type="button" disabled={busy} onClick={() => refreshSource(source.id)}>
                      Refresh
                    </button>
                    {source.removable && (
                      <button className="btn btn-inline" type="button" disabled={busy} onClick={() => deleteSource(source)}>
                        Remove
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
            <input
              className="input"
              placeholder="Source name (optional)"
              value={sourceName}
              onChange={(event) => setSourceName(event.target.value)}
            />
            <input
              className="input"
              placeholder="https://github.com/org/repo.git"
              value={sourceRepoUrl}
              onChange={(event) => setSourceRepoUrl(event.target.value)}
            />
            <label className="line">
              <input type="radio" checked={sourceTransport === "https"} onChange={() => setSourceTransport("https")} /> HTTPS
            </label>
            <label className="line">
              <input type="radio" checked={sourceTransport === "ssh"} onChange={() => setSourceTransport("ssh")} /> SSH
            </label>
            {sourceTransport === "https" && (
              <input
                className="input"
                placeholder="PAT / API key (optional for public repos)"
                value={sourceToken}
                onChange={(event) => setSourceToken(event.target.value)}
              />
            )}
            <button className="btn btn-secondary" type="button" disabled={busy || !sourceRepoUrl.trim()} onClick={addSourceFromForm}>
              Add source
            </button>
            <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => refreshSource()}>
              Refresh all sources
            </button>
          </section>

          <section className="panel">
            <h2>Targets</h2>
            <p className="subtle">Active: {selectedTargetList.join(", ")}</p>
            <div className="chip-grid">
              {allTargets.map((target) => (
                <button
                  key={target}
                  className={`chip ${targets.has(target) ? "is-active" : ""}`}
                  aria-pressed={targets.has(target)}
                  onClick={() => toggleTarget(target)}
                  type="button"
                >
                  {target}
                </button>
              ))}
            </div>
          </section>

          <section className="panel">
            <h2>Scope</h2>
            <label className="line">
              <input type="radio" checked={scope === "user"} onChange={() => setScope("user")} /> User
            </label>
            <label className="line">
              <input type="radio" checked={scope === "project"} onChange={() => setScope("project")} /> Project
            </label>
            {scope === "project" && (
              <>
                <input
                  className="input"
                  placeholder="/path/to/project"
                  value={projectPath}
                  onChange={(event) => setProjectPath(event.target.value)}
                />
                <button className="btn btn-inline" type="button" disabled={busy} onClick={pickProjectPath}>
                  Pick project (native)
                </button>
                <button className="btn btn-inline" type="button" disabled={busy || !trimmedProjectPath} onClick={mountProjectInContainer}>
                  Mount in container
                </button>
              </>
            )}
          </section>

          <section className="panel">
            <h2>Install Mode</h2>
            <label className="line">
              <input type="radio" checked={mode === "symlink"} onChange={() => setMode("symlink")} /> Symlink
            </label>
            <label className="line">
              <input type="radio" checked={mode === "copy"} onChange={() => setMode("copy")} /> Full copy
            </label>
          </section>

          <section className="panel action-panel">
            <h2>Actions</h2>
            <button className="btn btn-primary" disabled={busy} onClick={() => runOperation("install")} type="button">
              Install selected
            </button>
            <button className="btn btn-secondary" disabled={busy} onClick={() => runOperation("uninstall")} type="button">
              Uninstall selected
            </button>
            <button className="btn btn-tertiary" disabled={busy} onClick={() => runOperation("sync")} type="button">
              Sync to selection
            </button>
          </section>
        </aside>

        <main className="catalog-column">
          <section className="panel panel-catalog">
            <div className="catalog-head">
              <div>
                <h2>Skill Catalog</h2>
                <p className="subtle">
                  {selectedSkillCount}/{totalSkills} selected
                  {normalizedQuery ? ` • ${filteredSkillsCount} shown` : ""}
                </p>
              </div>
              <div className="bulk-actions">
                <button className="btn btn-ghost" onClick={() => setSkillsSelection(skills.map((skill) => skill.skillId), true)} type="button">
                  Select all
                </button>
                <button className="btn btn-ghost" onClick={() => setSkillsSelection(skills.map((skill) => skill.skillId), false)} type="button">
                  Clear all
                </button>
              </div>
            </div>

            <input
              className="input input-search"
              placeholder="Search source/skill, descriptions, resources..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />

            {filteredCategorized.length === 0 && <div className="empty-state">No skills match this search. Try a broader term.</div>}

            {filteredCategorized.map(([category, categorySkills]) => {
              const ids = categorySkills.map((skill) => skill.skillId);
              const selectedInCategory = ids.filter((id) => selectedSkills.has(id)).length;
              const allSelectedInCategory = selectedInCategory === ids.length && ids.length > 0;

              return (
                <section key={category} className="category-block">
                  <header className="category-head">
                    <h3>{category}</h3>
                    <div className="category-actions">
                      <span>
                        {selectedInCategory}/{ids.length}
                      </span>
                      <button className="btn btn-inline" onClick={() => setSkillsSelection(ids, !allSelectedInCategory)} type="button">
                        {allSelectedInCategory ? "Clear category" : "Select category"}
                      </button>
                    </div>
                  </header>

                  <div className="skill-grid">
                    {categorySkills.map((skill) => {
                      const isSelected = selectedSkills.has(skill.skillId);
                      const isInstalled = installedSkillIds.has(skill.skillId);
                      return (
                        <article key={skill.skillId} className={`skill ${isSelected ? "selected" : ""}`}>
                          <label className="skill-title">
                            <input type="checkbox" checked={isSelected} onChange={() => toggleSkill(skill.skillId)} />
                            <strong>{skill.skillId}</strong>
                            {isInstalled && <span className="badge">installed</span>}
                          </label>
                          <p>{skill.description}</p>
                          <p className="subtle">{skill.skillName} <span className="resource-type">{skill.sourceId}</span></p>
                          {skill.resources.length > 0 && (
                            <ul>
                              {skill.resources.map((resource) => (
                                <li key={`${skill.skillId}-${resource.path}`}>
                                  <span className="resource-type">{resource.type}</span>
                                  <code>{resource.path}</code>
                                </li>
                              ))}
                            </ul>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </section>

          <details className="panel collapsible">
            <summary>
              <span>Installed State</span>
              <span className="subtle">{installations.length} target entries</span>
            </summary>
            <pre>{JSON.stringify(installations, null, 2)}</pre>
          </details>

          <details className="panel collapsible">
            <summary>
              <span>Operation Report</span>
              <span className="subtle">{report ? "latest run available" : "no operation yet"}</span>
            </summary>
            <pre>{report ? JSON.stringify(report, null, 2) : "No operation run yet."}</pre>
          </details>
        </main>
      </div>
    </div>
  );
}
