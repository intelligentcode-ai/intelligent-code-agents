import React from "react";
import { InstallerDashboard } from "./InstallerDashboard";

export function App(): JSX.Element {
  return (
    <div className="desktop-shell-app">
      <a className="skip-link" href="#main-content">
        Skip to Main Content
      </a>
      <main id="main-content" className="desktop-shell-app-main">
        <InstallerDashboard />
      </main>
    </div>
  );
}
