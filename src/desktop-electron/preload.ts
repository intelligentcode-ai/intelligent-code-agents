import { contextBridge, ipcRenderer } from "electron";
import {
  CONTROL_PLANE_IPC_CHANNEL,
  REALTIME_EVENT_CHANNEL,
  REALTIME_SUBSCRIBE_CHANNEL,
  REALTIME_UNSUBSCRIBE_CHANNEL,
  type DesktopBridgeApi,
  type DesktopBridgeRequestMap,
  type DesktopBridgeResponseMap,
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
};

contextBridge.exposeInMainWorld("icaDesktop", desktopBridge);

export type { DesktopBridgeRequestMap };
