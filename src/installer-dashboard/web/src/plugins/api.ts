import type { ReactNode } from "react";

export type DashboardUiPanelLocation = "skills.sidebar" | "sources.footer" | "settings.sections";
export type DashboardUiActionLocation = "skills.sidebar" | "settings.sections";

export interface DashboardUiTabContribution {
  id: string;
  title: string;
  order?: number;
  render: () => ReactNode;
}

export interface DashboardUiPanelContribution {
  id: string;
  location: DashboardUiPanelLocation;
  title: string;
  order?: number;
  render: () => ReactNode;
}

export interface DashboardUiSettingsSectionContribution {
  id: string;
  title: string;
  order?: number;
  render: () => ReactNode;
}

export interface DashboardUiActionContribution {
  id: string;
  location: DashboardUiActionLocation;
  label: string;
  order?: number;
  run: () => void | Promise<void>;
}

export interface DashboardUiPluginContext {
  id: string;
  config: Record<string, unknown>;
  addTab(tab: DashboardUiTabContribution): void;
  addPanel(panel: DashboardUiPanelContribution): void;
  addSettingsSection(section: DashboardUiSettingsSectionContribution): void;
  addAction(action: DashboardUiActionContribution): void;
}

export interface DashboardUiPlugin {
  id: string;
  register(context: DashboardUiPluginContext): void;
}

export type DashboardUiPluginRegistry = Record<string, DashboardUiPlugin>;

export interface DashboardUiPluginRuntime {
  loadedPluginIds: string[];
  tabs: DashboardUiTabContribution[];
  panelsByLocation: Record<DashboardUiPanelLocation, DashboardUiPanelContribution[]>;
  settingsSections: DashboardUiSettingsSectionContribution[];
  actionsByLocation: Record<DashboardUiActionLocation, DashboardUiActionContribution[]>;
}

function sortByOrder<T extends { id: string; order?: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const orderA = a.order ?? 1000;
    const orderB = b.order ?? 1000;
    if (orderA !== orderB) return orderA - orderB;
    return a.id.localeCompare(b.id);
  });
}

export function parseEnabledDashboardUiPlugins(value: string | undefined): string[] {
  if (!value) return [];
  const parsed = value
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  return Array.from(new Set(parsed));
}

export function parseDashboardUiPluginConfig(value: unknown): Record<string, Record<string, unknown>> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseDashboardUiPluginConfig(parsed);
    } catch {
      return {};
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const [pluginId, config] of Object.entries(value)) {
    if (config && typeof config === "object" && !Array.isArray(config)) {
      normalized[pluginId] = config as Record<string, unknown>;
    }
  }
  return normalized;
}

export function loadDashboardUiPlugins(params: {
  enabledPluginIds: string[];
  registry: DashboardUiPluginRegistry;
  pluginConfigs?: Record<string, Record<string, unknown>>;
}): DashboardUiPluginRuntime {
  const { enabledPluginIds, registry, pluginConfigs } = params;
  const tabs = new Map<string, DashboardUiTabContribution>();
  const settingsSections = new Map<string, DashboardUiSettingsSectionContribution>();
  const panelsByLocation: Record<DashboardUiPanelLocation, Map<string, DashboardUiPanelContribution>> = {
    "skills.sidebar": new Map(),
    "sources.footer": new Map(),
    "settings.sections": new Map(),
  };
  const actionsByLocation: Record<DashboardUiActionLocation, Map<string, DashboardUiActionContribution>> = {
    "skills.sidebar": new Map(),
    "settings.sections": new Map(),
  };
  const loadedPluginIds: string[] = [];

  for (const pluginId of enabledPluginIds) {
    const plugin = registry[pluginId];
    if (!plugin) continue;
    plugin.register({
      id: plugin.id,
      config: pluginConfigs?.[plugin.id] || {},
      addTab(tab) {
        tabs.set(tab.id, tab);
      },
      addPanel(panel) {
        panelsByLocation[panel.location].set(panel.id, panel);
      },
      addSettingsSection(section) {
        settingsSections.set(section.id, section);
      },
      addAction(action) {
        actionsByLocation[action.location].set(action.id, action);
      },
    });
    loadedPluginIds.push(plugin.id);
  }

  return {
    loadedPluginIds,
    tabs: sortByOrder(Array.from(tabs.values())),
    panelsByLocation: {
      "skills.sidebar": sortByOrder(Array.from(panelsByLocation["skills.sidebar"].values())),
      "sources.footer": sortByOrder(Array.from(panelsByLocation["sources.footer"].values())),
      "settings.sections": sortByOrder(Array.from(panelsByLocation["settings.sections"].values())),
    },
    settingsSections: sortByOrder(Array.from(settingsSections.values())),
    actionsByLocation: {
      "skills.sidebar": sortByOrder(Array.from(actionsByLocation["skills.sidebar"].values())),
      "settings.sections": sortByOrder(Array.from(actionsByLocation["settings.sections"].values())),
    },
  };
}
