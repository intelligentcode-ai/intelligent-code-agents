import { safeErrorMessage } from "./security";

export interface AppUpdateStatus {
  currentVersion: string;
  latestVersion?: string;
  latestReleaseUrl?: string;
  checkedAt: string;
  updateAvailable: boolean;
  error?: string;
}

interface CachedStatus {
  status: AppUpdateStatus;
  expiresAtMs: number;
}

const updateCache = new Map<string, CachedStatus>();

function parseSemver(value: string): [number, number, number] | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)];
}

export function isVersionNewer(candidate: string, current: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) {
    return candidate.trim() !== current.trim();
  }
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

export async function fetchLatestGithubRelease(
  repo = process.env.ICA_RELEASE_REPO || "intelligentcode-ai/intelligent-code-agents",
  timeoutMs = Number(process.env.ICA_RELEASE_CHECK_TIMEOUT_MS || "1200"),
): Promise<{ version: string; url?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ica-installer",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub releases API returned ${response.status}.`);
    }
    const payload = (await response.json()) as { tag_name?: string; html_url?: string; name?: string };
    const rawVersion = String(payload.tag_name || payload.name || "").trim();
    if (!rawVersion) {
      throw new Error("GitHub releases API response did not include a tag name.");
    }
    return {
      version: rawVersion.replace(/^v/i, ""),
      url: payload.html_url,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForAppUpdate(currentVersion: string, force = false): Promise<AppUpdateStatus> {
  const cacheKey = currentVersion.trim() || "unknown";
  const ttlMs = Math.max(60_000, Number(process.env.ICA_RELEASE_CHECK_CACHE_MS || `${10 * 60 * 1000}`));
  const nowMs = Date.now();
  const cached = updateCache.get(cacheKey);
  if (!force && cached && cached.expiresAtMs > nowMs) {
    return cached.status;
  }

  try {
    const latest = await fetchLatestGithubRelease();
    const status: AppUpdateStatus = {
      currentVersion,
      latestVersion: latest.version,
      latestReleaseUrl: latest.url,
      checkedAt: new Date(nowMs).toISOString(),
      updateAvailable: isVersionNewer(latest.version, currentVersion),
    };
    updateCache.set(cacheKey, { status, expiresAtMs: nowMs + ttlMs });
    return status;
  } catch (error) {
    const status: AppUpdateStatus = {
      currentVersion,
      checkedAt: new Date(nowMs).toISOString(),
      updateAvailable: false,
      error: safeErrorMessage(error, "Unable to check for updates."),
    };
    updateCache.set(cacheKey, { status, expiresAtMs: nowMs + ttlMs });
    return status;
  }
}
