import React from "react";
import { DashboardUiPlugin } from "./api";

export const diagnosticsUiPlugin: DashboardUiPlugin = {
  id: "diagnostics",
  register(context) {
    context.addTab({
      id: "plugin-diagnostics",
      title: "Diagnostics",
      order: 200,
      render: () => (
        <section className="state-grid tab-section">
          <article className="panel state-intro panel-spacious">
            <h2>Plugin Diagnostics</h2>
            <p className="subtle">Plugin ID: {context.id}</p>
          </article>
          <article className="panel panel-state panel-spacious">
            <pre>{JSON.stringify(context.config, null, 2)}</pre>
          </article>
        </section>
      ),
    });

    context.addSettingsSection({
      id: "plugin-diagnostics-settings",
      title: "Diagnostics Settings",
      order: 200,
      render: () => <p className="subtle">Diagnostics plugin is enabled.</p>,
    });
  },
};
