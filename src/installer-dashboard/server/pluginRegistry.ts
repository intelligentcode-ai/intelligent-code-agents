import { DashboardServerPluginRegistry } from "./plugins";
import { diagnosticsDashboardPlugin } from "./plugins/diagnostics";

export const dashboardServerPluginRegistry: DashboardServerPluginRegistry = {
  diagnostics: diagnosticsDashboardPlugin,
};
