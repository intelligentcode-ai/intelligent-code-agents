import React, { useEffect, useMemo, useRef, useState } from "react";

type Target = "claude" | "codex" | "cursor" | "gemini" | "antigravity";

type Source = {
  id: string;
  name: string;
  repoUrl: string;
  transport: "https" | "ssh";
  official: boolean;
  enabled: boolean;
  skillsRoot: string;
  hooksRoot?: string;
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
  scope?: string;
  subcategory?: string;
  tags?: string[];
  author?: string;
  contactEmail?: string;
  website?: string;
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

type Hook = {
  hookId: string;
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  hookName: string;
  name: string;
  description: string;
  version?: string;
  updatedAt?: string;
};

type HookInstallation = {
  name: string;
  hookId?: string;
  sourceId?: string;
  installMode: string;
  effectiveMode: string;
  orphaned?: boolean;
};

type HookInstallationRow = {
  target: "claude" | "gemini";
  installPath: string;
  scope: "user" | "project";
  projectPath?: string;
  installed: boolean;
  managedHooks: HookInstallation[];
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

type HookOperationTargetReport = {
  target: "claude" | "gemini";
  installPath: string;
  operation: "install" | "uninstall" | "sync";
  appliedHooks: string[];
  removedHooks: string[];
  skippedHooks: string[];
  warnings: Array<{ code: string; message: string }>;
  errors: Array<{ code: string; message: string }>;
};

type HookOperationReport = {
  startedAt: string;
  completedAt: string;
  request?: unknown;
  targets: HookOperationTargetReport[];
};

type DashboardTab = "skills" | "hooks" | "settings" | "state";
type DashboardMode = "light" | "dark";
type DashboardAccent = "slate" | "blue" | "red" | "green" | "amber";
type DashboardBackground = "slate" | "ocean" | "sand" | "forest" | "wine";
type LegacyDashboardTheme = "light" | "dark" | "blue" | "red" | "green";

const allTargets: Target[] = ["claude", "codex", "cursor", "gemini", "antigravity"];
const modeStorageKey = "ica.dashboard.mode";
const accentStorageKey = "ica.dashboard.accent";
const backgroundStorageKey = "ica.dashboard.background";
const legacyThemeStorageKey = "ica.dashboard.theme";
const modeOptions: Array<{ id: DashboardMode; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];
const accentOptions: Array<{ id: DashboardAccent; label: string }> = [
  { id: "slate", label: "Slate" },
  { id: "blue", label: "Blue" },
  { id: "red", label: "Red" },
  { id: "green", label: "Green" },
  { id: "amber", label: "Amber" },
];
const backgroundOptions: Array<{ id: DashboardBackground; label: string }> = [
  { id: "slate", label: "Slate" },
  { id: "ocean", label: "Ocean" },
  { id: "sand", label: "Sand" },
  { id: "forest", label: "Forest" },
  { id: "wine", label: "Wine" },
];

function isDashboardMode(value: string | null): value is DashboardMode {
  return value === "light" || value === "dark";
}

function isDashboardAccent(value: string | null): value is DashboardAccent {
  return value === "slate" || value === "blue" || value === "red" || value === "green" || value === "amber";
}

function isDashboardBackground(value: string | null): value is DashboardBackground {
  return value === "slate" || value === "ocean" || value === "sand" || value === "forest" || value === "wine";
}

function isLegacyTheme(value: string | null): value is LegacyDashboardTheme {
  return value === "light" || value === "dark" || value === "blue" || value === "red" || value === "green";
}

function mapLegacyTheme(theme: LegacyDashboardTheme): {
  mode: DashboardMode;
  accent: DashboardAccent;
  background: DashboardBackground;
} {
  switch (theme) {
    case "light":
      return { mode: "light", accent: "slate", background: "slate" };
    case "dark":
      return { mode: "dark", accent: "slate", background: "slate" };
    case "blue":
      return { mode: "dark", accent: "blue", background: "ocean" };
    case "red":
      return { mode: "dark", accent: "red", background: "wine" };
    case "green":
      return { mode: "dark", accent: "green", background: "forest" };
  }
}

function readStoredAppearance(): { mode: DashboardMode; accent: DashboardAccent; background: DashboardBackground } {
  if (typeof window === "undefined") return { mode: "light", accent: "slate", background: "slate" };
  try {
    const storedMode = window.localStorage.getItem(modeStorageKey);
    const storedAccent = window.localStorage.getItem(accentStorageKey);
    const storedBackground = window.localStorage.getItem(backgroundStorageKey);
    if (isDashboardMode(storedMode) && isDashboardAccent(storedAccent) && isDashboardBackground(storedBackground)) {
      return { mode: storedMode, accent: storedAccent, background: storedBackground };
    }
    const legacyTheme = window.localStorage.getItem(legacyThemeStorageKey);
    if (isLegacyTheme(legacyTheme)) {
      return mapLegacyTheme(legacyTheme);
    }
  } catch {
    // ignore storage access errors
  }
  return { mode: "light", accent: "slate", background: "slate" };
}

function asErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const candidate = (payload as { error?: unknown }).error;
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return fallback;
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

export function InstallerDashboard(): JSX.Element {
  const [sources, setSources] = useState<Source[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [selectedHooks, setSelectedHooks] = useState<Set<string>>(new Set());
  const [targets, setTargets] = useState<Set<Target>>(new Set(["codex"]));
  const [searchQuery, setSearchQuery] = useState("");
  const [hookSearchQuery, setHookSearchQuery] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [projectPath, setProjectPath] = useState("");
  const [mode, setMode] = useState<"symlink" | "copy">("symlink");
  const [installations, setInstallations] = useState<InstallationRow[]>([]);
  const [hookInstallations, setHookInstallations] = useState<HookInstallationRow[]>([]);
  const [report, setReport] = useState<OperationReport | null>(null);
  const [hookReport, setHookReport] = useState<HookOperationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoadingMessage, setCatalogLoadingMessage] = useState("");
  const [catalogLoadingProgress, setCatalogLoadingProgress] = useState(0);
  const [selectionCustomized, setSelectionCustomized] = useState(false);
  const [sourceRepoUrl, setSourceRepoUrl] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [sourceTransport, setSourceTransport] = useState<"https" | "ssh">("https");
  const [sourceToken, setSourceToken] = useState("");
  const [activeTab, setActiveTab] = useState<DashboardTab>("skills");
  const [appearanceMode, setAppearanceMode] = useState<DashboardMode>(() => readStoredAppearance().mode);
  const [appearanceAccent, setAppearanceAccent] = useState<DashboardAccent>(() => readStoredAppearance().accent);
  const [appearanceBackground, setAppearanceBackground] = useState<DashboardBackground>(() => readStoredAppearance().background);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [hookSourceFilter, setHookSourceFilter] = useState<string>("all");
  const [hooksInstalledOnly, setHooksInstalledOnly] = useState(false);
  const [hookSelectionCustomized, setHookSelectionCustomized] = useState(false);
  const appearancePanelRef = useRef<HTMLElement | null>(null);
  const appearanceTriggerRef = useRef<HTMLButtonElement | null>(null);

  const selectedTargetList = useMemo(() => Array.from(targets).sort(), [targets]);
  const selectedHookTargetList = useMemo(
    () => selectedTargetList.filter((target): target is "claude" | "gemini" => target === "claude" || target === "gemini"),
    [selectedTargetList],
  );
  const trimmedProjectPath = projectPath.trim();
  const targetKey = selectedTargetList.join(",");
  const skillById = useMemo(() => new Map(skills.map((skill) => [skill.skillId, skill])), [skills]);
  const hookById = useMemo(() => new Map(hooks.map((hook) => [hook.hookId, hook])), [hooks]);
  const sourceNameById = useMemo(() => new Map(sources.map((source) => [source.id, source.name || source.id])), [sources]);

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

  const installedHookIds = useMemo(() => {
    const names = new Set<string>();
    for (const row of hookInstallations) {
      for (const hook of row.managedHooks || []) {
        if (hook.hookId) {
          names.add(hook.hookId);
        } else {
          const match = hooks.find((item) => item.hookName === hook.name);
          if (match) names.add(match.hookId);
        }
      }
    }
    return names;
  }, [hookInstallations, hooks]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const normalizedHookQuery = hookSearchQuery.trim().toLowerCase();
  const sourceFilterOptions = useMemo(() => {
    return Array.from(new Set(skills.map((skill) => skill.sourceId))).sort((a, b) => a.localeCompare(b));
  }, [skills]);
  const scopeFilterOptions = useMemo(() => {
    return Array.from(new Set(skills.map((skill) => (skill.scope || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [skills]);
  const categoryFilterOptions = useMemo(() => {
    return Array.from(new Set(skills.map((skill) => skill.category).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [skills]);
  const tagFilterOptions = useMemo(() => {
    return Array.from(new Set(skills.flatMap((skill) => skill.tags || []).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }, [skills]);
  const hookSourceFilterOptions = useMemo(() => {
    return Array.from(new Set(hooks.map((hook) => hook.sourceId))).sort((a, b) => a.localeCompare(b));
  }, [hooks]);

  const visibleSkills = useMemo(() => {
    return skills.filter((skill) => {
      if (sourceFilter !== "all" && skill.sourceId !== sourceFilter) {
        return false;
      }
      if (scopeFilter !== "all" && (skill.scope || "") !== scopeFilter) {
        return false;
      }
      if (categoryFilter !== "all" && skill.category !== categoryFilter) {
        return false;
      }
      if (tagFilter !== "all" && !(skill.tags || []).includes(tagFilter)) {
        return false;
      }
      if (installedOnly && !installedSkillIds.has(skill.skillId)) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const resourceText = skill.resources.map((item) => `${item.type} ${item.path}`).join(" ");
      const tagText = (skill.tags || []).join(" ");
      const haystack = `${skill.skillId} ${skill.description} ${skill.category} ${skill.scope || ""} ${skill.subcategory || ""} ${tagText} ${resourceText}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [skills, sourceFilter, scopeFilter, categoryFilter, tagFilter, installedOnly, installedSkillIds, normalizedQuery]);

  const filteredCategorized = useMemo(() => {
    const byCategory = new Map<string, Skill[]>();
    for (const skill of visibleSkills) {
      const current = byCategory.get(skill.category) || [];
      current.push(skill);
      byCategory.set(skill.category, current);
    }
    return Array.from(byCategory.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [visibleSkills]);

  const visibleHooks = useMemo(() => {
    return hooks.filter((hook) => {
      if (hookSourceFilter !== "all" && hook.sourceId !== hookSourceFilter) {
        return false;
      }
      if (hooksInstalledOnly && !installedHookIds.has(hook.hookId)) {
        return false;
      }
      if (!normalizedHookQuery) {
        return true;
      }
      const haystack = `${hook.hookId} ${hook.description}`.toLowerCase();
      return haystack.includes(normalizedHookQuery);
    });
  }, [hooks, hookSourceFilter, hooksInstalledOnly, installedHookIds, normalizedHookQuery]);

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
    setCatalogLoading(true);
    setCatalogLoadingProgress(runRefresh ? 8 : 20);
    setCatalogLoadingMessage(runRefresh ? "Refreshing sources…" : "Loading skills catalog…");
    try {
      if (runRefresh) {
        await refreshSources(true);
        setCatalogLoadingProgress(58);
        setCatalogLoadingMessage("Loading refreshed skills catalog…");
      }
      const res = await fetch("/api/v1/catalog/skills");
      const payload = (await res.json()) as { skills?: Skill[]; error?: string };
      if (!res.ok) {
        throw new Error(asErrorMessage(payload, "Failed to load skills catalog."));
      }
      setCatalogLoadingProgress(88);
      setSkills(Array.isArray(payload.skills) ? payload.skills : []);
      setCatalogLoadingProgress(100);
      setCatalogLoadingMessage("Skills catalog is ready.");
    } finally {
      window.setTimeout(() => {
        setCatalogLoading(false);
        setCatalogLoadingProgress(0);
        setCatalogLoadingMessage("");
      }, 250);
    }
  }

  async function fetchHooks(): Promise<void> {
    const res = await fetch("/api/v1/catalog/hooks");
    const payload = (await res.json()) as { hooks?: Hook[]; error?: string };
    if (!res.ok) {
      throw new Error(asErrorMessage(payload, "Failed to load hooks catalog."));
    }
    setHooks(Array.isArray(payload.hooks) ? payload.hooks : []);
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

  async function fetchHookInstallations(): Promise<void> {
    if (scope === "project" && !trimmedProjectPath) {
      setHookInstallations([]);
      return;
    }

    if (selectedHookTargetList.length === 0) {
      setHookInstallations([]);
      return;
    }

    const query = new URLSearchParams({
      scope,
      ...(scope === "project" ? { projectPath: trimmedProjectPath } : {}),
      targets: selectedHookTargetList.join(","),
    });

    const res = await fetch(`/api/v1/hooks/installations?${query.toString()}`);
    const payload = (await res.json()) as { installations?: HookInstallationRow[]; error?: string };
    if (!res.ok) {
      throw new Error(asErrorMessage(payload, "Failed to load installed hook state."));
    }
    setHookInstallations(Array.isArray(payload.installations) ? payload.installations : []);
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

  function setHooksSelection(hookIds: string[], shouldSelect: boolean): void {
    setHookSelectionCustomized(true);
    setSelectedHooks((current) => {
      const next = new Set(current);
      for (const id of hookIds) {
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

  function toggleHook(hookId: string): void {
    setHookSelectionCustomized(true);
    setSelectedHooks((current) => {
      const next = new Set(current);
      if (next.has(hookId)) next.delete(hookId);
      else next.add(hookId);
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

  async function runHookOperation(operation: "install" | "uninstall" | "sync"): Promise<void> {
    setBusy(true);
    setError("");
    setHookReport(null);

    if (selectedHookTargetList.length === 0) {
      setBusy(false);
      setError("Hooks are supported only for Claude and Gemini targets. Select at least one of those.");
      return;
    }
    if (scope === "project" && !trimmedProjectPath) {
      setBusy(false);
      setError("Project scope requires a project path.");
      return;
    }

    try {
      const selections = Array.from(selectedHooks)
        .map((hookId) => {
          const hook = hookById.get(hookId);
          if (!hook) return null;
          return {
            sourceId: hook.sourceId,
            hookName: hook.hookName,
            hookId: hook.hookId,
          };
        })
        .filter((item): item is { sourceId: string; hookName: string; hookId: string } => Boolean(item));

      const res = await fetch(`/api/v1/hooks/${operation}/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operation,
          targets: selectedHookTargetList,
          scope,
          projectPath: scope === "project" ? trimmedProjectPath : undefined,
          mode,
          hooks: [],
          hookSelections: selections,
          removeUnselected: operation === "sync",
        }),
      });

      const payload = (await res.json()) as HookOperationReport | { error?: string };
      if (!res.ok) {
        throw new Error(asErrorMessage(payload, "Hook operation failed."));
      }
      setHookReport(payload as HookOperationReport);
      await fetchHookInstallations();
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
      await fetchHooks();
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
      await fetchHooks();
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
      await fetchHooks();
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
      .then(async () => {
        await fetchSkills(true);
        await fetchHooks();
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    setSelectionCustomized(false);
    setHookSelectionCustomized(false);
    Promise.all([fetchInstallations(), fetchHookInstallations()]).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [scope, trimmedProjectPath, targetKey, selectedHookTargetList.join(",")]);

  useEffect(() => {
    if (selectionCustomized) return;
    setSelectedSkills(new Set(installedSkillIds));
  }, [installedSkillIds, selectionCustomized]);

  useEffect(() => {
    if (hookSelectionCustomized) return;
    setSelectedHooks(new Set(installedHookIds));
  }, [installedHookIds, hookSelectionCustomized]);

  useEffect(() => {
    if (sourceFilter === "all") return;
    if (!sourceFilterOptions.includes(sourceFilter)) {
      setSourceFilter("all");
    }
  }, [sourceFilter, sourceFilterOptions]);

  useEffect(() => {
    if (hookSourceFilter === "all") return;
    if (!hookSourceFilterOptions.includes(hookSourceFilter)) {
      setHookSourceFilter("all");
    }
  }, [hookSourceFilter, hookSourceFilterOptions]);

  useEffect(() => {
    if (catalogLoading || skills.length === 0) return;
    setSelectedSkills((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const skillId of current) {
        if (skillById.has(skillId)) {
          next.add(skillId);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [catalogLoading, skills.length, skillById]);

  useEffect(() => {
    if (hooks.length === 0) return;
    setSelectedHooks((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const hookId of current) {
        if (hookById.has(hookId)) {
          next.add(hookId);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [hooks.length, hookById]);

  useEffect(() => {
    document.body.dataset.mode = appearanceMode;
    document.body.dataset.accent = appearanceAccent;
    document.body.dataset.background = appearanceBackground;
    document.documentElement.dataset.mode = appearanceMode;
    document.documentElement.dataset.accent = appearanceAccent;
    document.documentElement.dataset.background = appearanceBackground;
    try {
      window.localStorage.setItem(modeStorageKey, appearanceMode);
      window.localStorage.setItem(accentStorageKey, appearanceAccent);
      window.localStorage.setItem(backgroundStorageKey, appearanceBackground);
    } catch {
      // ignore storage access errors
    }
  }, [appearanceMode, appearanceAccent, appearanceBackground]);

  useEffect(() => {
    if (!appearanceOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (appearancePanelRef.current?.contains(target)) return;
      if (appearanceTriggerRef.current?.contains(target)) return;
      setAppearanceOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setAppearanceOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [appearanceOpen]);

  const totalSkills = skills.length;
  const filteredSkillsCount = visibleSkills.length;
  const selectedSkillCount = selectedSkills.size;
  const selectedKnownSkillCount = useMemo(() => {
    let count = 0;
    for (const skillId of selectedSkills) {
      if (skillById.has(skillId)) count += 1;
    }
    return count;
  }, [selectedSkills, skillById]);
  const selectedUnknownSkillCount = Math.max(0, selectedSkillCount - selectedKnownSkillCount);
  const installedSkillCount = installedSkillIds.size;
  const totalHooks = hooks.length;
  const filteredHooksCount = visibleHooks.length;
  const selectedKnownHookCount = useMemo(() => {
    let count = 0;
    for (const hookId of selectedHooks) {
      if (hookById.has(hookId)) count += 1;
    }
    return count;
  }, [selectedHooks, hookById]);
  const selectedUnknownHookCount = Math.max(0, selectedHooks.size - selectedKnownHookCount);
  const installedHookCount = installedHookIds.size;

  return (
    <div className="shell">
      <header className="hero">
        <div className="hero-topline">
          <p className="eyebrow">ICA COMMAND CENTER</p>
          <p className="stamp">Multi-source</p>
        </div>
        <h1>Skills & Hooks Dashboard</h1>
        <p>Manage repositories once, then install source-pinned skills and hooks across targets.</p>
        <div className="hero-meta">
          <span>{sources.length} sources</span>
          <span>{installedSkillCount} skills installed</span>
          <span>{installedHookCount} hooks installed</span>
        </div>
      </header>

      {error && (
        <section className="status status-error">
          <strong>Action needed:</strong> {error}
        </section>
      )}
      {catalogLoading && (
        <section className="status status-info" role="status" aria-live="polite">
          <div className="status-head">
            <strong>Loading skills catalog</strong>
            <span>{Math.round(catalogLoadingProgress)}%</span>
          </div>
          <div className="status-subtle">{catalogLoadingMessage || "Working…"}</div>
          <div className="status-progress" aria-hidden="true">
            <div className="status-progress-bar" style={{ width: `${Math.max(5, Math.min(catalogLoadingProgress, 100))}%` }} />
          </div>
        </section>
      )}

      <div className="toolbar">
        <nav className="tab-nav" role="tablist" aria-label="Dashboard sections">
          <button
            className={`tab-btn ${activeTab === "skills" ? "is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeTab === "skills"}
            onClick={() => setActiveTab("skills")}
          >
            Skills
          </button>
          <button
            className={`tab-btn ${activeTab === "hooks" ? "is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeTab === "hooks"}
            onClick={() => setActiveTab("hooks")}
          >
            Hooks
          </button>
          <button
            className={`tab-btn ${activeTab === "settings" ? "is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeTab === "settings"}
            onClick={() => setActiveTab("settings")}
          >
            Settings
          </button>
          <button
            className={`tab-btn ${activeTab === "state" ? "is-active" : ""}`}
            type="button"
            role="tab"
            aria-selected={activeTab === "state"}
            onClick={() => setActiveTab("state")}
          >
            States & Reports
          </button>
        </nav>
        <div className="toolbar-actions">
          <button
            ref={appearanceTriggerRef}
            className={`btn btn-ghost appearance-toggle ${appearanceOpen ? "is-active" : ""}`}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={appearanceOpen}
            aria-controls="appearance-panel"
            onClick={() => setAppearanceOpen((value) => !value)}
          >
            <svg className="appearance-toggle-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm9 3.5c0-.4-.3-.8-.7-.9l-1.6-.4a7 7 0 0 0-.6-1.4l.9-1.4c.2-.3.2-.8 0-1.1l-1.3-1.3a1 1 0 0 0-1.1 0l-1.4.9c-.5-.2-1-.5-1.5-.6l-.3-1.6a1 1 0 0 0-1-.7h-1.8c-.4 0-.8.3-.9.7l-.4 1.6c-.5.1-1 .4-1.5.6L6.4 4.9a1 1 0 0 0-1.1 0L4 6.2a1 1 0 0 0 0 1.1l.9 1.4c-.3.5-.5 1-.7 1.4l-1.5.4a1 1 0 0 0-.7 1V13c0 .4.3.8.7.9l1.6.4c.1.5.4 1 .6 1.5l-.9 1.4a1 1 0 0 0 0 1.1L5.3 20a1 1 0 0 0 1.1 0l1.4-.9c.5.3 1 .5 1.4.6l.4 1.6c.1.4.5.7.9.7h1.8c.4 0 .8-.3.9-.7l.4-1.6c.5-.1 1-.3 1.4-.6l1.4.9a1 1 0 0 0 1.1 0l1.3-1.3a1 1 0 0 0 0-1.1l-.9-1.4c.3-.5.5-1 .6-1.5l1.6-.4c.4-.1.7-.5.7-.9V12Z"
                fill="currentColor"
              />
            </svg>
            Appearance
          </button>
          {appearanceOpen && (
            <section ref={appearancePanelRef} id="appearance-panel" className="appearance-popover" aria-label="Appearance panel">
              <div className="theme-row">
                <div className="theme-group">
                  <span className="theme-label">Theme</span>
                  <div className="theme-buttons">
                    {modeOptions.map((option) => (
                      <button
                        key={option.id}
                        className={`theme-btn ${appearanceMode === option.id ? "is-active" : ""}`}
                        type="button"
                        onClick={() => setAppearanceMode(option.id)}
                        aria-pressed={appearanceMode === option.id}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="theme-group theme-group-accent">
                  <span className="theme-label">Accent</span>
                  <div className="theme-buttons">
                    {accentOptions.map((option) => (
                      <button
                        key={option.id}
                        className={`theme-btn theme-btn-accent ${appearanceAccent === option.id ? "is-active" : ""}`}
                        type="button"
                        onClick={() => setAppearanceAccent(option.id)}
                        aria-pressed={appearanceAccent === option.id}
                        data-accent={option.id}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="theme-group theme-group-wide">
                <span className="theme-label">Background</span>
                <div className="theme-buttons">
                  {backgroundOptions.map((option) => (
                    <button
                      key={option.id}
                      className={`theme-btn theme-btn-background ${appearanceBackground === option.id ? "is-active" : ""}`}
                      type="button"
                      onClick={() => setAppearanceBackground(option.id)}
                      aria-pressed={appearanceBackground === option.id}
                      data-background={option.id}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </section>
          )}
        </div>
      </div>

      {activeTab === "skills" && (
        <div className="workspace tab-section">
          <aside className="control-rail skills-rail">
            <section className="panel action-panel panel-spacious">
              <h2>Actions</h2>
              <p className="subtle">Apply source-pinned selections across your active targets.</p>
              <dl className="action-meta">
                <div>
                  <dt>Targets</dt>
                  <dd>{selectedTargetList.length}</dd>
                </div>
                <div>
                  <dt>Selection</dt>
                  <dd>{selectedKnownSkillCount}</dd>
                </div>
                <div>
                  <dt>Scope</dt>
                  <dd>{scope === "project" ? "Project" : "User"}</dd>
                </div>
                <div>
                  <dt>Mode</dt>
                  <dd>{mode}</dd>
                </div>
              </dl>
              {scope === "project" && <p className="operation-hint">Project path: {trimmedProjectPath || "not set"}</p>}
              <div className="action-row">
                <button className="btn btn-primary" disabled={busy} onClick={() => runOperation("install")} type="button">
                  Install selected
                </button>
                <button className="btn btn-secondary" disabled={busy} onClick={() => runOperation("uninstall")} type="button">
                  Uninstall selected
                </button>
                <button className="btn btn-tertiary" disabled={busy} onClick={() => runOperation("sync")} type="button">
                  Sync to selection
                </button>
              </div>
            </section>
          </aside>

          <main className="catalog-column">
            <section className="panel panel-catalog panel-spacious">
              <div className="catalog-head">
                <div>
                  <h2>Skill Catalog</h2>
                  <p className="subtle">
                    {catalogLoading
                      ? "Refreshing catalog…"
                      : totalSkills > 0
                        ? `${selectedKnownSkillCount}/${totalSkills} selected`
                        : `${selectedKnownSkillCount} selected`}
                    {!catalogLoading && selectedUnknownSkillCount > 0 ? ` • ${selectedUnknownSkillCount} unavailable` : ""}
                    {!catalogLoading && normalizedQuery ? ` • ${filteredSkillsCount} shown` : ""}
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

              <div className="catalog-controls">
                <input
                  className="input input-search"
                  placeholder="Search source/skill, scope, category, tags, resources…"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
                <div className="catalog-filters">
                  <div className="source-filter">
                    <span className="filter-label">Source</span>
                    <div className="source-chip-row">
                      <button
                        className={`chip chip-filter ${sourceFilter === "all" ? "is-active" : ""}`}
                        type="button"
                        onClick={() => setSourceFilter("all")}
                      >
                        all
                      </button>
                      {sourceFilterOptions.map((sourceId) => (
                        <button
                          key={sourceId}
                          className={`chip chip-filter ${sourceFilter === sourceId ? "is-active" : ""}`}
                          type="button"
                          onClick={() => setSourceFilter(sourceId)}
                        >
                          {sourceNameById.get(sourceId) || sourceId}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="source-filter">
                    <span className="filter-label">Scope</span>
                    <div className="source-chip-row">
                      <button className={`chip chip-filter ${scopeFilter === "all" ? "is-active" : ""}`} type="button" onClick={() => setScopeFilter("all")}>
                        all
                      </button>
                      {scopeFilterOptions.map((scopeId) => (
                        <button
                          key={scopeId}
                          className={`chip chip-filter ${scopeFilter === scopeId ? "is-active" : ""}`}
                          type="button"
                          onClick={() => setScopeFilter(scopeId)}
                        >
                          {titleCase(scopeId)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="source-filter">
                    <span className="filter-label">Category</span>
                    <div className="source-chip-row">
                      <button
                        className={`chip chip-filter ${categoryFilter === "all" ? "is-active" : ""}`}
                        type="button"
                        onClick={() => setCategoryFilter("all")}
                      >
                        all
                      </button>
                      {categoryFilterOptions.map((categoryId) => (
                        <button
                          key={categoryId}
                          className={`chip chip-filter ${categoryFilter === categoryId ? "is-active" : ""}`}
                          type="button"
                          onClick={() => setCategoryFilter(categoryId)}
                        >
                          {titleCase(categoryId)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="source-filter">
                    <span className="filter-label">Tag</span>
                    <div className="source-chip-row">
                      <button className={`chip chip-filter ${tagFilter === "all" ? "is-active" : ""}`} type="button" onClick={() => setTagFilter("all")}>
                        all
                      </button>
                      {tagFilterOptions.map((tagId) => (
                        <button
                          key={tagId}
                          className={`chip chip-filter ${tagFilter === tagId ? "is-active" : ""}`}
                          type="button"
                          onClick={() => setTagFilter(tagId)}
                        >
                          {tagId}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="toggle">
                    <input type="checkbox" checked={installedOnly} onChange={(event) => setInstalledOnly(event.target.checked)} />
                    Installed only
                  </label>
                </div>
              </div>

              {filteredCategorized.length === 0 && <div className="empty-state">No skills match this search. Try a broader term.</div>}

              {filteredCategorized.map(([category, categorySkills]) => {
                const ids = categorySkills.map((skill) => skill.skillId);
                const selectedInCategory = ids.filter((id) => selectedSkills.has(id)).length;
                const allSelectedInCategory = selectedInCategory === ids.length && ids.length > 0;

                return (
                  <section key={category} className="category-block">
                    <header className="category-head">
                      <h3>{titleCase(category)}</h3>
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
                            <div className="skill-top">
                              <label className="skill-title">
                                <input type="checkbox" checked={isSelected} onChange={() => toggleSkill(skill.skillId)} />
                                <span className="skill-title-copy">
                                  <strong>{skill.skillName}</strong>
                                  <code className="skill-id">{skill.skillId}</code>
                                </span>
                              </label>
                              <div className="skill-badges">
                                <span className="badge badge-source">{sourceNameById.get(skill.sourceId) || skill.sourceId}</span>
                                {isInstalled && <span className="badge">installed</span>}
                              </div>
                            </div>
                            <p className="skill-description">{skill.description}</p>
                            {(skill.scope || skill.subcategory || (skill.tags && skill.tags.length > 0)) && (
                              <div className="skill-badges">
                                {skill.scope && <span className="badge">scope: {skill.scope}</span>}
                                {skill.subcategory && <span className="badge">sub: {skill.subcategory}</span>}
                                {(skill.tags || []).slice(0, 3).map((tag) => (
                                  <span key={`${skill.skillId}-tag-${tag}`} className="badge">
                                    #{tag}
                                  </span>
                                ))}
                              </div>
                            )}
                            {skill.resources.length > 0 && (
                              <details className="skill-resources">
                                <summary>Resources ({skill.resources.length})</summary>
                                <ul>
                                  {skill.resources.map((resource) => (
                                    <li key={`${skill.skillId}-${resource.path}`}>
                                      <span className="resource-type">{resource.type}</span>
                                      <code>{resource.path}</code>
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            )}
                            <div className="skill-foot">
                              {skill.version && <span className="subtle">v{skill.version}</span>}
                              {skill.updatedAt && <span className="subtle">Updated {new Date(skill.updatedAt).toLocaleDateString()}</span>}
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </section>
          </main>
        </div>
      )}

      {activeTab === "hooks" && (
        <div className="workspace tab-section">
          <aside className="control-rail skills-rail">
            <section className="panel action-panel panel-spacious">
              <h2>Hook Actions</h2>
              <p className="subtle">Apply source-pinned hook selections across supported targets.</p>
              <p className="operation-hint hook-support-warning">Hooks are currently supported only for Claude Code and Gemini CLI.</p>
              <dl className="action-meta">
                <div>
                  <dt>Targets</dt>
                  <dd>{selectedHookTargetList.length}</dd>
                </div>
                <div>
                  <dt>Selection</dt>
                  <dd>{selectedKnownHookCount}</dd>
                </div>
                <div>
                  <dt>Scope</dt>
                  <dd>{scope === "project" ? "Project" : "User"}</dd>
                </div>
                <div>
                  <dt>Mode</dt>
                  <dd>{mode}</dd>
                </div>
              </dl>
              {scope === "project" && <p className="operation-hint">Project path: {trimmedProjectPath || "not set"}</p>}
              <div className="action-row">
                <button className="btn btn-primary" disabled={busy} onClick={() => runHookOperation("install")} type="button">
                  Install selected hooks
                </button>
                <button className="btn btn-secondary" disabled={busy} onClick={() => runHookOperation("uninstall")} type="button">
                  Uninstall selected hooks
                </button>
                <button className="btn btn-tertiary" disabled={busy} onClick={() => runHookOperation("sync")} type="button">
                  Sync hooks to selection
                </button>
              </div>
            </section>
          </aside>

          <main className="catalog-column">
            <section className="panel panel-catalog panel-spacious">
              <div className="catalog-head">
                <div>
                  <h2>Hook Catalog</h2>
                  <p className="subtle">
                    {totalHooks > 0 ? `${selectedKnownHookCount}/${totalHooks} selected` : `${selectedKnownHookCount} selected`}
                    {selectedUnknownHookCount > 0 ? ` • ${selectedUnknownHookCount} unavailable` : ""}
                    {normalizedHookQuery ? ` • ${filteredHooksCount} shown` : ""}
                  </p>
                </div>
                <div className="bulk-actions">
                  <button className="btn btn-ghost" onClick={() => setHooksSelection(hooks.map((hook) => hook.hookId), true)} type="button">
                    Select all
                  </button>
                  <button className="btn btn-ghost" onClick={() => setHooksSelection(hooks.map((hook) => hook.hookId), false)} type="button">
                    Clear all
                  </button>
                </div>
              </div>

              <div className="catalog-controls">
                <input
                  className="input input-search"
                  placeholder="Search source/hook, descriptions…"
                  value={hookSearchQuery}
                  onChange={(event) => setHookSearchQuery(event.target.value)}
                />
                <div className="catalog-filters">
                  <div className="source-filter">
                    <span className="filter-label">Source</span>
                    <div className="source-chip-row">
                      <button
                        className={`chip chip-filter ${hookSourceFilter === "all" ? "is-active" : ""}`}
                        type="button"
                        onClick={() => setHookSourceFilter("all")}
                      >
                        all
                      </button>
                      {hookSourceFilterOptions.map((sourceId) => (
                        <button
                          key={sourceId}
                          className={`chip chip-filter ${hookSourceFilter === sourceId ? "is-active" : ""}`}
                          type="button"
                          onClick={() => setHookSourceFilter(sourceId)}
                        >
                          {sourceNameById.get(sourceId) || sourceId}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="toggle">
                    <input type="checkbox" checked={hooksInstalledOnly} onChange={(event) => setHooksInstalledOnly(event.target.checked)} />
                    Installed only
                  </label>
                </div>
              </div>

              {visibleHooks.length === 0 && <div className="empty-state">No hooks match this search. Try a broader term.</div>}

              <div className="skill-grid">
                {visibleHooks.map((hook) => {
                  const isSelected = selectedHooks.has(hook.hookId);
                  const isInstalled = installedHookIds.has(hook.hookId);
                  return (
                    <article key={hook.hookId} className={`skill ${isSelected ? "selected" : ""}`}>
                      <div className="skill-top">
                        <label className="skill-title">
                          <input type="checkbox" checked={isSelected} onChange={() => toggleHook(hook.hookId)} />
                          <span className="skill-title-copy">
                            <strong>{hook.hookName}</strong>
                            <code className="skill-id">{hook.hookId}</code>
                          </span>
                        </label>
                        <div className="skill-badges">
                          <span className="badge badge-source">{sourceNameById.get(hook.sourceId) || hook.sourceId}</span>
                          {isInstalled && <span className="badge">installed</span>}
                        </div>
                      </div>
                      <p className="skill-description">{hook.description || "No description provided."}</p>
                      <div className="skill-foot">
                        {hook.version && <span className="subtle">v{hook.version}</span>}
                        {hook.updatedAt && <span className="subtle">Updated {new Date(hook.updatedAt).toLocaleDateString()}</span>}
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          </main>
        </div>
      )}

      {activeTab === "settings" && (
        <section className="settings-grid tab-section">
          <article className="panel panel-settings panel-spacious">
            <h2>Repository Management</h2>
            <p className="subtle">Attach repositories once; ICA syncs skills and hooks mirrors automatically.</p>
            <div className="subtle">{sources.length} configured</div>
            <div className="source-list">
              {sources.map((source) => (
                <article key={source.id} className="source-item">
                  <strong>{source.id}</strong>
                  <span>{source.repoUrl}</span>
                  <span>
                    roots: {source.skillsRoot || "(no /skills)"} / {source.hooksRoot || "(no /hooks)"}
                  </span>
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
            <span className="field-label">Source Name</span>
            <input
              className="input"
              placeholder="Source name (optional)"
              value={sourceName}
              onChange={(event) => setSourceName(event.target.value)}
            />
            <span className="field-label">Repository URL</span>
            <input
              className="input"
              placeholder="https://github.com/org/repo.git"
              value={sourceRepoUrl}
              onChange={(event) => setSourceRepoUrl(event.target.value)}
            />
            <div className="source-transport-group" role="radiogroup" aria-label="Source transport">
              <label className="source-transport-option">
                <input type="radio" checked={sourceTransport === "https"} onChange={() => setSourceTransport("https")} /> HTTPS
              </label>
              <label className="source-transport-option">
                <input type="radio" checked={sourceTransport === "ssh"} onChange={() => setSourceTransport("ssh")} /> SSH
              </label>
            </div>
            {sourceTransport === "https" && (
              <>
                <span className="field-label">PAT / API key</span>
                <input
                  className="input"
                  placeholder="PAT / API key (optional for public repos)"
                  value={sourceToken}
                  onChange={(event) => setSourceToken(event.target.value)}
                />
              </>
            )}
            <button className="btn btn-secondary" type="button" disabled={busy || !sourceRepoUrl.trim()} onClick={addSourceFromForm}>
              Add repository
            </button>
            <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => refreshSource()}>
              Refresh all repositories
            </button>
          </article>

          <article className="panel panel-settings panel-spacious">
            <h2>Installer Settings</h2>
            <p className="subtle">Tune targets, scope, and install mode for each operation.</p>
            <p className="subtle">Targets: {selectedTargetList.join(", ")}</p>
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

            <h2>Scope</h2>
            <div className="radio-pair-group" role="radiogroup" aria-label="Install scope">
              <label className="line radio-pair-option">
                <input type="radio" checked={scope === "user"} onChange={() => setScope("user")} /> User
              </label>
              <label className="line radio-pair-option">
                <input type="radio" checked={scope === "project"} onChange={() => setScope("project")} /> Project
              </label>
            </div>
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

            <h2>Install Mode</h2>
            <div className="radio-pair-group" role="radiogroup" aria-label="Install mode">
              <label className="line radio-pair-option">
                <input type="radio" checked={mode === "symlink"} onChange={() => setMode("symlink")} /> Symlink
              </label>
              <label className="line radio-pair-option">
                <input type="radio" checked={mode === "copy"} onChange={() => setMode("copy")} /> Full copy
              </label>
            </div>
          </article>
        </section>
      )}

      {activeTab === "state" && (
        <section className="state-grid tab-section">
          <article className="panel state-intro panel-spacious">
            <h2>States & Reports</h2>
            <p className="subtle">Inspect installed skill/hook state per target and review the latest operation payloads.</p>
          </article>

          <details className="panel collapsible panel-state panel-spacious" open>
            <summary>
              <span>Installed State</span>
              <span className="subtle">{installations.length} target entries</span>
            </summary>
            <pre>{JSON.stringify(installations, null, 2)}</pre>
          </details>

          <details className="panel collapsible panel-state panel-spacious" open>
            <summary>
              <span>Operation Report</span>
              <span className="subtle">{report ? "latest run available" : "no operation yet"}</span>
            </summary>
            <pre>{report ? JSON.stringify(report, null, 2) : "No operation run yet."}</pre>
          </details>

          <details className="panel collapsible panel-state panel-spacious" open>
            <summary>
              <span>Installed Hooks State</span>
              <span className="subtle">{hookInstallations.length} target entries</span>
            </summary>
            <pre>{JSON.stringify(hookInstallations, null, 2)}</pre>
          </details>

          <details className="panel collapsible panel-state panel-spacious" open>
            <summary>
              <span>Hook Operation Report</span>
              <span className="subtle">{hookReport ? "latest run available" : "no operation yet"}</span>
            </summary>
            <pre>{hookReport ? JSON.stringify(hookReport, null, 2) : "No hook operation run yet."}</pre>
          </details>
        </section>
      )}
    </div>
  );
}
