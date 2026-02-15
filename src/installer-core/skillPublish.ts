import path from "node:path";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CredentialProvider } from "./credentials";
import { ensureDir, pathExists, removePath } from "./fs";
import { assertPathWithin } from "./security";
import { withHttpsCredential } from "./sourceAuth";
import { detectGitProvider as detectProviderFromSource, getSourceWorkspaceRepoPath, loadSources, OFFICIAL_SOURCE_ID } from "./sources";
import { GitProvider, PublishMode, PublishRequest, PublishResult, SkillBundleInput, SkillSource, ValidationProfile, ValidationResult } from "./types";

const execFileAsync = promisify(execFile);
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_SIZE_BYTES = 20 * 1024 * 1024;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

const BLOCKED_FILE_NAMES = new Set([".ds_store", "thumbs.db", "id_rsa", "id_dsa"]);
const BLOCKED_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".crt"]);
const SECRET_PATTERNS: RegExp[] = [
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z\-_]{20,}\b/,
  /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/i,
  /(token|password|secret|api[-_ ]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-\/+=]{8,}/i,
];

function parseFrontmatter(content: string): { hasFrontmatter: boolean; fields: Record<string, string> } {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { hasFrontmatter: false, fields: {} };

  const map: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) map[key] = value;
  }
  return { hasFrontmatter: true, fields: map };
}

function nowStamp(): string {
  const now = new Date();
  const parts = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
  ];
  return parts.join("");
}

function normalizeGitError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function looksLikeTextFile(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  if (!extension) return true;
  const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".zip", ".gz", ".tgz", ".pdf", ".woff", ".woff2"]);
  return !binaryExtensions.has(extension);
}

function parseMarkdownLinks(markdown: string): string[] {
  const links: string[] = [];
  const re = /\[[^\]]+]\(([^)]+)\)/g;
  let match: RegExpExecArray | null = re.exec(markdown);
  while (match) {
    links.push(match[1].trim());
    match = re.exec(markdown);
  }
  return links;
}

function shouldSkipFromCopy(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".git" || lower === ".ds_store" || lower === "thumbs.db") return true;
  if (lower === "__pycache__") return true;
  if (lower.startsWith(".env")) return true;
  if (BLOCKED_FILE_NAMES.has(lower)) return true;
  return false;
}

function isBlockedFile(relativePath: string): boolean {
  const base = path.basename(relativePath).toLowerCase();
  if (BLOCKED_FILE_NAMES.has(base)) return true;
  if (base.startsWith(".env")) return true;
  if (BLOCKED_EXTENSIONS.has(path.extname(base))) return true;
  return false;
}

export function sanitizeSkillName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
}

export function detectGitProvider(repoUrl: string): GitProvider {
  return detectProviderFromSource(repoUrl);
}

interface BundleScanResult {
  detectedFiles: string[];
  topLevelDirectories: Set<string>;
  totalBytes: number;
  errors: string[];
  warnings: string[];
}

async function scanBundle(rootPath: string): Promise<BundleScanResult> {
  const detectedFiles = new Set<string>();
  const topLevelDirectories = new Set<string>();
  let totalBytes = 0;
  const errors: string[] = [];
  const warnings: string[] = [];

  const walk = async (current: string): Promise<void> => {
    const entries = (await fsp.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(rootPath, absolute).replace(/\\/g, "/");
      const lowerName = entry.name.toLowerCase();
      if (relative) {
        const [first] = relative.split("/", 1);
        if (first) topLevelDirectories.add(first);
      }

      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) {
        const target = await fsp.realpath(absolute);
        try {
          assertPathWithin(rootPath, target);
        } catch {
          errors.push(`Symlink escape blocked: '${relative}' points outside bundle root.`);
          continue;
        }
        warnings.push(`Symlink '${relative}' is ignored during publish for safety.`);
        continue;
      }

      if (entry.isDirectory()) {
        if (shouldSkipFromCopy(lowerName)) continue;
        await walk(absolute);
        continue;
      }

      if (!entry.isFile()) continue;
      if (shouldSkipFromCopy(lowerName)) continue;

      detectedFiles.add(relative);
      totalBytes += stat.size;
      if (stat.size > MAX_FILE_SIZE_BYTES) {
        errors.push(`File '${relative}' exceeds max file size (${MAX_FILE_SIZE_BYTES} bytes).`);
      }

      if (isBlockedFile(relative)) {
        errors.push(`Blocked file pattern detected: '${relative}'.`);
      }

      if (looksLikeTextFile(absolute) && stat.size <= 256 * 1024) {
        const content = await fsp.readFile(absolute, "utf8").catch(() => "");
        if (content) {
          for (const pattern of SECRET_PATTERNS) {
            if (pattern.test(content)) {
              errors.push(`Potential secret detected in '${relative}'.`);
              break;
            }
          }
        }
      }
    }
  };

  await walk(rootPath);
  if (totalBytes > MAX_BUNDLE_SIZE_BYTES) {
    errors.push(`Bundle exceeds max total size (${MAX_BUNDLE_SIZE_BYTES} bytes).`);
  }

  return {
    detectedFiles: Array.from(detectedFiles).sort((a, b) => a.localeCompare(b)),
    topLevelDirectories,
    totalBytes,
    errors,
    warnings,
  };
}

function defaultSkillName(bundlePath: string, frontmatterName?: string): string {
  const raw = frontmatterName || path.basename(bundlePath);
  return raw.trim();
}

function validateRequiredFrontmatter(fields: Record<string, string>, required: string[]): string[] {
  const errors: string[] = [];
  for (const key of required) {
    if (!fields[key] || !fields[key].trim()) {
      errors.push(`Missing required frontmatter field: '${key}'.`);
    }
  }
  return errors;
}

function extractSkillName(bundle: SkillBundleInput, frontmatterFields: Record<string, string>): string {
  return (bundle.skillName || defaultSkillName(bundle.localPath, frontmatterFields.name)).trim();
}

export async function validateSkillBundle(bundle: SkillBundleInput, profile: ValidationProfile): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const localPath = path.resolve(bundle.localPath);

  if (!(await pathExists(localPath))) {
    return {
      profile,
      errors: [`Bundle path not found: '${localPath}'.`],
      warnings,
      detectedFiles: [],
    };
  }

  const stat = await fsp.lstat(localPath);
  if (!stat.isDirectory()) {
    return {
      profile,
      errors: [`Bundle path must be a directory: '${localPath}'.`],
      warnings,
      detectedFiles: [],
    };
  }

  const skillFile = path.join(localPath, "SKILL.md");
  if (!(await pathExists(skillFile))) {
    errors.push("Missing required file: SKILL.md");
    return {
      profile,
      errors,
      warnings,
      detectedFiles: [],
    };
  }

  const skillContent = await fsp.readFile(skillFile, "utf8");
  const frontmatter = parseFrontmatter(skillContent);
  const candidateName = extractSkillName(bundle, frontmatter.fields);
  const sanitized = sanitizeSkillName(candidateName);
  if (!sanitized) {
    errors.push(`Invalid skill name '${candidateName}'. Use lowercase letters, numbers, and dashes.`);
  } else if (candidateName !== sanitized) {
    errors.push(`Invalid skill name '${candidateName}'. Suggested normalized name: '${sanitized}'.`);
  }

  const scan = await scanBundle(localPath);
  errors.push(...scan.errors);
  warnings.push(...scan.warnings);

  if (profile === "personal") {
    for (const field of ["name", "description", "category", "version"]) {
      if (!frontmatter.fields[field] || !frontmatter.fields[field].trim()) {
        warnings.push(`Optional frontmatter field '${field}' is missing.`);
      }
    }
    const knownRoots = new Set(["SKILL.md", "scripts", "references", "assets", "README.md"]);
    for (const dir of scan.topLevelDirectories) {
      if (!knownRoots.has(dir)) {
        warnings.push(`Nonstandard top-level entry '${dir}' found in skill bundle.`);
      }
    }
  }

  if (profile === "official") {
    if (!frontmatter.hasFrontmatter) {
      errors.push("Official contribution requires YAML frontmatter in SKILL.md.");
    }
    errors.push(...validateRequiredFrontmatter(frontmatter.fields, ["name", "description", "category", "version"]));

    const links = parseMarkdownLinks(skillContent);
    for (const target of links) {
      const clean = target.split("#", 1)[0].trim();
      if (!clean || clean.startsWith("http://") || clean.startsWith("https://") || clean.startsWith("mailto:")) continue;
      if (clean.startsWith("/")) {
        errors.push(`Broken SKILL.md link '${target}': absolute paths are not allowed.`);
        continue;
      }
      const resolved = path.resolve(localPath, clean);
      try {
        assertPathWithin(localPath, resolved);
      } catch {
        errors.push(`Broken SKILL.md link '${target}': path escapes skill bundle root.`);
        continue;
      }
      if (!(await pathExists(resolved))) {
        errors.push(`Broken SKILL.md link '${target}': target does not exist.`);
      }
    }
  }

  return {
    profile,
    errors: Array.from(new Set(errors)),
    warnings: Array.from(new Set(warnings)),
    detectedFiles: Array.from(new Set(["SKILL.md", ...scan.detectedFiles])).sort((a, b) => a.localeCompare(b)),
  };
}

async function runGit(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return (result.stdout || "").trim();
}

async function hasRemoteBranch(repoPath: string, branch: string): Promise<boolean> {
  try {
    await runGit(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], repoPath);
    return true;
  } catch {
    return false;
  }
}

async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const value = await runGit(["rev-parse", "--abbrev-ref", "origin/HEAD"], repoPath);
    if (value.startsWith("origin/")) {
      return value.slice("origin/".length);
    }
  } catch {
    // fall through
  }
  if (await hasRemoteBranch(repoPath, "main")) return "main";
  return "master";
}

function repoSkillsRoot(repoPath: string, skillsRoot: string): string {
  return path.join(repoPath, skillsRoot.replace(/^\/+/, ""));
}

async function copyBundleForPublish(sourceRoot: string, destinationRoot: string): Promise<void> {
  await removePath(destinationRoot);
  await ensureDir(destinationRoot);

  const walk = async (current: string): Promise<void> => {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldSkipFromCopy(entry.name)) continue;
      const from = path.join(current, entry.name);
      const to = path.join(destinationRoot, path.relative(sourceRoot, from));
      const stat = await fsp.lstat(from);

      if (stat.isSymbolicLink()) {
        const target = await fsp.realpath(from);
        assertPathWithin(sourceRoot, target);
        continue;
      }

      if (entry.isDirectory()) {
        await ensureDir(to);
        await walk(from);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isBlockedFile(path.relative(sourceRoot, from))) continue;

      await ensureDir(path.dirname(to));
      await fsp.copyFile(from, to);
    }
  };

  await walk(sourceRoot);
}

interface GithubRepoRef {
  owner: string;
  repo: string;
}

function parseGithubRepo(repoUrl: string): GithubRepoRef | null {
  const trimmed = repoUrl.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  const sshUrlMatch = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshUrlMatch) {
    return { owner: sshUrlMatch[1], repo: sshUrlMatch[2] };
  }
  return null;
}

async function githubRequest<T>(token: string, method: string, pathname: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ica-skill-publisher",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${method} ${pathname} failed (${response.status}): ${text}`);
  }
  return (await response.json()) as T;
}

function buildCompareUrl(source: SkillSource, baseBranch: string, branch: string): string | undefined {
  const trimmed = source.repoUrl.replace(/\.git$/i, "");
  if (source.providerHint === "github") {
    const parsed = parseGithubRepo(source.repoUrl);
    if (!parsed) return undefined;
    return `https://github.com/${parsed.owner}/${parsed.repo}/compare/${baseBranch}...${branch}?expand=1`;
  }
  if (source.providerHint === "gitlab") {
    const match = trimmed.match(/gitlab\.com\/([^/]+)\/(.+)$/i);
    if (!match) return undefined;
    return `https://gitlab.com/${match[1]}/${match[2]}/-/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branch)}`;
  }
  if (source.providerHint === "bitbucket") {
    const match = trimmed.match(/bitbucket\.org\/([^/]+)\/(.+)$/i);
    if (!match) return undefined;
    return `https://bitbucket.org/${match[1]}/${match[2]}/pull-requests/new?source=${encodeURIComponent(branch)}&dest=${encodeURIComponent(baseBranch)}`;
  }
  return undefined;
}

async function createGithubPrSameRepo(
  source: SkillSource,
  token: string,
  branch: string,
  baseBranch: string,
  title: string,
  body: string,
): Promise<string | undefined> {
  const repo = parseGithubRepo(source.repoUrl);
  if (!repo) return undefined;
  try {
    const result = await githubRequest<{ html_url?: string }>(token, "POST", `/repos/${repo.owner}/${repo.repo}/pulls`, {
      title,
      head: branch,
      base: baseBranch,
      body,
    });
    return result.html_url;
  } catch {
    return undefined;
  }
}

async function ensureGitRemote(repoPath: string, remoteName: string, remoteUrl: string): Promise<void> {
  try {
    await runGit(["remote", "set-url", remoteName, remoteUrl], repoPath);
  } catch {
    await runGit(["remote", "add", remoteName, remoteUrl], repoPath);
  }
}

async function waitForForkReady(forkUrl: string, repoPath: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await runGit(["ls-remote", "--heads", forkUrl], repoPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

async function createGithubForkPr(
  source: SkillSource,
  token: string,
  repoPath: string,
  branch: string,
  baseBranch: string,
  title: string,
  body: string,
): Promise<{ pushedRemote: string; prUrl?: string; compareUrl?: string }> {
  const upstream = parseGithubRepo(source.repoUrl);
  if (!upstream) {
    return { pushedRemote: "origin", compareUrl: buildCompareUrl(source, baseBranch, branch) };
  }
  const me = await githubRequest<{ login: string }>(token, "GET", "/user");
  try {
    await githubRequest<Record<string, unknown>>(token, "POST", `/repos/${upstream.owner}/${upstream.repo}/forks`);
  } catch {
    // Existing fork or restricted endpoint; continue.
  }

  const forkHttps = `https://github.com/${me.login}/${upstream.repo}.git`;
  const forkAuth = withHttpsCredential(forkHttps, token);
  await waitForForkReady(forkAuth, repoPath);
  await ensureGitRemote(repoPath, "fork", forkAuth);

  await runGit(["push", "-u", "fork", branch], repoPath);
  await ensureGitRemote(repoPath, "fork", forkHttps);

  const result = await githubRequest<{ html_url?: string }>(token, "POST", `/repos/${upstream.owner}/${upstream.repo}/pulls`, {
    title,
    head: `${me.login}:${branch}`,
    base: baseBranch,
    body,
  });
  return {
    pushedRemote: "fork",
    prUrl: result.html_url,
    compareUrl: result.html_url ? undefined : buildCompareUrl(source, baseBranch, branch),
  };
}

interface WorkspaceResult {
  repoPath: string;
  baseBranch: string;
  authRemoteUrl: string;
  plainRemoteUrl: string;
}

async function prepareWorkspace(source: SkillSource, credentials: CredentialProvider, forceBaseBranch?: string): Promise<WorkspaceResult> {
  const repoPath = getSourceWorkspaceRepoPath(source.id);
  await ensureDir(path.dirname(repoPath));
  const hasRepo = await pathExists(path.join(repoPath, ".git"));
  const token = source.transport === "https" ? await credentials.get(source.id) : null;
  const authRemoteUrl = source.transport === "https" && token ? withHttpsCredential(source.repoUrl, token) : source.repoUrl;
  const plainRemoteUrl = source.repoUrl;

  if (!hasRepo) {
    await runGit(["clone", authRemoteUrl, repoPath], path.dirname(repoPath));
  } else {
    await ensureGitRemote(repoPath, "origin", authRemoteUrl);
    await runGit(["fetch", "--all", "--prune"], repoPath);
  }
  await ensureGitRemote(repoPath, "origin", plainRemoteUrl);

  const configuredBase = (forceBaseBranch || source.defaultBaseBranch || "").trim();
  const baseBranch = configuredBase || (source.official ? "dev" : "main");
  const checkoutBranch = (await hasRemoteBranch(repoPath, baseBranch)) ? baseBranch : await detectDefaultBranch(repoPath);
  await runGit(["checkout", "-f", checkoutBranch], repoPath);
  await runGit(["reset", "--hard", `origin/${checkoutBranch}`], repoPath);

  return {
    repoPath,
    baseBranch: checkoutBranch,
    authRemoteUrl,
    plainRemoteUrl,
  };
}

async function resolveSource(sourceId: string): Promise<SkillSource> {
  const source = (await loadSources()).find((item) => item.id === sourceId);
  if (!source) {
    throw new Error(`Unknown source '${sourceId}'.`);
  }
  if (!source.enabled) {
    throw new Error(`Source '${sourceId}' is disabled.`);
  }
  return source;
}

interface PublishInternalOptions {
  validationProfile: ValidationProfile;
  forceMode?: PublishMode;
  forceBaseBranch?: string;
  officialContribution?: boolean;
}

async function publishInternal(
  source: SkillSource,
  request: PublishRequest,
  credentials: CredentialProvider,
  options: PublishInternalOptions,
): Promise<PublishResult> {
  const validation = await validateSkillBundle(request.bundle, options.validationProfile);
  if (validation.errors.length > 0) {
    throw new Error(`Bundle validation failed:\n- ${validation.errors.join("\n- ")}`);
  }

  const skillFile = path.join(path.resolve(request.bundle.localPath), "SKILL.md");
  const frontmatter = parseFrontmatter(await fsp.readFile(skillFile, "utf8"));
  const sourceName = extractSkillName(request.bundle, frontmatter.fields);
  const skillName = sanitizeSkillName(sourceName);
  const mode = options.forceMode || source.publishDefaultMode;
  const workspace = await prepareWorkspace(source, credentials, options.forceBaseBranch);

  try {
    const skillRoot = repoSkillsRoot(workspace.repoPath, source.skillsRoot);
    const destination = path.join(skillRoot, skillName);
    await ensureDir(skillRoot);

    const branch = mode === "direct-push" ? workspace.baseBranch : `skill/${skillName}/${nowStamp()}`;
    if (mode === "direct-push") {
      await runGit(["checkout", "-f", workspace.baseBranch], workspace.repoPath);
      await runGit(["reset", "--hard", `origin/${workspace.baseBranch}`], workspace.repoPath);
    } else {
      await runGit(["checkout", "-B", branch, workspace.baseBranch], workspace.repoPath);
    }

    await copyBundleForPublish(path.resolve(request.bundle.localPath), destination);
    await runGit(["add", path.join(source.skillsRoot.replace(/^\/+/, ""), skillName)], workspace.repoPath);
    await runGit(["add", "-A"], workspace.repoPath);

    let hasChanges = true;
    try {
      await runGit(["diff", "--cached", "--quiet"], workspace.repoPath);
      hasChanges = false;
    } catch {
      hasChanges = true;
    }
    if (!hasChanges) {
      throw new Error("No skill changes detected to publish.");
    }

    const commitMessage = request.commitMessage?.trim() || `feat(skill): publish ${skillName}`;
    await runGit(
      ["-c", "user.name=ICA Skill Publisher", "-c", "user.email=ica-skill-publisher@local", "commit", "-m", commitMessage],
      workspace.repoPath,
    );
    const commitSha = await runGit(["rev-parse", "HEAD"], workspace.repoPath);

    await ensureGitRemote(workspace.repoPath, "origin", workspace.authRemoteUrl);
    let pushedRemote = "origin";
    let prUrl: string | undefined;
    let compareUrl: string | undefined;

    if (mode === "direct-push") {
      await runGit(["push", "origin", workspace.baseBranch], workspace.repoPath);
    } else if (mode === "branch-only") {
      await runGit(["push", "-u", "origin", branch], workspace.repoPath);
    } else if (options.officialContribution) {
      const token = source.transport === "https" ? await credentials.get(source.id) : null;
      if (source.providerHint === "github" && token) {
        const contribution = await createGithubForkPr(
          source,
          token,
          workspace.repoPath,
          branch,
          workspace.baseBranch,
          `Add skill: ${skillName}`,
          `Adds the \`${skillName}\` skill bundle via ICA contribution flow.`,
        );
        pushedRemote = contribution.pushedRemote;
        prUrl = contribution.prUrl;
        compareUrl = contribution.compareUrl;
      } else {
        await runGit(["push", "-u", "origin", branch], workspace.repoPath);
        compareUrl = buildCompareUrl(source, workspace.baseBranch, branch);
      }
    } else {
      await runGit(["push", "-u", "origin", branch], workspace.repoPath);
      const token = source.transport === "https" ? await credentials.get(source.id) : null;
      if (source.providerHint === "github" && token) {
        prUrl = await createGithubPrSameRepo(
          source,
          token,
          branch,
          workspace.baseBranch,
          `Publish skill: ${skillName}`,
          `Publishes \`${skillName}\` from ICA skill publishing workflow.`,
        );
      }
      compareUrl = prUrl ? undefined : buildCompareUrl(source, workspace.baseBranch, branch);
    }

    return {
      mode,
      branch,
      commitSha,
      pushedRemote,
      prUrl,
      compareUrl,
    };
  } catch (error) {
    throw new Error(`Publish failed for source '${source.id}': ${normalizeGitError(error)}`);
  } finally {
    try {
      await ensureGitRemote(workspace.repoPath, "origin", workspace.plainRemoteUrl);
    } catch {
      // ignore remote reset failures
    }
  }
}

export async function publishSkillBundle(request: PublishRequest, credentials: CredentialProvider): Promise<PublishResult> {
  const source = await resolveSource(request.sourceId);
  const overrideMode = request.overrideMode;
  const forceMode =
    overrideMode === "direct-push" || overrideMode === "branch-only" || overrideMode === "branch-pr" ? overrideMode : undefined;
  return publishInternal(source, request, credentials, {
    validationProfile: "personal",
    forceMode,
    forceBaseBranch: request.overrideBaseBranch?.trim() || undefined,
  });
}

export async function contributeOfficialSkillBundle(
  input: { bundle: SkillBundleInput; sourceId?: string; commitMessage?: string },
  credentials: CredentialProvider,
): Promise<PublishResult> {
  const allSources = await loadSources();
  const source =
    (input.sourceId ? allSources.find((item) => item.id === input.sourceId) : undefined) ||
    allSources.find((item) => item.id === OFFICIAL_SOURCE_ID) ||
    allSources.find((item) => item.officialContributionEnabled);
  if (!source) {
    throw new Error("No official contribution source configured.");
  }
  if (!source.officialContributionEnabled) {
    throw new Error(`Source '${source.id}' is not enabled for official contributions.`);
  }

  return publishInternal(
    source,
    {
      sourceId: source.id,
      bundle: input.bundle,
      commitMessage: input.commitMessage,
    },
    credentials,
    {
      validationProfile: "official",
      forceMode: "branch-pr",
      forceBaseBranch: source.defaultBaseBranch || "dev",
      officialContribution: true,
    },
  );
}
