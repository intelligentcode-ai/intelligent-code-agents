import test from "node:test";
import assert from "node:assert/strict";
import { createDesktopUpdateCoordinator, type NativeDesktopUpdater } from "../../src/desktop-electron/updater";

function createNativeUpdaterStub(): NativeDesktopUpdater & {
  checkCalls: number;
  downloadCalls: number;
  quitCalls: number;
} {
  return {
    channel: "stable",
    checkCalls: 0,
    downloadCalls: 0,
    quitCalls: 0,
    async checkForUpdates() {
      this.checkCalls += 1;
      return {
        version: "12.4.0",
        releaseUrl: "https://github.com/intelligentcode-ai/intelligent-code-agents/releases/tag/v12.4.0",
      };
    },
    async downloadUpdate() {
      this.downloadCalls += 1;
      return {
        version: "12.4.0",
      };
    },
    quitAndInstall() {
      this.quitCalls += 1;
    },
  };
}

test("desktop packaged updater reports auto-apply capable updates", async () => {
  const nativeUpdater = createNativeUpdaterStub();
  const coordinator = createDesktopUpdateCoordinator({
    currentVersion: "12.3.0",
    packaged: true,
    nativeUpdater,
  });

  const status = await coordinator.checkForAppUpdate(true);

  assert.equal(status.runtime, "desktop-packaged");
  assert.equal(status.channel, "stable");
  assert.equal(status.updateAvailable, true);
  assert.equal(status.latestVersion, "12.4.0");
  assert.equal(status.canAutoApply, true);
  assert.equal(status.downloaded, false);
  assert.equal(nativeUpdater.checkCalls, 1);
});

test("desktop preview mode falls back to GitHub release checks without auto-apply", async () => {
  const coordinator = createDesktopUpdateCoordinator({
    currentVersion: "12.3.0",
    packaged: false,
    fetchLatestRelease: async () => ({
      version: "12.4.0",
      url: "https://github.com/intelligentcode-ai/intelligent-code-agents/releases/tag/v12.4.0",
    }),
  });

  const status = await coordinator.checkForAppUpdate(true);

  assert.equal(status.runtime, "desktop-preview");
  assert.equal(status.channel, "stable");
  assert.equal(status.updateAvailable, true);
  assert.equal(status.canAutoApply, false);
  assert.equal(status.downloaded, false);
});

test("desktop packaged updater download and quit/install advance update lifecycle state", async () => {
  const nativeUpdater = createNativeUpdaterStub();
  const coordinator = createDesktopUpdateCoordinator({
    currentVersion: "12.3.0",
    packaged: true,
    nativeUpdater,
  });

  await coordinator.checkForAppUpdate(true);
  const downloaded = await coordinator.downloadAppUpdate();
  const installResult = await coordinator.quitAndInstallAppUpdate();

  assert.equal(downloaded.downloaded, true);
  assert.equal(downloaded.canAutoApply, true);
  assert.equal(nativeUpdater.downloadCalls, 1);
  assert.equal(installResult.accepted, true);
  assert.equal(nativeUpdater.quitCalls, 1);
});

test("desktop preview mode rejects automatic download and quit/install flows", async () => {
  const coordinator = createDesktopUpdateCoordinator({
    currentVersion: "12.3.0",
    packaged: false,
    fetchLatestRelease: async () => ({
      version: "12.4.0",
      url: "https://github.com/intelligentcode-ai/intelligent-code-agents/releases/tag/v12.4.0",
    }),
  });

  await coordinator.checkForAppUpdate(true);
  const downloadResult = await coordinator.downloadAppUpdate();
  const installResult = await coordinator.quitAndInstallAppUpdate();

  assert.equal(downloadResult.runtime, "desktop-preview");
  assert.equal(downloadResult.canAutoApply, false);
  assert.match(downloadResult.error || "", /preview mode/i);
  assert.equal(installResult.accepted, false);
});

test("desktop packaged updater reports download failures without losing lifecycle state", async () => {
  const nativeUpdater = createNativeUpdaterStub();
  nativeUpdater.downloadUpdate = async function downloadUpdateFailure() {
    this.downloadCalls += 1;
    throw new Error("network timeout");
  };

  const coordinator = createDesktopUpdateCoordinator({
    currentVersion: "12.3.0",
    packaged: true,
    nativeUpdater,
  });

  await coordinator.checkForAppUpdate(true);
  const result = await coordinator.downloadAppUpdate();

  assert.equal(result.downloaded, false);
  assert.equal(result.canAutoApply, true);
  assert.match(result.error || "", /network timeout/i);
});
