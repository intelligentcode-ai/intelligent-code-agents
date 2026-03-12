declare module "electron" {
  export interface WebContents {
    id: number;
    send(channel: string, ...args: unknown[]): void;
    on(event: "destroyed", listener: () => void): this;
    on(
      event: "did-fail-load",
      listener: (
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean,
      ) => unknown,
    ): this;
    on(
      event: "render-process-gone",
      listener: (
        event: unknown,
        details: { reason: string; exitCode: number },
      ) => unknown,
    ): this;
    isDestroyed(): boolean;
  }

  export interface BrowserWindowConstructorOptions {
    width?: number;
    height?: number;
    show?: boolean;
    webPreferences?: {
      preload?: string;
      contextIsolation?: boolean;
      nodeIntegration?: boolean;
      sandbox?: boolean;
    };
  }

  export class BrowserWindow {
    constructor(options?: BrowserWindowConstructorOptions);
    loadURL(url: string): Promise<void>;
    webContents: WebContents;
  }

  export interface IpcMainEvent {
    sender: WebContents;
  }

  export interface IpcRendererEvent {}

  export const app: {
    whenReady(): Promise<void>;
    on(event: "window-all-closed" | "activate", listener: () => void): void;
    quit(): void;
  };

  export const ipcMain: {
    handle(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => unknown): void;
    on(channel: string, listener: (event: IpcMainEvent, ...args: any[]) => void): void;
    removeHandler(channel: string): void;
    removeAllListeners(channel?: string): void;
  };

  export const ipcRenderer: {
    invoke(channel: string, ...args: any[]): Promise<any>;
    on(channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void): void;
    off(channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void): void;
    send(channel: string, ...args: any[]): void;
  };

  export const contextBridge: {
    exposeInMainWorld(key: string, api: unknown): void;
  };
}
