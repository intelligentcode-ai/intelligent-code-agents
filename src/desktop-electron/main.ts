import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import {
  CONTROL_PLANE_IPC_CHANNEL,
  DESKTOP_OPEN_SETTINGS_IPC_CHANNEL,
  DESKTOP_PICK_PROJECT_IPC_CHANNEL,
  DESKTOP_PICK_PUBLISH_IPC_CHANNEL,
  DESKTOP_REPORT_FAILURE_IPC_CHANNEL,
  DESKTOP_RUNTIME_INFO_IPC_CHANNEL,
  DESKTOP_UPDATE_CHECK_IPC_CHANNEL,
  DESKTOP_UPDATE_DOWNLOAD_IPC_CHANNEL,
  DESKTOP_UPDATE_QUIT_AND_INSTALL_IPC_CHANNEL,
  REALTIME_EVENT_CHANNEL,
  REALTIME_SUBSCRIBE_CHANNEL,
  REALTIME_UNSUBSCRIBE_CHANNEL,
  type DesktopHostFailureReport,
  type DesktopBridgeRequestMap,
} from "./bridge";
import { createDesktopControlPlane } from "./controlPlane";
import { createDesktopUpdateCoordinator, createNativeDesktopUpdater, type DesktopUpdateCoordinator } from "./updater";
import type { InstallerApplicationService } from "../installer-core/applicationService";
import { findRepoRoot } from "../installer-core/repo";
import {
  installDesktopLoadDiagnostics,
  normalizeStartupErrorMessage,
  resolveDesktopStartUrl,
  showDesktopLoadFailure,
  type DesktopStartupLogger,
} from "./startup";

export interface RegisterElectronDesktopBridgeOptions {
  repoRoot?: string;
  applicationService?: Partial<InstallerApplicationService>;
  updateCoordinator?: DesktopUpdateCoordinator;
  startUrl?: string;
  env?: NodeJS.ProcessEnv;
  logger?: DesktopStartupLogger;
}

function buildDesktopWindowUrl(startUrl: string, windowRole: "main" | "settings"): string {
  const url = new URL(startUrl);
  url.searchParams.set("windowRole", windowRole);
  return url.toString();
}

async function loadDesktopWindow(window: BrowserWindow, targetUrl: string, logger: DesktopStartupLogger): Promise<void> {
  installDesktopLoadDiagnostics(window, targetUrl, logger);
  try {
    await window.loadURL(targetUrl);
  } catch (error) {
    const reason = normalizeStartupErrorMessage(error);
    logger.error(`[desktop] Initial renderer load rejected for '${targetUrl}': ${reason}`);
    await showDesktopLoadFailure(
      window,
      {
        attemptedUrl: targetUrl,
        failingUrl: targetUrl,
        reason,
      },
      logger,
    );
  }
}

export async function registerElectronDesktopBridge(
  options: RegisterElectronDesktopBridgeOptions = {},
): Promise<{ createWindow: () => Promise<BrowserWindow>; dispose: () => Promise<void> }> {
  const repoRoot = options.repoRoot || findRepoRoot(__dirname);
  const startUrl = options.startUrl || resolveDesktopStartUrl(repoRoot, options.env || process.env);
  const logger = options.logger || console;
  const updateCoordinator =
    options.updateCoordinator ||
    createDesktopUpdateCoordinator({
      currentVersion: app.getVersion(),
      packaged: app.isPackaged,
      nativeUpdater: app.isPackaged ? createNativeDesktopUpdater() : undefined,
    });
  const controlPlane = await createDesktopControlPlane({
    repoRoot,
    applicationService: options.applicationService,
  });
  const subscriptions = new Map<number, () => void>();
  let mainWindow: BrowserWindow | null = null;
  let settingsWindow: BrowserWindow | null = null;

  async function createMainWindow(): Promise<BrowserWindow> {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return mainWindow;
    }

    const window = new BrowserWindow({
      width: 1440,
      height: 940,
      show: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    window.webContents.on("destroyed", () => {
      if (mainWindow === window) {
        mainWindow = null;
      }
    });
    mainWindow = window;
    await loadDesktopWindow(window, buildDesktopWindowUrl(startUrl, "main"), logger);
    return window;
  }

  async function createSettingsWindow(): Promise<BrowserWindow> {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      return settingsWindow;
    }

    const window = new BrowserWindow({
      width: 1120,
      height: 860,
      show: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    window.webContents.on("destroyed", () => {
      if (settingsWindow === window) {
        settingsWindow = null;
      }
    });
    settingsWindow = window;
    await loadDesktopWindow(window, buildDesktopWindowUrl(startUrl, "settings"), logger);
    return window;
  }

  ipcMain.handle(CONTROL_PLANE_IPC_CHANNEL, async (_event, channel: keyof DesktopBridgeRequestMap, payload: DesktopBridgeRequestMap[keyof DesktopBridgeRequestMap]) => {
    if (channel !== "control-plane.request") {
      throw new Error(`Unsupported desktop bridge channel '${String(channel)}'.`);
    }
    return controlPlane.request(payload);
  });
  ipcMain.handle(DESKTOP_PICK_PROJECT_IPC_CHANNEL, async (_event, initialPath?: string) => controlPlane.pickProjectDirectory(initialPath));
  ipcMain.handle(DESKTOP_PICK_PUBLISH_IPC_CHANNEL, async (_event, initialPath?: string) => controlPlane.pickPublishDirectory(initialPath));
  ipcMain.handle(DESKTOP_OPEN_SETTINGS_IPC_CHANNEL, async () => {
    const window = await createSettingsWindow();
    window.show();
    window.focus();
  });
  ipcMain.handle(DESKTOP_RUNTIME_INFO_IPC_CHANNEL, async () => controlPlane.getRuntimeInfo());
  ipcMain.handle(DESKTOP_REPORT_FAILURE_IPC_CHANNEL, async (_event, payload: DesktopHostFailureReport) => {
    await controlPlane.reportRendererFailure(payload);
  });
  ipcMain.handle(DESKTOP_UPDATE_CHECK_IPC_CHANNEL, async (_event, force?: boolean) => updateCoordinator.checkForAppUpdate(force));
  ipcMain.handle(DESKTOP_UPDATE_DOWNLOAD_IPC_CHANNEL, async () => updateCoordinator.downloadAppUpdate());
  ipcMain.handle(DESKTOP_UPDATE_QUIT_AND_INSTALL_IPC_CHANNEL, async () => updateCoordinator.quitAndInstallAppUpdate());

  ipcMain.on(REALTIME_SUBSCRIBE_CHANNEL, (event) => {
    const webContents = event.sender;
    subscriptions.get(webContents.id)?.();
    const unsubscribe = controlPlane.subscribeRealtime((payload) => {
      if (!webContents.isDestroyed()) {
        webContents.send(REALTIME_EVENT_CHANNEL, payload);
      }
    });
    subscriptions.set(webContents.id, unsubscribe);
    webContents.on("destroyed", () => {
      subscriptions.get(webContents.id)?.();
      subscriptions.delete(webContents.id);
    });
  });

  ipcMain.on(REALTIME_UNSUBSCRIBE_CHANNEL, (event) => {
    const webContents = event.sender;
    subscriptions.get(webContents.id)?.();
    subscriptions.delete(webContents.id);
  });

  return {
    async createWindow() {
      await app.whenReady();
      return createMainWindow();
    },
    async dispose() {
      for (const unsubscribe of subscriptions.values()) {
        unsubscribe();
      }
      subscriptions.clear();
      ipcMain.removeHandler(CONTROL_PLANE_IPC_CHANNEL);
      ipcMain.removeHandler(DESKTOP_PICK_PROJECT_IPC_CHANNEL);
      ipcMain.removeHandler(DESKTOP_PICK_PUBLISH_IPC_CHANNEL);
      ipcMain.removeHandler(DESKTOP_OPEN_SETTINGS_IPC_CHANNEL);
      ipcMain.removeHandler(DESKTOP_RUNTIME_INFO_IPC_CHANNEL);
      ipcMain.removeHandler(DESKTOP_REPORT_FAILURE_IPC_CHANNEL);
      ipcMain.removeHandler(DESKTOP_UPDATE_CHECK_IPC_CHANNEL);
      ipcMain.removeHandler(DESKTOP_UPDATE_DOWNLOAD_IPC_CHANNEL);
      ipcMain.removeHandler(DESKTOP_UPDATE_QUIT_AND_INSTALL_IPC_CHANNEL);
      ipcMain.removeAllListeners(REALTIME_SUBSCRIBE_CHANNEL);
      ipcMain.removeAllListeners(REALTIME_UNSUBSCRIBE_CHANNEL);
      mainWindow = null;
      settingsWindow = null;
      await controlPlane.close();
    },
  };
}
