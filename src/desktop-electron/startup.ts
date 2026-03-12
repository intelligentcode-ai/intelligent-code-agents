import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_DESKTOP_DEV_URL = "http://127.0.0.1:4173";

export interface DesktopStartupLogger {
  error(message?: unknown, ...args: unknown[]): void;
}

export interface DesktopLoadFailureDetails {
  attemptedUrl: string;
  failingUrl: string;
  reason: string;
}

export interface DesktopWindowDiagnosticsTarget {
  loadURL(url: string): Promise<void>;
  webContents: {
    on(event: "did-fail-load", listener: (event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => unknown): unknown;
    on(event: "render-process-gone", listener: (event: unknown, details: { reason: string; exitCode: number }) => unknown): unknown;
  };
}

export function resolveDesktopStartUrl(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicitStartUrl = (env.ICA_DESKTOP_START_URL || "").trim();
  if (explicitStartUrl) {
    return explicitStartUrl;
  }

  const mode = (env.ICA_DESKTOP_MODE || "").trim().toLowerCase();
  if (mode === "dev") {
    const devUrl = (env.ICA_DESKTOP_DEV_URL || "").trim();
    return devUrl || DEFAULT_DESKTOP_DEV_URL;
  }

  const dashboardPath = path.resolve(repoRoot, "dist/installer-dashboard/web-build/index.html");
  return pathToFileURL(dashboardPath).toString();
}

export function renderDesktopLoadFailureHtml(details: DesktopLoadFailureDetails): string {
  const reason = escapeHtml(details.reason);
  const attemptedUrl = escapeHtml(details.attemptedUrl);
  const failingUrl = escapeHtml(details.failingUrl);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ICA Desktop Load Failure</title>
    <style>
      :root {
        color-scheme: light;
      }
      body {
        margin: 0;
        font-family: "SF Pro Text", "Segoe UI", sans-serif;
        background: radial-gradient(circle at top right, #eef5ff 0%, #ffffff 65%);
        color: #162032;
      }
      main {
        max-width: 920px;
        margin: 48px auto;
        padding: 24px;
        border-radius: 16px;
        background: #ffffff;
        box-shadow: 0 14px 42px rgba(19, 42, 79, 0.12);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 30px;
      }
      p {
        line-height: 1.6;
      }
      code {
        display: block;
        margin: 12px 0;
        padding: 12px;
        border-radius: 10px;
        background: #f4f7fb;
        word-break: break-all;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Desktop Renderer Failed to Load</h1>
      <p>The dashboard did not boot successfully in Electron. Review the failing URL and reason below.</p>
      <p><strong>Attempted URL</strong></p>
      <code>${attemptedUrl}</code>
      <p><strong>Failing URL</strong></p>
      <code>${failingUrl}</code>
      <p><strong>Reason</strong></p>
      <code>${reason}</code>
    </main>
  </body>
</html>`;
}

export async function showDesktopLoadFailure(
  target: DesktopWindowDiagnosticsTarget,
  details: DesktopLoadFailureDetails,
  logger: DesktopStartupLogger = console,
): Promise<void> {
  const html = renderDesktopLoadFailureHtml(details);
  const payload = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  try {
    await target.loadURL(payload);
  } catch (error) {
    logger.error("[desktop] Unable to render desktop failure diagnostics page.", error);
  }
}

export function installDesktopLoadDiagnostics(
  target: DesktopWindowDiagnosticsTarget,
  attemptedUrl: string,
  logger: DesktopStartupLogger = console,
): void {
  target.webContents.on("did-fail-load", async (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) {
      return;
    }
    const reason = `${errorDescription} (${errorCode})`;
    logger.error(`[desktop] Renderer load failed for '${validatedURL}' while opening '${attemptedUrl}': ${reason}`);
    await showDesktopLoadFailure(
      target,
      {
        attemptedUrl,
        failingUrl: validatedURL || attemptedUrl,
        reason,
      },
      logger,
    );
  });

  target.webContents.on("render-process-gone", async (_event, details) => {
    const reason = `Renderer process terminated: ${details.reason} (exit code ${details.exitCode}).`;
    logger.error(`[desktop] ${reason}`);
    await showDesktopLoadFailure(
      target,
      {
        attemptedUrl,
        failingUrl: attemptedUrl,
        reason,
      },
      logger,
    );
  });
}

export function normalizeStartupErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
