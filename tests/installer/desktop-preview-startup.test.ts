import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installDesktopLoadDiagnostics, resolveDesktopStartUrl } from "../../src/desktop-electron/startup";

interface FakeWebContents {
  on(
    event: "did-fail-load",
    listener: (event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => unknown,
  ): void;
  on(
    event: "render-process-gone",
    listener: (event: unknown, details: { reason: string; exitCode: number }) => unknown,
  ): void;
}

interface FakeWindow {
  webContents: FakeWebContents;
  loadURL: (url: string) => Promise<void>;
}

test("desktop startup defaults to built dashboard bundle file URL and supports explicit override", () => {
  const repoRoot = path.resolve(process.cwd());
  const builtTarget = resolveDesktopStartUrl(repoRoot, {});

  assert.equal(fileURLToPath(builtTarget), path.join(repoRoot, "dist/installer-dashboard/web-build/index.html"));
  assert.equal(resolveDesktopStartUrl(repoRoot, { ICA_DESKTOP_START_URL: "http://127.0.0.1:4173" }), "http://127.0.0.1:4173");
});

test("desktop startup scripts exist for built and dev preview modes", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const scripts = packageJson.scripts || {};

  assert.equal(typeof scripts["start:desktop"], "string");
  assert.equal(typeof scripts["start:desktop:dev"], "string");
});

test("desktop BrowserWindow disables sandbox so preload bridge can expose window.icaDesktop", () => {
  const mainSource = fs.readFileSync(path.resolve(process.cwd(), "src/desktop-electron/main.ts"), "utf8");
  assert.match(mainSource, /sandbox:\s*false/);
});

test("desktop load diagnostics present a readable fallback when renderer load fails", async () => {
  const events = new Map<string, unknown>();
  const loads: string[] = [];
  const errors: string[] = [];

  const fakeWindow: FakeWindow = {
    webContents: {
      on(
        event: "did-fail-load" | "render-process-gone",
        listener:
          | ((event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => unknown)
          | ((event: unknown, details: { reason: string; exitCode: number }) => unknown),
      ) {
        events.set(event, listener);
      },
    },
    async loadURL(url: string) {
      loads.push(url);
    },
  };

  installDesktopLoadDiagnostics(fakeWindow, "file:///broken/index.html", {
    error(message?: unknown, ...args: unknown[]) {
      errors.push([message, ...args].map((value) => String(value)).join(" "));
    },
  });

  const didFailLoad = events.get("did-fail-load") as
    | ((event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => Promise<unknown> | unknown)
    | undefined;
  assert.equal(typeof didFailLoad, "function");
  await didFailLoad?.({}, -6, "ERR_FILE_NOT_FOUND", "file:///broken/index.html", true);

  assert.equal(loads.length, 1, "Diagnostics should replace blank window with an inline error page.");
  const decoded = decodeURIComponent(loads[0]);
  assert.match(decoded, /Desktop Renderer Failed to Load/);
  assert.match(decoded, /ERR_FILE_NOT_FOUND/);
  assert.match(decoded, /file:\/\/\/broken\/index\.html/);
  assert.match(errors.join("\n"), /ERR_FILE_NOT_FOUND/);
});
