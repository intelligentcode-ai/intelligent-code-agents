import React, { useEffect, useMemo, useState } from "react";

type Target = "claude" | "codex" | "cursor" | "gemini" | "antigravity";

type Skill = {
  name: string;
  description: string;
  category: string;
  resources: Array<{ type: string; path: string }>;
};

type InstallationSkill = {
  name: string;
  installMode: string;
  effectiveMode: string;
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

export function App(): JSX.Element {
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

  const selectedTargetList = useMemo(() => Array.from(targets).sort(), [targets]);
  const trimmedProjectPath = projectPath.trim();
  const targetKey = selectedTargetList.join(",");

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
          const haystack = `${skill.name} ${skill.description} ${skill.category} ${resourceText}`.toLowerCase();
          return haystack.includes(normalizedQuery);
        });
        return [category, filtered] as [string, Skill[]];
      })
      .filter(([, categorySkills]) => categorySkills.length > 0);
  }, [categorized, normalizedQuery]);

  const installedSkillNames = useMemo(() => {
    const names = new Set<string>();
    for (const row of installations) {
      for (const skill of row.managedSkills || []) {
        names.add(skill.name);
      }
    }
    return names;
  }, [installations]);

  async function fetchSkills(): Promise<void> {
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

  function setSkillsSelection(skillNames: string[], shouldSelect: boolean): void {
    setSelectionCustomized(true);
    setSelectedSkills((current) => {
      const next = new Set(current);
      for (const name of skillNames) {
        if (shouldSelect) {
          next.add(name);
        } else {
          next.delete(name);
        }
      }
      return next;
    });
  }

  function toggleSkill(name: string): void {
    setSelectionCustomized(true);
    setSelectedSkills((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
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
          skills: Array.from(selectedSkills),
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

  useEffect(() => {
    fetchDiscoveredTargets().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    fetchSkills().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    setSelectionCustomized(false);
    fetchInstallations().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [scope, trimmedProjectPath, targetKey]);

  useEffect(() => {
    if (selectionCustomized) {
      return;
    }
    const next = new Set(Array.from(installedSkillNames));
    setSelectedSkills((current) => {
      if (current.size === next.size && Array.from(current).every((name) => next.has(name))) {
        return current;
      }
      return next;
    });
  }, [installedSkillNames, selectionCustomized]);

  const totalSkills = skills.length;
  const filteredSkillsCount = filteredCategorized.reduce((sum, [, categorySkills]) => sum + categorySkills.length, 0);
  const selectedSkillCount = selectedSkills.size;
  const installedSkillCount = installedSkillNames.size;

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero-topline">
          <p className="eyebrow">ICA COMMAND CENTER</p>
          <p className="stamp">Blue Theme</p>
        </div>
        <h1>Skills Dashboard</h1>
        <p>
          Control installations across targets with one selection model. Tune once, install or sync everywhere.
        </p>
        <div className="hero-stats">
          <article className="stat-card">
            <span>Selected Targets</span>
            <strong>{selectedTargetList.length}</strong>
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
              <input
                className="input"
                placeholder="/path/to/project"
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
              />
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
                <button
                  className="btn btn-ghost"
                  onClick={() => setSkillsSelection(skills.map((skill) => skill.name), true)}
                  type="button"
                >
                  Select all
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => setSkillsSelection(skills.map((skill) => skill.name), false)}
                  type="button"
                >
                  Clear all
                </button>
              </div>
            </div>

            <input
              className="input input-search"
              placeholder="Search skills, descriptions, resources..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
            />

            {filteredCategorized.length === 0 && (
              <div className="empty-state">No skills match this search. Try a broader term.</div>
            )}

            {filteredCategorized.map(([category, categorySkills]) => {
              const names = categorySkills.map((skill) => skill.name);
              const selectedInCategory = names.filter((name) => selectedSkills.has(name)).length;
              const allSelectedInCategory = selectedInCategory === names.length && names.length > 0;

              return (
                <section key={category} className="category-block">
                  <header className="category-head">
                    <h3>{category}</h3>
                    <div className="category-actions">
                      <span>{selectedInCategory}/{names.length}</span>
                      <button
                        className="btn btn-inline"
                        onClick={() => setSkillsSelection(names, !allSelectedInCategory)}
                        type="button"
                      >
                        {allSelectedInCategory ? "Clear category" : "Select category"}
                      </button>
                    </div>
                  </header>

                  <div className="skill-grid">
                    {categorySkills.map((skill) => {
                      const isSelected = selectedSkills.has(skill.name);
                      const isInstalled = installedSkillNames.has(skill.name);
                      return (
                        <article key={skill.name} className={`skill ${isSelected ? "selected" : ""}`}>
                          <label className="skill-title">
                            <input
                              type="checkbox"
                              name={skill.name}
                              checked={isSelected}
                              onChange={() => toggleSkill(skill.name)}
                            />
                            <strong>{skill.name}</strong>
                            {isInstalled && <span className="badge">installed</span>}
                          </label>
                          <p>{skill.description}</p>
                          {skill.resources.length > 0 && (
                            <ul>
                              {skill.resources.map((resource) => (
                                <li key={`${skill.name}-${resource.path}`}>
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
