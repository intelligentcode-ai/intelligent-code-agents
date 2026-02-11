import crypto from "node:crypto";
import path from "node:path";

export function assertPathWithin(basePath: string, candidatePath: string): void {
  const resolvedBase = path.resolve(basePath);
  const resolvedCandidate = path.resolve(candidatePath);
  if (resolvedCandidate !== resolvedBase && !resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error(`Path escape blocked: ${candidatePath}`);
  }
}

export function redactSensitive(input: string): string {
  return input.replace(/(token|password|secret|key)\s*[=:]\s*[^\s]+/gi, "$1=<redacted>");
}

export async function verifyChecksum(content: Buffer, expectedSha256: string): Promise<boolean> {
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  return hash.toLowerCase() === expectedSha256.toLowerCase();
}
