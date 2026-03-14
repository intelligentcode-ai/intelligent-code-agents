import { fetchLatestGithubRelease, isVersionNewer, type AppUpdateStatus } from "../installer-core/updateCheck";
import { safeErrorMessage } from "../installer-core/security";

export interface NativeDesktopUpdater {
  channel?: string;
  checkForUpdates(): Promise<{ version: string; releaseUrl?: string } | null>;
  downloadUpdate(): Promise<{ version?: string } | null>;
  quitAndInstall(): void;
}

interface CreateDesktopUpdateCoordinatorOptions {
  currentVersion: string;
  packaged: boolean;
  nativeUpdater?: NativeDesktopUpdater;
  fetchLatestRelease?: typeof fetchLatestGithubRelease;
  now?: () => number;
  channel?: string;
}

export interface DesktopUpdateCoordinator {
  checkForAppUpdate(force?: boolean): Promise<AppUpdateStatus>;
  downloadAppUpdate(): Promise<AppUpdateStatus>;
  quitAndInstallAppUpdate(): Promise<{ accepted: boolean }>;
}

function buildStatus(input: AppUpdateStatus): AppUpdateStatus {
  return input;
}

export function createDesktopUpdateCoordinator(options: CreateDesktopUpdateCoordinatorOptions): DesktopUpdateCoordinator {
  const now = options.now || (() => Date.now());
  const fetchLatestRelease = options.fetchLatestRelease || fetchLatestGithubRelease;
  const channel = options.channel || options.nativeUpdater?.channel || "stable";
  let latestVersion: string | undefined;
  let latestReleaseUrl: string | undefined;
  let downloaded = false;
  let lastError: string | undefined;

  const baseStatus = (overrides: Partial<AppUpdateStatus> = {}): AppUpdateStatus =>
    buildStatus({
      currentVersion: options.currentVersion,
      latestVersion,
      latestReleaseUrl,
      checkedAt: new Date(now()).toISOString(),
      updateAvailable: latestVersion ? isVersionNewer(latestVersion, options.currentVersion) : false,
      channel,
      runtime: options.packaged ? "desktop-packaged" : "desktop-preview",
      canAutoApply: Boolean(options.packaged && options.nativeUpdater),
      downloaded,
      error: lastError,
      ...overrides,
    });

  return {
    async checkForAppUpdate() {
      downloaded = false;
      lastError = undefined;

      if (options.packaged && options.nativeUpdater) {
        try {
          const result = await options.nativeUpdater.checkForUpdates();
          latestVersion = result?.version;
          latestReleaseUrl = result?.releaseUrl;
          return baseStatus();
        } catch (error) {
          lastError = safeErrorMessage(error, "Unable to check for desktop updates.");
          return baseStatus({
            updateAvailable: false,
            error: lastError,
          });
        }
      }

      try {
        const latest = await fetchLatestRelease();
        latestVersion = latest.version;
        latestReleaseUrl = latest.url;
        return baseStatus({
          runtime: "desktop-preview",
          canAutoApply: false,
        });
      } catch (error) {
        lastError = safeErrorMessage(error, "Unable to check for desktop updates.");
        return baseStatus({
          runtime: "desktop-preview",
          canAutoApply: false,
          updateAvailable: false,
          error: lastError,
        });
      }
    },

    async downloadAppUpdate() {
      if (!(options.packaged && options.nativeUpdater)) {
        lastError = "Automatic updates are unavailable in preview mode.";
        return baseStatus({
          runtime: "desktop-preview",
          canAutoApply: false,
          error: lastError,
        });
      }

      if (!latestVersion || !isVersionNewer(latestVersion, options.currentVersion)) {
        return baseStatus();
      }

      try {
        const result = await options.nativeUpdater.downloadUpdate();
        downloaded = true;
        if (result?.version) {
          latestVersion = result.version;
        }
        lastError = undefined;
        return baseStatus();
      } catch (error) {
        lastError = safeErrorMessage(error, "Unable to download desktop update.");
        return baseStatus({
          downloaded: false,
          error: lastError,
        });
      }
    },

    async quitAndInstallAppUpdate() {
      if (!(options.packaged && options.nativeUpdater) || !downloaded) {
        return { accepted: false };
      }
      options.nativeUpdater.quitAndInstall();
      return { accepted: true };
    },
  };
}

export function createNativeDesktopUpdater(): NativeDesktopUpdater | undefined {
  try {
    const { autoUpdater } = require("electron-updater") as {
      autoUpdater: {
        autoDownload?: boolean;
        autoInstallOnAppQuit?: boolean;
        channel?: string;
        checkForUpdates(): Promise<{ updateInfo?: { version?: string } } | null>;
        downloadUpdate(): Promise<unknown>;
        quitAndInstall(): void;
      };
    };

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.channel = process.env.ICA_DESKTOP_UPDATE_CHANNEL || "latest";

    return {
      channel: "stable",
      async checkForUpdates() {
        const result = await autoUpdater.checkForUpdates();
        const version = result?.updateInfo?.version;
        return version ? { version } : null;
      },
      async downloadUpdate() {
        await autoUpdater.downloadUpdate();
        return null;
      },
      quitAndInstall() {
        autoUpdater.quitAndInstall();
      },
    };
  } catch {
    return undefined;
  }
}
