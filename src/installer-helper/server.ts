import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hasExecutable } from "../installer-core/security";

const execFileAsync = promisify(execFile);
export const MAX_JSON_BODY_BYTES = 64 * 1024;

type JsonMap = Record<string, unknown>;

export class RequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(res: http.ServerResponse, status: number, payload: JsonMap): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(`${JSON.stringify(payload)}\n`);
}

export function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress);
}

export function helperTokenFromRequest(req: http.IncomingMessage): string {
  const auth = String(req.headers.authorization || "");
  const byHeader = String(req.headers["x-ica-helper-token"] || "");
  if (byHeader) return byHeader;
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return "";
}

export async function readJsonBody(req: http.IncomingMessage): Promise<JsonMap> {
  const contentLength = Number(req.headers["content-length"] || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new RequestError(413, `Request body too large (max ${MAX_JSON_BODY_BYTES} bytes).`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += normalized.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new RequestError(413, `Request body too large (max ${MAX_JSON_BODY_BYTES} bytes).`);
    }
    chunks.push(normalized);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonMap;
  } catch {
    throw new RequestError(400, "Invalid JSON request body.");
  }
}

export async function hasCommand(command: string): Promise<boolean> {
  return hasExecutable(command, process.platform);
}

export function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function pickDirectoryNative(initialPath?: string): Promise<string> {
  if (process.platform === "darwin") {
    const prompt = "Select project directory";
    const safeInitialPath = escapeAppleScriptString(initialPath || process.cwd());
    const script = `POSIX path of (choose folder with prompt "${prompt}" default location POSIX file "${safeInitialPath}")`;
    const result = await execFileAsync("osascript", ["-e", script]);
    const picked = (result.stdout || "").trim();
    if (!picked) throw new Error("No directory selected.");
    return picked.replace(/\/+$/, "");
  }

  if (process.platform === "linux") {
    if (await hasCommand("zenity")) {
      const result = await execFileAsync("zenity", ["--file-selection", "--directory", "--title=Select project directory"]);
      const picked = (result.stdout || "").trim();
      if (!picked) throw new Error("No directory selected.");
      return picked;
    }
    if (await hasCommand("kdialog")) {
      const result = await execFileAsync("kdialog", ["--getexistingdirectory", initialPath || process.cwd()]);
      const picked = (result.stdout || "").trim();
      if (!picked) throw new Error("No directory selected.");
      return picked;
    }
    throw new Error("No native file chooser found (install zenity or kdialog).");
  }

  if (process.platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$dlg.SelectedPath = '${(initialPath || process.cwd()).replace(/'/g, "''")}'`,
      "if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }",
    ].join("; ");
    const result = await execFileAsync("powershell", ["-NoProfile", "-Command", script]);
    const picked = (result.stdout || "").trim();
    if (!picked) throw new Error("No directory selected.");
    return picked;
  }

  throw new Error(`Unsupported platform '${process.platform}' for native picker.`);
}

export async function route(req: http.IncomingMessage, res: http.ServerResponse, token: string): Promise<void> {
  if (!isLoopback(req.socket.remoteAddress)) {
    sendJson(res, 403, { error: "Loopback requests only." });
    return;
  }
  if (helperTokenFromRequest(req) !== token) {
    sendJson(res, 401, { error: "Unauthorized helper token." });
    return;
  }

  if (req.method === "POST" && req.url === "/pick-directory") {
    try {
      if (!String(req.headers["content-type"] || "").toLowerCase().includes("application/json")) {
        throw new RequestError(415, "Unsupported media type: expected application/json.");
      }
      const body = await readJsonBody(req);
      const initialPath = typeof body.initialPath === "string" ? body.initialPath : process.cwd();
      const selected = await pickDirectoryNative(initialPath);
      sendJson(res, 200, { path: selected });
    } catch (error) {
      if (error instanceof RequestError) {
        sendJson(res, error.status, { error: error.message });
      } else {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, platform: process.platform });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function main(): Promise<void> {
  const port = Number(process.env.ICA_HELPER_PORT || "4174");
  const host = "127.0.0.1";
  const token = process.env.ICA_HELPER_TOKEN || "";
  if (!token) {
    throw new Error("ICA_HELPER_TOKEN is required.");
  }

  const server = http.createServer((req, res) => {
    route(req, res, token).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  server.listen(port, host, () => {
    process.stdout.write(`ICA helper listening at http://${host}:${port}\n`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`ICA helper failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
