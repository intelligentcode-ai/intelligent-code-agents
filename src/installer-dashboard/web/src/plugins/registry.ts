import { DashboardUiPluginRegistry } from "./api";
import { diagnosticsUiPlugin } from "./diagnostics";

export const dashboardUiPluginRegistry: DashboardUiPluginRegistry = {
  diagnostics: diagnosticsUiPlugin,
};
