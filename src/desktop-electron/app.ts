import { app } from "electron";
import { registerElectronDesktopBridge } from "./main";
import { resolveDesktopStartUrl } from "./startup";
import { findRepoRoot } from "../installer-core/repo";

export async function startElectronDesktopApp(): Promise<void> {
  const repoRoot = findRepoRoot(__dirname);
  const startUrl = resolveDesktopStartUrl(repoRoot, process.env);
  const desktopBridge = await registerElectronDesktopBridge({
    repoRoot,
    startUrl,
  });

  await desktopBridge.createWindow();

  app.on("window-all-closed", async () => {
    await desktopBridge.dispose();
    app.quit();
  });
}

if (require.main === module) {
  void startElectronDesktopApp().catch((error) => {
    console.error("[desktop] Electron startup failed.", error);
    app.quit();
  });
}
