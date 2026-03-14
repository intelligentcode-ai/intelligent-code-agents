import { contextBridge, ipcRenderer } from "electron";
import {
  CONTROL_PLANE_IPC_CHANNEL,
  DESKTOP_UPDATE_CHECK_IPC_CHANNEL,
  DESKTOP_UPDATE_DOWNLOAD_IPC_CHANNEL,
  DESKTOP_UPDATE_QUIT_AND_INSTALL_IPC_CHANNEL,
  DESKTOP_PICK_PROJECT_IPC_CHANNEL,
  DESKTOP_PICK_PUBLISH_IPC_CHANNEL,
  DESKTOP_REPORT_FAILURE_IPC_CHANNEL,
  DESKTOP_RUNTIME_INFO_IPC_CHANNEL,
  REALTIME_EVENT_CHANNEL,
  REALTIME_SUBSCRIBE_CHANNEL,
  REALTIME_UNSUBSCRIBE_CHANNEL,
  type DesktopBridgeApi,
  type DesktopHostFailureReport,
  type DesktopBridgeRequestMap,
  type DesktopBridgeResponseMap,
  type DesktopRuntimeInfo,
  type RealtimeEvent,
} from "./bridge";

const desktopBridge: DesktopBridgeApi = {
  request(channel, payload) {
    return ipcRenderer.invoke(
      CONTROL_PLANE_IPC_CHANNEL,
      channel,
      payload,
    ) as Promise<DesktopBridgeResponseMap[typeof channel]>;
  },

  subscribeRealtime(listener) {
    const wrappedListener = (_event: unknown, payload: RealtimeEvent) => {
      listener(payload);
    };
    ipcRenderer.on(REALTIME_EVENT_CHANNEL, wrappedListener);
    ipcRenderer.send(REALTIME_SUBSCRIBE_CHANNEL);
    return () => {
      ipcRenderer.off(REALTIME_EVENT_CHANNEL, wrappedListener);
      ipcRenderer.send(REALTIME_UNSUBSCRIBE_CHANNEL);
    };
  },

  checkForAppUpdate(force) {
    return ipcRenderer.invoke(DESKTOP_UPDATE_CHECK_IPC_CHANNEL, force) as Promise<import("../installer-core/updateCheck").AppUpdateStatus>;
  },

  downloadAppUpdate() {
    return ipcRenderer.invoke(DESKTOP_UPDATE_DOWNLOAD_IPC_CHANNEL) as Promise<import("../installer-core/updateCheck").AppUpdateStatus>;
  },

  quitAndInstallAppUpdate() {
    return ipcRenderer.invoke(DESKTOP_UPDATE_QUIT_AND_INSTALL_IPC_CHANNEL) as Promise<{ accepted: boolean }>;
  },

  pickProjectDirectory(initialPath) {
    return ipcRenderer.invoke(DESKTOP_PICK_PROJECT_IPC_CHANNEL, initialPath) as Promise<{ path: string }>;
  },

  pickPublishDirectory(initialPath) {
    return ipcRenderer.invoke(DESKTOP_PICK_PUBLISH_IPC_CHANNEL, initialPath) as Promise<{ path: string }>;
  },

  getRuntimeInfo() {
    return ipcRenderer.invoke(DESKTOP_RUNTIME_INFO_IPC_CHANNEL) as Promise<DesktopRuntimeInfo>;
  },

  reportRendererFailure(payload) {
    return ipcRenderer.invoke(DESKTOP_REPORT_FAILURE_IPC_CHANNEL, payload) as Promise<void>;
  },
};

contextBridge.exposeInMainWorld("icaDesktop", desktopBridge);

export type { DesktopBridgeRequestMap };
