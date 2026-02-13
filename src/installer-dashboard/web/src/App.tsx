import React from "react";
import { InstallerDashboard } from "./InstallerDashboard";

export function App(): JSX.Element {
  return (
    <div>
      <a className="skip-link" href="#main-content">
        Skip to Main Content
      </a>
      <main id="main-content" className="dashboard-main">
        <InstallerDashboard />
      </main>
    </div>
  );
}
