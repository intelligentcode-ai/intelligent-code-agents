import React from "react";
import { InstallerDashboard } from "./InstallerDashboard";
import { resolveDashboardWindowRole } from "./window-role";

export function App(): JSX.Element {
  const windowRole = resolveDashboardWindowRole();

  return (
    <div className={`desktop-shell-app desktop-shell-app-${windowRole}`}>
      <a className="skip-link" href="#main-content">
        Skip to Main Content
      </a>
      <main id="main-content" className="desktop-shell-app-main">
        <InstallerDashboard windowRole={windowRole} />
      </main>
    </div>
  );
}
