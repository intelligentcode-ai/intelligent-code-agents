import { app } from "electron";
import path from "node:path";
import { registerElectronDesktopBridge } from "./main";
import { resolveDesktopStartUrl } from "./startup";
import { findRepoRoot } from "../installer-core/repo";

export interface DesktopStartupWindow {
  show(): void;
  focus(): void;
}

export interface DesktopStartupApp {
  dock?: {
    show(): void;
  };
  focus(options?: { steal?: boolean }): void;
}

export function focusDesktopWindow(window: DesktopStartupWindow, desktopApp: DesktopStartupApp = app): void {
  try {
    desktopApp.dock?.show();
  } catch {
    // Ignore dock activation failures on non-macOS runtimes.
  }

  window.show();
  window.focus();

  try {
    desktopApp.focus({ steal: true });
  } catch {
    desktopApp.focus();
  }
}

export function shouldAutoStartDesktopApp(
  argv: string[] = process.argv,
  filename: string = __filename,
  electronRuntime: string | undefined = process.versions?.electron,
): boolean {
  if (!electronRuntime) {
    return false;
  }

  const entryArg = argv[1];
  if (!entryArg) {
    return false;
  }

  return path.resolve(entryArg) === path.resolve(filename);
}

export async function startElectronDesktopApp(): Promise<void> {
  await app.whenReady();
  const repoRoot = findRepoRoot(__dirname);
  const startUrl = resolveDesktopStartUrl(repoRoot, process.env);
  const desktopBridge = await registerElectronDesktopBridge({
    repoRoot,
    startUrl,
  });

  const window = await desktopBridge.createWindow();
  focusDesktopWindow(window);

  app.on("window-all-closed", async () => {
    await desktopBridge.dispose();
    app.quit();
  });

  app.on("activate", () => {
    focusDesktopWindow(window);
  });
}

if (shouldAutoStartDesktopApp()) {
  void startElectronDesktopApp().catch((error) => {
    console.error("[desktop] Electron startup failed.", error);
    app.quit();
  });
}
