import React, { useState } from "react";
import { InstallerDashboard } from "./InstallerDashboard";
import { HarnessDashboard } from "./HarnessDashboard";

export function App(): JSX.Element {
  const [view, setView] = useState<"installer" | "harness">("installer");

  return (
    <div>
      <nav className="top-nav">
        <button
          className={view === "installer" ? "chip is-active" : "chip"}
          onClick={() => setView("installer")}
        >
          Installer
        </button>
        <button
          className={view === "harness" ? "chip is-active" : "chip"}
          onClick={() => setView("harness")}
        >
          Harness
        </button>
      </nav>
      {view === "installer" ? <InstallerDashboard /> : <HarnessDashboard />}
    </div>
  );
}
