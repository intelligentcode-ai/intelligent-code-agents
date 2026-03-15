import React, { useEffect, useMemo, useState } from "react";
import {
  checkAppUpdate,
  controlPlaneFetch,
  downloadAppUpdate,
  openSettingsWindow,
  pickProjectDirectory,
  pickPublishDirectory,
  quitAndInstallAppUpdate,
} from "./control-plane-client";
import { DesktopAppearanceSettings } from "./DesktopAppearanceSettings";
import { desktopMainRoutes, getDesktopRouteDefinition, type DesktopRouteId, describeRealtimeStatus, summarizeRealtimeEvent } from "./desktop-shell";
import { useDashboardAppearance } from "./appearance";
import { startRealtimeClient, type RealtimeEvent, type RealtimeStatus } from "./realtime-client";
import {
  createNewSourceDraft,
  createSourcePublishDraft,
  type NewSourceDraft,
  type SourceProviderHint,
  type SourcePublishDraft,
  type SourcePublishMode,
  type SourceTransport,
} from "./source-management-state";
import type { DashboardWindowRole } from "./window-role";
import type { AppUpdateStatus } from "../../../installer-core/updateCheck";

type Target = "claude" | "codex" | "cursor" | "gemini" | "antigravity";

type Source = {
  id: string;
  name: string;
  repoUrl: string;
  transport: SourceTransport;
  official: boolean;
  enabled: boolean;
  skillsRoot: string;
  hooksRoot?: string;
  publishDefaultMode?: SourcePublishMode;
  defaultBaseBranch?: string;
  providerHint?: SourceProviderHint;
  officialContributionEnabled?: boolean;
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
  tags?: string[];
  resources: Array<{ type: string; path: string }>;
  sourcePath?: string;
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

type InstallationWorkflow = {
  name: string;
  skillId?: string;
  sourceId?: string;
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
  managedWorkflows?: InstallationWorkflow[];
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
  appliedWorkflows: string[];
  removedSkills: string[];
  removedWorkflows: string[];
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

type SkillValidationResult = {
  profile: "personal" | "official";
  errors: string[];
  warnings: string[];
  detectedFiles: string[];
};

type SkillPublishResult = {
  mode: "direct-push" | "branch-only" | "branch-pr";
  branch: string;
  commitSha: string;
  pushedRemote: string;
  prUrl?: string;
  compareUrl?: string;
};

type PublishMode = "direct-push" | "branch-only" | "branch-pr";
type DesktopUpdateTone = "neutral" | "busy" | "success" | "danger";

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

function titleCase(value: string): string {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

export function computeFilterSourceOptions<T extends { sourceId: string }>(
  entries: T[],
  selectedIds: Set<string>,
  resolveEntryId: (entry: T) => string,
): string[] {
  const allSourceIds = Array.from(new Set(entries.map((entry) => entry.sourceId))).sort((a, b) => a.localeCompare(b));
  if (allSourceIds.length === 0 || selectedIds.size === 0) {
    return allSourceIds;
  }

  const selectedSourceIds = new Set<string>();
  for (const entry of entries) {
    if (selectedIds.has(resolveEntryId(entry))) {
      selectedSourceIds.add(entry.sourceId);
    }
  }

  if (selectedSourceIds.size === 0) {
    return allSourceIds;
  }

  return Array.from(selectedSourceIds).sort((a, b) => a.localeCompare(b));
}

type SkillPublishCandidate = {
  skillId: string;
  skillName: string;
  sourceId: string;
  sourceName: string;
  localPath: string;
};

function toSkillPublishCandidate(skill: Skill): SkillPublishCandidate {
  return {
    skillId: skill.skillId,
    skillName: skill.skillName,
    sourceId: skill.sourceId,
    sourceName: skill.sourceName || skill.sourceId,
    localPath: skill.sourcePath!.trim(),
  };
}

export function listSkillPublishCandidates(skills: Skill[], selectedSkillIds: Set<string>): SkillPublishCandidate[] {
  const withLocalPath = skills.filter((skill) => typeof skill.sourcePath === "string" && skill.sourcePath.trim().length > 0);
  const selected = withLocalPath.filter((skill) => selectedSkillIds.has(skill.skillId));
  const pool = selected.length > 0 ? selected : withLocalPath;
  return pool
    .map((skill) => toSkillPublishCandidate(skill))
    .sort((a, b) => a.skillName.localeCompare(b.skillName) || a.sourceName.localeCompare(b.sourceName));
}

export interface InstallerDashboardProps {
  windowRole?: DashboardWindowRole;
}

export function InstallerDashboard({ windowRole = "main" }: InstallerDashboardProps): JSX.Element {
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
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>("disconnected");
  const [activityFeed, setActivityFeed] = useState<RealtimeEvent[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogLoadingMessage, setCatalogLoadingMessage] = useState("");
  const [catalogLoadingProgress, setCatalogLoadingProgress] = useState(0);
  const [selectionCustomized, setSelectionCustomized] = useState(false);
  const [sourcePublishDraft, setSourcePublishDraft] = useState<SourcePublishDraft>(() => createSourcePublishDraft());
  const [newSourceDraft, setNewSourceDraft] = useState<NewSourceDraft>(() => createNewSourceDraft());
  const [editingSourceId, setEditingSourceId] = useState("");
  const [skillPublishPath, setSkillPublishPath] = useState("");
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillPickerQuery, setSkillPickerQuery] = useState("");
  const [skillPublishName, setSkillPublishName] = useState("");
  const [skillPublishMessage, setSkillPublishMessage] = useState("");
  const [skillPublishOverrideMode, setSkillPublishOverrideMode] = useState<"source-default" | PublishMode>("source-default");
  const [skillPublishOverrideBaseBranch, setSkillPublishOverrideBaseBranch] = useState("");
  const [skillValidationProfile, setSkillValidationProfile] = useState<"personal" | "official">("personal");
  const [skillValidationResult, setSkillValidationResult] = useState<SkillValidationResult | null>(null);
  const [skillPublishResult, setSkillPublishResult] = useState<SkillPublishResult | null>(null);
  const [activeRoute, setActiveRoute] = useState<DesktopRouteId>("workspace");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [hookSourceFilter, setHookSourceFilter] = useState<string>("all");
  const [hooksInstalledOnly, setHooksInstalledOnly] = useState(false);
  const [hookSelectionCustomized, setHookSelectionCustomized] = useState(false);
  const [publishComposerOpen, setPublishComposerOpen] = useState(false);
  const [publishAdvancedOpen, setPublishAdvancedOpen] = useState(false);
  const [publishOriginSourceId, setPublishOriginSourceId] = useState<string | undefined>(undefined);
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const {
    mode: appearanceMode,
    accent: appearanceAccent,
    background: appearanceBackground,
    setMode: setAppearanceMode,
    setAccent: setAppearanceAccent,
    setBackground: setAppearanceBackground,
  } = useDashboardAppearance(windowRole);

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
  const selectedPublishSource = useMemo(
    () => sources.find((source) => source.id === editingSourceId) || null,
    [sources, editingSourceId],
  );

  function updateSourcePublishDraft(patch: Partial<SourcePublishDraft>): void {
    setSourcePublishDraft((current) => ({ ...current, ...patch }));
  }

  function updateNewSourceDraft(patch: Partial<NewSourceDraft>): void {
    setNewSourceDraft((current) => ({ ...current, ...patch }));
  }

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
    return Array.from(new Set(sources.filter((source) => source.enabled).map((source) => source.id))).sort((a, b) => a.localeCompare(b));
  }, [sources]);
  const hookSourceFilterOptions = useMemo(() => {
    return Array.from(new Set(sources.filter((source) => source.enabled).map((source) => source.id))).sort((a, b) => a.localeCompare(b));
  }, [sources]);
  const skillPublishCandidates = useMemo(() => listSkillPublishCandidates(skills, selectedSkills), [skills, selectedSkills]);
  const selectedSkillPublishCandidates = useMemo(() => {
    return skills
      .filter((skill) => selectedSkills.has(skill.skillId))
      .filter((skill) => typeof skill.sourcePath === "string" && skill.sourcePath.trim().length > 0)
      .map((skill) => toSkillPublishCandidate(skill))
      .sort((a, b) => a.skillName.localeCompare(b.skillName) || a.sourceName.localeCompare(b.sourceName));
  }, [skills, selectedSkills]);
  const publishBlockReason = useMemo(() => {
    if (!editingSourceId || !skillPublishPath.trim()) {
      return null;
    }
    return getOfficialPublishBlockReason(editingSourceId, skillPublishPath.trim(), publishOriginSourceId);
  }, [editingSourceId, skillPublishPath, publishOriginSourceId, sources, skills]);
  const normalizedSkillPickerQuery = skillPickerQuery.trim().toLowerCase();
  const visibleSkillPublishCandidates = useMemo(() => {
    if (!normalizedSkillPickerQuery) return skillPublishCandidates;
    return skillPublishCandidates.filter((candidate) => {
      const haystack = `${candidate.skillName} ${candidate.sourceName} ${candidate.localPath}`.toLowerCase();
      return haystack.includes(normalizedSkillPickerQuery);
    });
  }, [skillPublishCandidates, normalizedSkillPickerQuery]);

  const sourceScopedSkills = useMemo(() => {
    return skills.filter((skill) => {
      if (sourceFilter !== "all" && skill.sourceId !== sourceFilter) {
        return false;
      }
      if (installedOnly && !installedSkillIds.has(skill.skillId)) {
        return false;
      }
      return true;
    });
  }, [skills, sourceFilter, installedOnly, installedSkillIds]);

  const scopeFilterOptions = useMemo(() => {
    return Array.from(
      new Set(
        sourceScopedSkills
          .map((skill) => (skill.scope || "").trim().toLowerCase())
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b));
  }, [sourceScopedSkills]);

  const categoryFilterOptions = useMemo(() => {
    return Array.from(
      new Set(
        sourceScopedSkills
          .map((skill) => (skill.category || "").trim().toLowerCase())
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b));
  }, [sourceScopedSkills]);

  const tagFilterOptions = useMemo(() => {
    const tags: string[] = [];
    for (const skill of sourceScopedSkills) {
      for (const tag of skill.tags || []) {
        const normalized = tag.trim().toLowerCase();
        if (normalized) tags.push(normalized);
      }
    }
    return Array.from(new Set(tags)).sort((a, b) => a.localeCompare(b));
  }, [sourceScopedSkills]);

  const visibleSkills = useMemo(() => {
    return sourceScopedSkills.filter((skill) => {
      const skillScope = (skill.scope || "").trim().toLowerCase();
      const skillCategory = (skill.category || "").trim().toLowerCase();
      const skillTags = (skill.tags || []).map((tag) => tag.trim().toLowerCase()).filter(Boolean);

      if (scopeFilter !== "all" && skillScope !== scopeFilter) {
        return false;
      }
      if (categoryFilter !== "all" && skillCategory !== categoryFilter) {
        return false;
      }
      if (tagFilter !== "all" && !skillTags.includes(tagFilter)) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }
      const resourceText = skill.resources.map((item) => `${item.type} ${item.path}`).join(" ");
      const tagsText = skillTags.join(" ");
      const haystack = `${skill.skillId} ${skill.description} ${skill.category} ${skill.scope || ""} ${tagsText} ${resourceText}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [sourceScopedSkills, scopeFilter, categoryFilter, tagFilter, normalizedQuery]);

  const selectedVisibleSkillPublishCandidates = useMemo(() => {
    return visibleSkills
      .filter((skill) => selectedSkills.has(skill.skillId))
      .filter((skill) => typeof skill.sourcePath === "string" && skill.sourcePath.trim().length > 0)
      .map((skill) => toSkillPublishCandidate(skill))
      .sort((a, b) => a.skillName.localeCompare(b.skillName) || a.sourceName.localeCompare(b.sourceName));
  }, [visibleSkills, selectedSkills]);
  const quickPublishCandidate = selectedVisibleSkillPublishCandidates.length === 1 ? selectedVisibleSkillPublishCandidates[0] : null;

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
    const res = await controlPlaneFetch("/api/v1/sources");
    const payload = (await res.json()) as { sources?: Source[]; error?: string };
    if (!res.ok) {
      throw new Error(asErrorMessage(payload, "Failed to load sources."));
    }
    setSources(Array.isArray(payload.sources) ? payload.sources : []);
  }

  async function refreshSources(runRefresh = false): Promise<void> {
    if (runRefresh) {
      await controlPlaneFetch("/api/v1/sources/refresh-all", {
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
      const res = await controlPlaneFetch("/api/v1/catalog/skills");
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
    const res = await controlPlaneFetch("/api/v1/catalog/hooks");
    const payload = (await res.json()) as { hooks?: Hook[]; error?: string };
    if (!res.ok) {
      throw new Error(asErrorMessage(payload, "Failed to load hooks catalog."));
    }
    setHooks(Array.isArray(payload.hooks) ? payload.hooks : []);
  }

  async function fetchDiscoveredTargets(): Promise<void> {
    const res = await controlPlaneFetch("/api/v1/targets/discovered");
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

    const res = await controlPlaneFetch(`/api/v1/installations?${query.toString()}`);
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

    const res = await controlPlaneFetch(`/api/v1/hooks/installations?${query.toString()}`);
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

      const res = await controlPlaneFetch(`/api/v1/${operation}/apply`, {
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

      const res = await controlPlaneFetch(`/api/v1/hooks/${operation}/apply`, {
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
      const res = await controlPlaneFetch("/api/v1/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newSourceDraft.name.trim() || undefined,
          repoUrl: newSourceDraft.repoUrl.trim(),
          transport: newSourceDraft.transport,
          publishDefaultMode: newSourceDraft.publishDefaultMode,
          defaultBaseBranch: newSourceDraft.defaultBaseBranch.trim() || undefined,
          providerHint: newSourceDraft.providerHint,
          officialContributionEnabled: newSourceDraft.officialContributionEnabled,
          token: newSourceDraft.token.trim() || undefined,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(asErrorMessage(payload, "Failed to add source."));
      }
      setNewSourceDraft(createNewSourceDraft());
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
      const res = await controlPlaneFetch(endpoint, {
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
      const res = await controlPlaneFetch(`/api/v1/sources/${source.id}`, { method: "DELETE" });
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

  async function saveSourcePublishSettings(): Promise<void> {
    if (!editingSourceId) {
      setError("Select a source to update.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await controlPlaneFetch(`/api/v1/sources/${editingSourceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publishDefaultMode: sourcePublishDraft.publishDefaultMode,
          defaultBaseBranch: sourcePublishDraft.defaultBaseBranch.trim() || undefined,
          providerHint: sourcePublishDraft.providerHint,
          officialContributionEnabled: sourcePublishDraft.officialContributionEnabled,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(asErrorMessage(payload, "Failed to update source publish settings."));
      }
      await fetchSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function normalizeLocalPath(value: string): string {
    return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function resolveSkillForPath(localPath: string): Skill | undefined {
    const normalized = normalizeLocalPath(localPath);
    return skills.find((skill) => normalizeLocalPath(skill.sourcePath || "") === normalized);
  }

  function isOfficialSkillBundle(localPath: string, originSourceId?: string): boolean {
    const normalized = normalizeLocalPath(localPath);
    const originSource = originSourceId ? sources.find((source) => source.id === originSourceId) : undefined;
    if (originSource?.official) {
      return true;
    }

    const matchedSkill = resolveSkillForPath(normalized);
    if (matchedSkill) {
      const matchedSource = sources.find((source) => source.id === matchedSkill.sourceId);
      if (matchedSource?.official) {
        return true;
      }
    }

    return normalized.includes("/official-skills/");
  }

  function getOfficialPublishBlockReason(sourceId: string, localPath: string, originSourceId?: string): string | null {
    const targetSource = sources.find((source) => source.id === sourceId);
    if (!targetSource) {
      return "Select a valid target source first.";
    }
    if (targetSource.official) {
      return null;
    }
    if (isOfficialSkillBundle(localPath, originSourceId)) {
      return "Official skills can only be published to official sources.";
    }
    return null;
  }

  function preparePublishOverlay(params: { localPath: string; skillName?: string; originSourceId?: string }): void {
    setSkillPublishPath(params.localPath.trim());
    if (params.skillName) {
      setSkillPublishName(params.skillName);
    }
    setPublishOriginSourceId(params.originSourceId);
    setPublishComposerOpen(true);
    setPublishAdvancedOpen(false);
  }

  async function runSkillValidation(): Promise<void> {
    if (!skillPublishPath.trim()) {
      setError("Set a local skill path first.");
      return;
    }
    setBusy(true);
    setError("");
    setSkillValidationResult(null);
    try {
      const res = await controlPlaneFetch("/api/v1/skills/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: skillPublishPath.trim(),
          skillName: skillPublishName.trim() || undefined,
          profile: skillValidationProfile,
        }),
      });
      const payload = (await res.json()) as { validation?: SkillValidationResult; error?: string };
      if (!res.ok) {
        throw new Error(asErrorMessage(payload, "Skill validation failed."));
      }
      if (payload.validation) {
        setSkillValidationResult(payload.validation);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function publishSkillBundleRequest(params: {
    sourceId: string;
    path: string;
    originSourceId?: string;
    skillName?: string;
    message?: string;
    overrideMode?: PublishMode;
    overrideBaseBranch?: string;
  }): Promise<void> {
    const blockReason = getOfficialPublishBlockReason(params.sourceId, params.path, params.originSourceId);
    if (blockReason) {
      throw new Error(blockReason);
    }

    const res = await controlPlaneFetch("/api/v1/skills/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceId: params.sourceId,
        path: params.path,
        skillName: params.skillName,
        message: params.message,
        overrideMode: params.overrideMode,
        overrideBaseBranch: params.overrideBaseBranch,
      }),
    });
    const payload = (await res.json()) as { result?: SkillPublishResult; error?: string };
    if (!res.ok) {
      throw new Error(asErrorMessage(payload, "Skill publish failed."));
    }
    if (payload.result) {
      setSkillPublishResult(payload.result);
    }
    await fetchSources();
    await fetchSkills();
    setPublishComposerOpen(false);
    setPublishAdvancedOpen(false);
  }

  async function runSkillPublish(): Promise<void> {
    if (!editingSourceId) {
      setError("Select a source for publishing.");
      return;
    }
    if (!skillPublishPath.trim()) {
      setError("Set a local skill path first.");
      return;
    }
    setBusy(true);
    setError("");
    setSkillPublishResult(null);
    try {
      await publishSkillBundleRequest({
        sourceId: editingSourceId,
        path: skillPublishPath.trim(),
        originSourceId: publishOriginSourceId,
        skillName: skillPublishName.trim() || undefined,
        message: skillPublishMessage.trim() || undefined,
        overrideMode: skillPublishOverrideMode !== "source-default" ? skillPublishOverrideMode : undefined,
        overrideBaseBranch: skillPublishOverrideBaseBranch.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runQuickPublishFromCatalogSelection(): Promise<void> {
    if (selectedVisibleSkillPublishCandidates.length === 0) {
      setError("Select one visible local catalog skill first.");
      return;
    }
    if (selectedVisibleSkillPublishCandidates.length > 1) {
      setError("Select exactly one visible local catalog skill to quick publish.");
      return;
    }

    const candidate = selectedVisibleSkillPublishCandidates[0];
    setError("");
    setSkillPublishResult(null);
    preparePublishOverlay({
      localPath: candidate.localPath,
      skillName: candidate.skillName,
      originSourceId: candidate.sourceId,
    });
  }

  async function runPickFolderAndPublish(): Promise<void> {
    setBusy(true);
    setError("");
    setSkillPublishResult(null);
    try {
      const pickedPath = (await pickPublishDirectory(skillPublishPath.trim() || undefined)).path?.trim();
      if (!pickedPath) {
        return;
      }
      const pickedSkill = resolveSkillForPath(pickedPath);
      preparePublishOverlay({
        localPath: pickedPath,
        skillName: pickedSkill?.skillName || skillPublishName.trim() || undefined,
        originSourceId: pickedSkill?.sourceId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runOfficialContribution(): Promise<void> {
    if (!skillPublishPath.trim()) {
      setError("Set a local skill path first.");
      return;
    }
    setBusy(true);
    setError("");
    setSkillPublishResult(null);
    try {
      const res = await controlPlaneFetch("/api/v1/skills/contribute-official", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId: editingSourceId || undefined,
          path: skillPublishPath.trim(),
          skillName: skillPublishName.trim() || undefined,
          message: skillPublishMessage.trim() || undefined,
        }),
      });
      const payload = (await res.json()) as { result?: SkillPublishResult; error?: string };
      if (!res.ok) {
        throw new Error(asErrorMessage(payload, "Official contribution failed."));
      }
      if (payload.result) {
        setSkillPublishResult(payload.result);
      }
      await fetchSources();
      await fetchSkills();
      setPublishComposerOpen(false);
      setPublishAdvancedOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function pickSkillPublishPath(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const pickedPath = (await pickPublishDirectory(skillPublishPath.trim() || undefined)).path?.trim();
      if (pickedPath) {
        setSkillPublishPath(pickedPath);
        const matched = resolveSkillForPath(pickedPath);
        setPublishOriginSourceId(matched?.sourceId);
        if (matched?.skillName) {
          setSkillPublishName(matched.skillName);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function applySkillPublishCandidate(candidate: SkillPublishCandidate): void {
    setError("");
    setSkillPublishPath(candidate.localPath);
    setSkillPublishName(candidate.skillName);
    setPublishOriginSourceId(candidate.sourceId);
    setSkillPickerOpen(false);
  }

  async function pickProjectPath(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const payload = await pickProjectDirectory(trimmedProjectPath || undefined);
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
      const res = await controlPlaneFetch("/api/v1/container/mount-project", {
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

  async function refreshAppUpdate(force = false): Promise<void> {
    try {
      const next = await checkAppUpdate(force);
      setAppUpdate(next);
    } catch (err) {
      setAppUpdate((current) =>
        current || {
          currentVersion: "unknown",
          checkedAt: new Date().toISOString(),
          updateAvailable: false,
          channel: "stable",
          runtime: "desktop-preview",
          canAutoApply: false,
          downloaded: false,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  async function handleDownloadAppUpdate(): Promise<void> {
    setAppUpdateBusy(true);
    setError("");
    try {
      const next = await downloadAppUpdate();
      setAppUpdate(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAppUpdateBusy(false);
    }
  }

  async function handleQuitAndInstallAppUpdate(): Promise<void> {
    setAppUpdateBusy(true);
    setError("");
    try {
      const result = await quitAndInstallAppUpdate();
      if (!result.accepted) {
        throw new Error("Desktop update is not ready to install yet.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAppUpdateBusy(false);
    }
  }

  async function handleOpenSettingsWindow(): Promise<void> {
    setError("");
    try {
      await openSettingsWindow();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    fetchDiscoveredTargets().catch((err) => setError(err instanceof Error ? err.message : String(err)));
    fetchSources()
      .then(async () => {
        await fetchSkills(true);
        await fetchHooks();
        await refreshAppUpdate(true);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (windowRole !== "main") {
      return;
    }

    const stopRealtime = startRealtimeClient({
      onStatusChange: setRealtimeStatus,
      onEvent(event) {
        setActivityFeed((current) => [event, ...current].slice(0, 8));
      },
    });

    return () => {
      stopRealtime();
    };
  }, [windowRole]);

  useEffect(() => {
    if (sources.length === 0) {
      setEditingSourceId("");
      return;
    }
    if (!editingSourceId || !sources.some((source) => source.id === editingSourceId)) {
      setEditingSourceId(sources[0].id);
    }
  }, [sources, editingSourceId]);

  useEffect(() => {
    if (!editingSourceId) return;
    const selected = sources.find((source) => source.id === editingSourceId);
    if (!selected) return;
    setSourcePublishDraft(createSourcePublishDraft(selected));
  }, [editingSourceId, sources]);

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
    if (scopeFilter === "all") return;
    if (!scopeFilterOptions.includes(scopeFilter)) {
      setScopeFilter("all");
    }
  }, [scopeFilter, scopeFilterOptions]);

  useEffect(() => {
    if (categoryFilter === "all") return;
    if (!categoryFilterOptions.includes(categoryFilter)) {
      setCategoryFilter("all");
    }
  }, [categoryFilter, categoryFilterOptions]);

  useEffect(() => {
    if (tagFilter === "all") return;
    if (!tagFilterOptions.includes(tagFilter)) {
      setTagFilter("all");
    }
  }, [tagFilter, tagFilterOptions]);

  useEffect(() => {
    if (hookSourceFilter === "all") return;
    if (!hookSourceFilterOptions.includes(hookSourceFilter)) {
      setHookSourceFilter("all");
    }
  }, [hookSourceFilter, hookSourceFilterOptions]);

  useEffect(() => {
    if (!skillPickerOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setSkillPickerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [skillPickerOpen]);

  useEffect(() => {
    if (!publishComposerOpen && !publishAdvancedOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setPublishComposerOpen(false);
        setPublishAdvancedOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [publishComposerOpen, publishAdvancedOpen]);

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
  const connectionSummary = useMemo(
    () =>
      describeRealtimeStatus(realtimeStatus, {
        busy,
        catalogLoading,
        error,
        hasProjectPath: Boolean(trimmedProjectPath),
      }),
    [realtimeStatus, busy, catalogLoading, error, trimmedProjectPath],
  );
  const operationSummary = useMemo(() => {
    if (busy) {
      return {
        title: "Applying desktop action",
        detail: scope === "project" && trimmedProjectPath ? `Working against ${trimmedProjectPath}.` : "Running against the active user scope.",
      };
    }

    if (catalogLoading) {
      return {
        title: "Refreshing catalog",
        detail: catalogLoadingMessage || "Loading sources, skills, and hooks into the desktop shell.",
      };
    }

    const latestOperation = hookReport || report;
    if (latestOperation) {
      const targetCount = Array.isArray(latestOperation.targets) ? latestOperation.targets.length : 0;
      return {
        title: "Latest run captured",
        detail: `${targetCount} target${targetCount === 1 ? "" : "s"} updated in the latest shell report.`,
      };
    }

    return {
      title: "Ready for the next desktop action",
      detail: "Choose a target set, then run install, sync, publish, or native project actions from this shell.",
    };
  }, [busy, scope, trimmedProjectPath, catalogLoading, catalogLoadingMessage, hookReport, report]);
  const activityFeedItems = useMemo(
    () =>
      activityFeed.map((event) => ({
        id: event.id,
        title: summarizeRealtimeEvent(event),
        timestamp: new Date(event.ts).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        tone: event.type.endsWith("failed") ? "is-danger" : event.type.endsWith("started") ? "is-busy" : "is-neutral",
      })),
    [activityFeed],
  );
  const updateSummary = useMemo((): { badge: string; title: string; detail: string; tone: DesktopUpdateTone } => {
    if (appUpdateBusy) {
      return {
        badge: "Working",
        title: "Processing desktop update",
        detail: "Downloading or installing the staged desktop release.",
        tone: "busy",
      };
    }
    if (!appUpdate) {
      return {
        badge: "Unknown",
        title: "Desktop update status unavailable",
        detail: "Run a manual check to load release state for this workspace.",
        tone: "neutral",
      };
    }
    if (appUpdate.error) {
      return {
        badge: "Issue",
        title: "Desktop updates need attention",
        detail: appUpdate.error,
        tone: "danger",
      };
    }
    if (appUpdate.downloaded) {
      return {
        badge: "Ready",
        title: `ICA ${appUpdate.latestVersion || appUpdate.currentVersion} is ready to install`,
        detail: "Quit and install will restart the packaged desktop app into the downloaded release.",
        tone: "success",
      };
    }
    if (appUpdate.updateAvailable) {
      return {
        badge: "Update",
        title: `ICA ${appUpdate.latestVersion || "next"} is available`,
        detail: appUpdate.canAutoApply
          ? "Download the packaged desktop update now, then restart into the staged release."
          : "A newer release exists, but this runtime can only open the release manually.",
        tone: "busy",
      };
    }
    return {
      badge: "Current",
      title: `ICA ${appUpdate.currentVersion} is up to date`,
      detail: "No newer stable desktop release is waiting on the selected channel.",
      tone: "neutral",
    };
  }, [appUpdate, appUpdateBusy]);
  const activeRouteDefinition = getDesktopRouteDefinition(activeRoute);

  if (windowRole === "settings") {
    return (
      <div className="shell settings-window-shell">
        <header className="desktop-shell-header settings-window-header">
          <div className="desktop-shell-header-bar">
            <div className="desktop-shell-header-copyblock">
              <p className="eyebrow">ICA DESKTOP SETTINGS</p>
              <h1>Settings</h1>
              <p className="desktop-shell-header-copy">
                Keep appearance and installer defaults in a dedicated Settings window while repository workflows live in the Sources route.
              </p>
            </div>
            <div className="desktop-shell-header-meta" aria-label="Desktop settings summary">
              <span>{sources.length} sources</span>
              <span>{selectedTargetList.length} active targets</span>
              <span>{scope === "project" ? "Project scope" : "User scope"}</span>
            </div>
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

        <section className="settings-grid tab-section" aria-label="Desktop settings window">
          <DesktopAppearanceSettings
            mode={appearanceMode}
            accent={appearanceAccent}
            background={appearanceBackground}
            onModeChange={setAppearanceMode}
            onAccentChange={setAppearanceAccent}
            onBackgroundChange={setAppearanceBackground}
          />

          <article className="panel panel-settings panel-spacious">
            <h2>Installer Settings</h2>
            <p className="subtle">Tune targets, scope, and install mode without mixing these desktop defaults into the main workspace tabs.</p>
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
      </div>
    );
  }

  return (
    <div className="shell desktop-shell-frame">
      <header className="desktop-shell-header">
        <div className="desktop-shell-header-bar">
          <div className="desktop-shell-header-copyblock">
            <p className="eyebrow">ICA DESKTOP WORKSPACE</p>
            <h1>Installer Workspace</h1>
            <p className="desktop-shell-header-copy">
              Keep source and installation operations in a persistent desktop shell instead of a dashboard landing page.
            </p>
          </div>
          <div className="desktop-shell-header-meta" aria-label="Desktop workspace summary">
            <span>{sources.length} sources</span>
            <span>{installedSkillCount} skills installed</span>
            <span>{installedHookCount} hooks installed</span>
          </div>
        </div>
      </header>

      <div className="desktop-shell-workspace">
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

        <div className="desktop-route-shell">
          <aside className="desktop-route-sidebar">
            <section className="panel desktop-route-sidebar-panel panel-spacious">
              <p className="desktop-shell-kicker">Desktop routes</p>
              <div className="desktop-route-sidebar-copy">
                <strong>{activeRouteDefinition.label}</strong>
                <p className="subtle">{activeRouteDefinition.description}</p>
              </div>
              <nav className="desktop-route-nav" aria-label="Desktop routes">
                {desktopMainRoutes.map((route) => (
                  <button
                    key={route.id}
                    className={`desktop-route-link ${activeRoute === route.id ? "is-active" : ""}`}
                    type="button"
                    aria-current={activeRoute === route.id ? "page" : undefined}
                    onClick={() => setActiveRoute(route.id)}
                  >
                    <span className="desktop-route-link-eyebrow">{route.eyebrow}</span>
                    <strong>{route.label}</strong>
                    <span>{route.description}</span>
                  </button>
                ))}
              </nav>
            </section>

            <section className="panel desktop-route-sidebar-panel panel-spacious">
              <h2>Settings boundary</h2>
              <p className="subtle">
                Preferences, theme controls, and installer defaults stay in the dedicated Settings window for this slice.
              </p>
              <div className="action-row">
                <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void handleOpenSettingsWindow()}>
                  Open Settings
                </button>
                <button className="btn btn-ghost" type="button" disabled={busy || appUpdateBusy} onClick={() => void refreshAppUpdate(true)}>
                  Check desktop update
                </button>
              </div>
            </section>
          </aside>

          <main className="desktop-route-content">
            <section className="panel desktop-route-hero panel-spacious">
              <p className="desktop-shell-kicker">{activeRouteDefinition.eyebrow}</p>
              <h2>{activeRouteDefinition.title}</h2>
              <p className="subtle">{activeRouteDefinition.description}</p>
            </section>

            {activeRoute === "workspace" && (
              <>
                <section className="desktop-shell-grid" aria-label="Desktop workspace shell">
                  <article className="panel desktop-shell-card desktop-shell-card-operation panel-spacious">
                    <div className="desktop-shell-heading">
                      <div>
                        <p className="desktop-shell-kicker">Workspace</p>
                        <h2>Operation Center</h2>
                      </div>
                      <span className={`desktop-shell-pill ${busy || catalogLoading ? "is-busy" : "is-neutral"}`}>
                        {busy ? "Running" : catalogLoading ? "Loading" : "Ready"}
                      </span>
                    </div>
                    <p className="desktop-shell-title">{operationSummary.title}</p>
                    <p className="desktop-shell-copy">{operationSummary.detail}</p>
                    <dl className="desktop-shell-metrics">
                      <div>
                        <dt>Targets</dt>
                        <dd>{selectedTargetList.length}</dd>
                      </div>
                      <div>
                        <dt>Scope</dt>
                        <dd>{scope === "project" ? "Project" : "User"}</dd>
                      </div>
                      <div>
                        <dt>Selection</dt>
                        <dd>{selectedKnownSkillCount}</dd>
                      </div>
                    </dl>
                  </article>

                  <article className="panel desktop-shell-card panel-spacious">
                    <div className="desktop-shell-heading">
                      <div>
                        <p className="desktop-shell-kicker">Connectivity</p>
                        <h2>Connection Status</h2>
                      </div>
                      <span className={`desktop-shell-pill is-${connectionSummary.tone}`}>{connectionSummary.badge}</span>
                    </div>
                    <p className="desktop-shell-title">{connectionSummary.title}</p>
                    <p className="desktop-shell-copy">{connectionSummary.detail}</p>
                  </article>

                  <article className="panel desktop-shell-card panel-spacious">
                    <div className="desktop-shell-heading">
                      <div>
                        <p className="desktop-shell-kicker">Native flow</p>
                        <h2>Native Operations</h2>
                      </div>
                    </div>
                    <p className="desktop-shell-copy">
                      Bring desktop-only actions forward so project selection, repository refresh, and publish flows stay one click away.
                    </p>
                    <div className="desktop-shell-actions">
                      <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void pickProjectPath()}>
                        Pick project (native)
                      </button>
                      <button className="btn btn-secondary" type="button" disabled={busy || !trimmedProjectPath} onClick={() => void mountProjectInContainer()}>
                        Mount in container
                      </button>
                      <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void runPickFolderAndPublish()}>
                        Pick & Publish
                      </button>
                      <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void handleOpenSettingsWindow()}>
                        Open Settings
                      </button>
                    </div>
                  </article>

                  <article className="panel desktop-shell-card panel-spacious">
                    <div className="desktop-shell-heading">
                      <div>
                        <p className="desktop-shell-kicker">Release</p>
                        <h2>Update Center</h2>
                      </div>
                      <span className={`desktop-shell-pill is-${updateSummary.tone}`}>{updateSummary.badge}</span>
                    </div>
                    <p className="desktop-shell-title">{updateSummary.title}</p>
                    <p className="desktop-shell-copy">{updateSummary.detail}</p>
                    <div className="desktop-shell-actions">
                      <button className="btn btn-secondary" type="button" disabled={busy || appUpdateBusy} onClick={() => void refreshAppUpdate(true)}>
                        Check now
                      </button>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        disabled={busy || appUpdateBusy || !appUpdate?.updateAvailable || !appUpdate.canAutoApply || Boolean(appUpdate.downloaded)}
                        onClick={() => void handleDownloadAppUpdate()}
                      >
                        Download update
                      </button>
                      <button
                        className="btn btn-ghost"
                        type="button"
                        disabled={busy || appUpdateBusy || !appUpdate?.downloaded}
                        onClick={() => void handleQuitAndInstallAppUpdate()}
                      >
                        Quit & Install
                      </button>
                    </div>
                  </article>

                  <article className="panel desktop-shell-card desktop-shell-card-activity panel-spacious">
                    <div className="desktop-shell-heading">
                      <div>
                        <p className="desktop-shell-kicker">Realtime</p>
                        <h2>Activity Feed</h2>
                      </div>
                    </div>
                    {activityFeedItems.length === 0 ? (
                      <p className="desktop-shell-copy">
                        Desktop shell activity will appear here once a bridge event, refresh, or operation lifecycle update arrives.
                      </p>
                    ) : (
                      <ol className="desktop-activity-list">
                        {activityFeedItems.map((item) => (
                          <li key={item.id} className={`desktop-activity-item ${item.tone}`}>
                            <div>
                              <strong>{item.title}</strong>
                              <span>{item.timestamp}</span>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </article>
                </section>

                <div className="workspace desktop-route-section">
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

                    <section className="panel panel-publish panel-spacious">
                      <div className="publish-head">
                        <div>
                          <h2>Skill Publishing</h2>
                          <p className="subtle">Quick publish from selected skills or picked folders. Target and advanced settings appear only in overlays.</p>
                        </div>
                        <span className="publish-chip">{skillPublishCandidates.length} local bundles</span>
                      </div>

                      <div className="publish-quick-actions">
                        <button className="btn btn-primary" type="button" disabled={busy || !quickPublishCandidate} onClick={runQuickPublishFromCatalogSelection}>
                          Publish
                        </button>
                        <button className="btn btn-secondary" type="button" disabled={busy} onClick={runPickFolderAndPublish}>
                          Pick & Publish
                        </button>
                      </div>
                      <p className="publish-quick-hint subtle">
                        {selectedVisibleSkillPublishCandidates.length === 0 &&
                          "Select one visible local catalog skill, then publish it in one click."}
                        {selectedVisibleSkillPublishCandidates.length === 1 &&
                          `Ready to publish "${selectedVisibleSkillPublishCandidates[0].skillName}" from selected catalog skill.`}
                        {selectedVisibleSkillPublishCandidates.length > 1 &&
                          "Multiple visible local catalog skills are selected. Keep one selected to enable one-click publish."}
                      </p>

                      {selectedPublishSource && (
                        <p className="publish-hint">
                          Last target: <code>{selectedPublishSource.name || selectedPublishSource.id}</code> • flow{" "}
                          <code>{selectedPublishSource.publishDefaultMode || "branch-pr"}</code>.
                        </p>
                      )}

                      {skillValidationResult && (
                        <details className="collapsible" open>
                          <summary>Validation Result ({skillValidationResult.profile})</summary>
                          <pre>{JSON.stringify(skillValidationResult, null, 2)}</pre>
                        </details>
                      )}
                      {skillPublishResult && (
                        <details className="collapsible" open>
                          <summary>Publish Result</summary>
                          <pre>{JSON.stringify(skillPublishResult, null, 2)}</pre>
                        </details>
                      )}
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
                          placeholder="Search source/skill, descriptions, resources…"
                          value={searchQuery}
                          onChange={(event) => setSearchQuery(event.target.value)}
                        />
                        <div className="catalog-filters">
                          <div className="source-filter">
                            <span className="filter-label">Source</span>
                            <div className="source-chip-row">
                              <button className={`chip chip-filter ${sourceFilter === "all" ? "is-active" : ""}`} type="button" onClick={() => setSourceFilter("all")}>
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
                              {scopeFilterOptions.map((scopeValue) => (
                                <button
                                  key={scopeValue}
                                  className={`chip chip-filter ${scopeFilter === scopeValue ? "is-active" : ""}`}
                                  type="button"
                                  onClick={() => setScopeFilter(scopeValue)}
                                >
                                  {titleCase(scopeValue)}
                                </button>
                              ))}
                            </div>
                          </div>
                          <div className="source-filter">
                            <span className="filter-label">Category</span>
                            <div className="source-chip-row">
                              <button className={`chip chip-filter ${categoryFilter === "all" ? "is-active" : ""}`} type="button" onClick={() => setCategoryFilter("all")}>
                                all
                              </button>
                              {categoryFilterOptions.map((categoryValue) => (
                                <button
                                  key={categoryValue}
                                  className={`chip chip-filter ${categoryFilter === categoryValue ? "is-active" : ""}`}
                                  type="button"
                                  onClick={() => setCategoryFilter(categoryValue)}
                                >
                                  {titleCase(categoryValue)}
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
                              {tagFilterOptions.map((tagValue) => (
                                <button
                                  key={tagValue}
                                  className={`chip chip-filter ${tagFilter === tagValue ? "is-active" : ""}`}
                                  type="button"
                                  onClick={() => setTagFilter(tagValue)}
                                >
                                  {tagValue}
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
                                        {skill.scope && <span className="badge">{titleCase(skill.scope)}</span>}
                                        {(skill.tags || []).slice(0, 2).map((tag) => (
                                          <span key={`${skill.skillId}-tag-${tag}`} className="badge">
                                            #{tag}
                                          </span>
                                        ))}
                                        {isInstalled && <span className="badge">installed</span>}
                                      </div>
                                    </div>
                                    <p className="skill-description">{skill.description}</p>
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
              </>
            )}

            {activeRoute === "sources" && (
              <section className="desktop-route-section source-route-grid">
                <article className="panel panel-spacious">
                  <h2>Connected repositories</h2>
                  <p className="subtle">Manage repository connections, refresh cadence, and source defaults directly from this route.</p>
                  <dl className="action-meta">
                    <div>
                      <dt>Configured</dt>
                      <dd>{sources.length}</dd>
                    </div>
                    <div>
                      <dt>Enabled</dt>
                      <dd>{sources.filter((source) => source.enabled).length}</dd>
                    </div>
                    <div>
                      <dt>Targets</dt>
                      <dd>{selectedTargetList.join(", ")}</dd>
                    </div>
                    <div>
                      <dt>Mode</dt>
                      <dd>{scope === "project" ? `${mode} / project` : `${mode} / user`}</dd>
                    </div>
                  </dl>
                  {scope === "project" && <p className="operation-hint">Project path: {trimmedProjectPath || "not set"}</p>}
                  <div className="action-row">
                    <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => refreshSource()}>
                      Refresh all repositories
                    </button>
                    <button className="btn btn-ghost" type="button" disabled={busy || sources.length === 0} onClick={() => setEditingSourceId(sources[0]?.id || "")}>
                      Focus first source
                    </button>
                  </div>
                </article>

                <article className="panel panel-spacious">
                  <div className="catalog-head">
                    <div>
                      <h2>Repository Management</h2>
                      <p className="subtle">
                        {sources.length === 0 ? "No repositories are configured yet." : `${sources.length} repositories connected to this desktop workspace.`}
                      </p>
                    </div>
                  </div>

                  {sources.length === 0 ? (
                    <div className="empty-state">Add your first repository below to start syncing skills and hooks into this desktop workspace.</div>
                  ) : (
                    <div className="source-list">
                      {sources.map((source) => (
                        <article key={source.id} className="source-item">
                          <strong>{source.name || source.id}</strong>
                          <span>{source.repoUrl}</span>
                          <span>
                            roots: {source.skillsRoot || "(no /skills)"} / {source.hooksRoot || "(no /hooks)"}
                          </span>
                          <span>
                            publish: {source.publishDefaultMode || "branch-pr"} / base {source.defaultBaseBranch || "main"} / provider {source.providerHint || "unknown"}
                          </span>
                          <span>{source.lastSyncAt ? `synced ${new Date(source.lastSyncAt).toLocaleString()}` : "never synced"}</span>
                          {source.lastError && <span className="source-error">{source.lastError}</span>}
                          <div className="source-actions">
                            <button className="btn btn-inline" type="button" disabled={busy} onClick={() => setEditingSourceId(source.id)}>
                              Select
                            </button>
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
                  )}
                </article>

                <article className="panel panel-spacious">
                  <h2>Source Publish Settings</h2>
                  <p className="subtle">Choose the repository-specific publish defaults that drive quick publish and contribution flows.</p>
                  {sources.length === 0 ? (
                    <div className="empty-state">Create a repository source first to unlock publish defaults.</div>
                  ) : (
                    <>
                      <span className="field-label">Selected Source</span>
                      <select className="input" value={editingSourceId} onChange={(event) => setEditingSourceId(event.target.value)}>
                        {sources.map((source) => (
                          <option key={source.id} value={source.id}>
                            {source.name || source.id}
                          </option>
                        ))}
                      </select>
                      <span className="field-label">Default Publish Mode</span>
                      <select
                        className="input"
                        value={sourcePublishDraft.publishDefaultMode}
                        onChange={(event) => updateSourcePublishDraft({ publishDefaultMode: event.target.value as SourcePublishMode })}
                      >
                        <option value="branch-pr">branch-pr</option>
                        <option value="branch-only">branch-only</option>
                        <option value="direct-push">direct-push</option>
                      </select>
                      <span className="field-label">Default Base Branch</span>
                      <input
                        className="input"
                        placeholder="main"
                        value={sourcePublishDraft.defaultBaseBranch}
                        onChange={(event) => updateSourcePublishDraft({ defaultBaseBranch: event.target.value })}
                      />
                      <span className="field-label">Provider Hint</span>
                      <select
                        className="input"
                        value={sourcePublishDraft.providerHint}
                        onChange={(event) => updateSourcePublishDraft({ providerHint: event.target.value as SourceProviderHint })}
                      >
                        <option value="unknown">unknown</option>
                        <option value="github">github</option>
                        <option value="gitlab">gitlab</option>
                        <option value="bitbucket">bitbucket</option>
                      </select>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={sourcePublishDraft.officialContributionEnabled}
                          onChange={(event) => updateSourcePublishDraft({ officialContributionEnabled: event.target.checked })}
                        />
                        Official contribution enabled
                      </label>
                      <button className="btn btn-secondary" type="button" disabled={busy || !editingSourceId} onClick={saveSourcePublishSettings}>
                        Save source publish settings
                      </button>
                    </>
                  )}
                </article>

                <article className="panel panel-spacious">
                  <h2>Add Repository</h2>
                  <p className="subtle">Attach a new repository once and ICA will use it for source-backed skills, hooks, and publish flows.</p>
                  <span className="field-label">Source Name</span>
                  <input
                    className="input"
                    placeholder="Source name (optional)"
                    value={newSourceDraft.name}
                    onChange={(event) => updateNewSourceDraft({ name: event.target.value })}
                  />
                  <span className="field-label">Repository URL</span>
                  <input
                    className="input"
                    placeholder="https://github.com/org/repo.git"
                    value={newSourceDraft.repoUrl}
                    onChange={(event) => updateNewSourceDraft({ repoUrl: event.target.value })}
                  />
                  <div className="source-transport-group" role="radiogroup" aria-label="Source transport">
                    <label className="source-transport-option">
                      <input type="radio" checked={newSourceDraft.transport === "https"} onChange={() => updateNewSourceDraft({ transport: "https" })} /> HTTPS
                    </label>
                    <label className="source-transport-option">
                      <input type="radio" checked={newSourceDraft.transport === "ssh"} onChange={() => updateNewSourceDraft({ transport: "ssh" })} /> SSH
                    </label>
                  </div>
                  {newSourceDraft.transport === "https" && (
                    <>
                      <span className="field-label">PAT / API key</span>
                      <input
                        className="input"
                        placeholder="PAT / API key (optional for public repos)"
                        value={newSourceDraft.token}
                        onChange={(event) => updateNewSourceDraft({ token: event.target.value })}
                      />
                    </>
                  )}
                  <span className="field-label">Default Publish Mode (new source)</span>
                  <select
                    className="input"
                    value={newSourceDraft.publishDefaultMode}
                    onChange={(event) => updateNewSourceDraft({ publishDefaultMode: event.target.value as SourcePublishMode })}
                  >
                    <option value="branch-pr">branch-pr</option>
                    <option value="branch-only">branch-only</option>
                    <option value="direct-push">direct-push</option>
                  </select>
                  <span className="field-label">Default Base Branch (new source)</span>
                  <input
                    className="input"
                    placeholder="main"
                    value={newSourceDraft.defaultBaseBranch}
                    onChange={(event) => updateNewSourceDraft({ defaultBaseBranch: event.target.value })}
                  />
                  <span className="field-label">Provider Hint (new source)</span>
                  <select
                    className="input"
                    value={newSourceDraft.providerHint}
                    onChange={(event) => updateNewSourceDraft({ providerHint: event.target.value as SourceProviderHint })}
                  >
                    <option value="unknown">unknown</option>
                    <option value="github">github</option>
                    <option value="gitlab">gitlab</option>
                    <option value="bitbucket">bitbucket</option>
                  </select>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={newSourceDraft.officialContributionEnabled}
                      onChange={(event) => updateNewSourceDraft({ officialContributionEnabled: event.target.checked })}
                    />
                    Official contribution enabled (new source)
                  </label>
                  <div className="action-row">
                    <button className="btn btn-secondary" type="button" disabled={busy || !newSourceDraft.repoUrl.trim()} onClick={addSourceFromForm}>
                      Add repository
                    </button>
                    <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => setNewSourceDraft(createNewSourceDraft())}>
                      Reset form
                    </button>
                  </div>
                </article>
              </section>
            )}

            {activeRoute === "hooks" && (
              <div className="workspace desktop-route-section tab-section">
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
                            <button className={`chip chip-filter ${hookSourceFilter === "all" ? "is-active" : ""}`} type="button" onClick={() => setHookSourceFilter("all")}>
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

            {activeRoute === "reports" && (
              <section className="state-grid desktop-route-section tab-section">
                <article className="panel state-intro panel-spacious">
                  <h2>Reports</h2>
                  <p className="subtle">Inspect installed skill and hook state per target and review the latest operation payloads.</p>
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
          </main>
        </div>

      {publishComposerOpen && (
        <div className="publish-config-overlay" role="presentation" onClick={() => setPublishComposerOpen(false)}>
          <section
            className="publish-config-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Choose publish target"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="publish-picker-head">
              <div>
                <h3>Choose Publish Target</h3>
                <p className="subtle">Select the source target in this overlay, then publish.</p>
              </div>
              <button className="btn btn-inline" type="button" onClick={() => setPublishComposerOpen(false)}>
                Close
              </button>
            </div>
            <label className="publish-field">
              <span className="field-label">Target Source</span>
              <select
                className="input"
                value={editingSourceId}
                onChange={(event) => setEditingSourceId(event.target.value)}
                aria-label="Publish target source"
              >
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name || source.id}
                  </option>
                ))}
              </select>
            </label>
            <p className="publish-hint">
              Bundle path: <code>{skillPublishPath || "(not set)"}</code>
            </p>
            {publishBlockReason && <p className="source-error">{publishBlockReason}</p>}
            <div className="publish-actions">
              <button
                className="btn btn-primary"
                type="button"
                disabled={busy || !editingSourceId || !skillPublishPath.trim() || Boolean(publishBlockReason)}
                onClick={runSkillPublish}
              >
                Publish
              </button>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  setPublishComposerOpen(false);
                  setPublishAdvancedOpen(true);
                }}
              >
                Advanced Settings
              </button>
              <button className="btn btn-tertiary" type="button" disabled={busy} onClick={() => setPublishComposerOpen(false)}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      )}

      {publishAdvancedOpen && (
        <div className="publish-config-overlay" role="presentation" onClick={() => setPublishAdvancedOpen(false)}>
          <section
            className="publish-config-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Advanced publish settings"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="publish-picker-head">
              <div>
                <h3>Advanced Settings</h3>
                <p className="subtle">Adjust bundle path, metadata, validation, and contribution options here.</p>
              </div>
              <button className="btn btn-inline" type="button" onClick={() => setPublishAdvancedOpen(false)}>
                Close
              </button>
            </div>

            <div className="publish-grid">
              <label className="publish-field publish-field-span">
                <span className="field-label">Local Skill Path</span>
                <div className="publish-path-row">
                  <input
                    className="input"
                    name="advanced-local-skill-path"
                    autoComplete="off"
                    placeholder="/path/to/local/skill…"
                    value={skillPublishPath}
                    onChange={(event) => setSkillPublishPath(event.target.value)}
                    aria-label="Local skill path"
                  />
                  <div className="publish-path-actions">
                    <button className="btn btn-inline" type="button" disabled={busy} onClick={pickSkillPublishPath}>
                      Pick Folder
                    </button>
                    <button
                      className="btn btn-inline"
                      type="button"
                      disabled={busy || skillPublishCandidates.length === 0}
                      onClick={() => {
                        setSkillPickerQuery("");
                        setSkillPickerOpen(true);
                      }}
                    >
                      Select From Local Catalog
                    </button>
                  </div>
                </div>
              </label>

              <label className="publish-field">
                <span className="field-label">Skill Name Override (optional)</span>
                <input
                  className="input"
                  name="advanced-skill-name"
                  autoComplete="off"
                  placeholder="my-skill…"
                  value={skillPublishName}
                  onChange={(event) => setSkillPublishName(event.target.value)}
                />
              </label>

              <label className="publish-field">
                <span className="field-label">Commit Message (optional)</span>
                <input
                  className="input"
                  name="advanced-commit-message"
                  autoComplete="off"
                  placeholder="feat(skill): publish my-skill…"
                  value={skillPublishMessage}
                  onChange={(event) => setSkillPublishMessage(event.target.value)}
                />
              </label>

              <label className="publish-field">
                <span className="field-label">Publish Mode Override (optional)</span>
                <select
                  className="input"
                  name="advanced-override-mode"
                  value={skillPublishOverrideMode}
                  onChange={(event) => setSkillPublishOverrideMode(event.target.value as "source-default" | PublishMode)}
                >
                  <option value="source-default">
                    source default ({selectedPublishSource?.publishDefaultMode || "branch-pr"})
                  </option>
                  <option value="direct-push">direct-push</option>
                  <option value="branch-only">branch-only</option>
                  <option value="branch-pr">branch-pr</option>
                </select>
              </label>

              <label className="publish-field">
                <span className="field-label">Base Branch Override (optional)</span>
                <input
                  className="input"
                  name="advanced-override-base-branch"
                  autoComplete="off"
                  placeholder={selectedPublishSource?.defaultBaseBranch || (selectedPublishSource?.official ? "dev" : "main")}
                  value={skillPublishOverrideBaseBranch}
                  onChange={(event) => setSkillPublishOverrideBaseBranch(event.target.value)}
                />
              </label>

              <label className="publish-field">
                <span className="field-label">Validation Profile</span>
                <select className="input" value={skillValidationProfile} onChange={(event) => setSkillValidationProfile(event.target.value as "personal" | "official")}>
                  <option value="personal">personal</option>
                  <option value="official">official</option>
                </select>
              </label>
            </div>

            {publishBlockReason && <p className="source-error">{publishBlockReason}</p>}
            <div className="publish-actions">
              <button className="btn btn-secondary" type="button" disabled={busy || !skillPublishPath.trim()} onClick={runSkillValidation}>
                Validate
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={busy || !skillPublishPath.trim() || !editingSourceId || Boolean(publishBlockReason)}
                onClick={runSkillPublish}
              >
                Publish
              </button>
              <button className="btn btn-tertiary" type="button" disabled={busy || !skillPublishPath.trim()} onClick={runOfficialContribution}>
                Contribute Official
              </button>
            </div>
            <div className="publish-actions">
              <button
                className="btn btn-inline"
                type="button"
                disabled={busy}
                onClick={() => {
                  setPublishAdvancedOpen(false);
                  setPublishComposerOpen(true);
                }}
              >
                Back to Publish Target
              </button>
            </div>
          </section>
        </div>
      )}

      </div>

      {skillPickerOpen && (
        <div className="publish-picker-overlay" role="presentation" onClick={() => setSkillPickerOpen(false)}>
          <section
            className="publish-picker-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Select local skill bundle"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="publish-picker-head">
              <div>
                <h3>Select Local Skill Bundle</h3>
                <p className="subtle">Pick a bundle discovered in your local catalog, then publish it without retyping paths.</p>
              </div>
              <button className="btn btn-inline" type="button" onClick={() => setSkillPickerOpen(false)}>
                Close
              </button>
            </div>
            <input
              className="input input-search"
              name="skill-picker-search"
              autoComplete="off"
              placeholder="Search by skill, source, or path…"
              value={skillPickerQuery}
              onChange={(event) => setSkillPickerQuery(event.target.value)}
              aria-label="Search local skill bundles"
            />
            <div className="publish-picker-list">
              {visibleSkillPublishCandidates.length === 0 ? (
                <div className="empty-state">No local bundles match this search.</div>
              ) : (
                visibleSkillPublishCandidates.map((candidate) => (
                  <button key={candidate.skillId} className="publish-picker-item" type="button" onClick={() => applySkillPublishCandidate(candidate)}>
                    <span className="publish-picker-item-name">{candidate.skillName}</span>
                    <span className="publish-picker-item-source">{candidate.sourceName}</span>
                    <code>{candidate.localPath}</code>
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
