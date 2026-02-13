import { DashboardServerPlugin } from "../plugins";

export const diagnosticsDashboardPlugin: DashboardServerPlugin = {
  id: "diagnostics",
  async register(context) {
    context.capabilities.add({
      id: "plugin-diagnostics",
      title: "Plugin diagnostics endpoint",
      enabled: true,
    });

    context.scopedApp.get("/health", async () => {
      return {
        ok: true,
        pluginId: context.id,
        mode: context.config.mode || "default",
      };
    });
  },
};
