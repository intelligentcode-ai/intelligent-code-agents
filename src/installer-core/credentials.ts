import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureDir, pathExists, readText, writeText } from "./fs";
import { hasExecutable, safeErrorMessage } from "./security";
import { getIcaStateRoot } from "./sources";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "ica-source-credentials";

export interface CredentialProvider {
  store(sourceId: string, secret: string): Promise<void>;
  get(sourceId: string): Promise<string | null>;
  delete(sourceId: string): Promise<void>;
}

function credentialsFilePath(): string {
  return path.join(getIcaStateRoot(), "credentials.enc.json");
}

function keyFilePath(): string {
  return path.join(getIcaStateRoot(), "credentials.key");
}

async function getOrCreateEncryptionKey(): Promise<Buffer> {
  const keyPath = keyFilePath();
  if (await pathExists(keyPath)) {
    const encoded = (await readText(keyPath)).trim();
    if (!encoded) {
      throw new Error("Credential key file is empty.");
    }
    return Buffer.from(encoded, "base64");
  }

  const key = crypto.randomBytes(32);
  await ensureDir(path.dirname(keyPath));
  await writeText(keyPath, `${key.toString("base64")}\n`);
  return key;
}

function encryptObject(payload: Record<string, string>, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptObject(blob: string, key: Buffer): Record<string, string> {
  if (!blob.trim()) return {};
  const packed = Buffer.from(blob, "base64");
  if (packed.length < 29) return {};

  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const encrypted = packed.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  return JSON.parse(decrypted) as Record<string, string>;
}

class EncryptedFileCredentialProvider implements CredentialProvider {
  private async readAll(): Promise<Record<string, string>> {
    const filePath = credentialsFilePath();
    if (!(await pathExists(filePath))) {
      return {};
    }
    const raw = JSON.parse(await readText(filePath)) as { payload?: string };
    const key = await getOrCreateEncryptionKey();
    return decryptObject(raw.payload || "", key);
  }

  private async writeAll(data: Record<string, string>): Promise<void> {
    const key = await getOrCreateEncryptionKey();
    const filePath = credentialsFilePath();
    await ensureDir(path.dirname(filePath));
    const payload = encryptObject(data, key);
    await writeText(filePath, `${JSON.stringify({ payload }, null, 2)}\n`);
  }

  async store(sourceId: string, secret: string): Promise<void> {
    const current = await this.readAll();
    current[sourceId] = secret;
    await this.writeAll(current);
  }

  async get(sourceId: string): Promise<string | null> {
    const current = await this.readAll();
    return current[sourceId] || null;
  }

  async delete(sourceId: string): Promise<void> {
    const current = await this.readAll();
    if (Object.prototype.hasOwnProperty.call(current, sourceId)) {
      delete current[sourceId];
      await this.writeAll(current);
    }
  }
}

class KeychainCredentialProvider implements CredentialProvider {
  private enabled: boolean;

  constructor() {
    this.enabled = os.platform() === "darwin";
  }

  private async hasCommand(command: string): Promise<boolean> {
    return hasExecutable(command, os.platform());
  }

  private async ensureAvailable(): Promise<boolean> {
    if (!this.enabled) return false;
    return this.hasCommand("security");
  }

  async store(sourceId: string, secret: string): Promise<void> {
    if (!(await this.ensureAvailable())) {
      throw new Error("keychain unavailable");
    }

    try {
      await execFileAsync("security", [
        "add-generic-password",
        "-U",
        "-a",
        sourceId,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
        secret,
      ]);
    } catch (error) {
      throw new Error(`Keychain store failed: ${safeErrorMessage(error)}`);
    }
  }

  async get(sourceId: string): Promise<string | null> {
    if (!(await this.ensureAvailable())) {
      return null;
    }

    try {
      const result = await execFileAsync("security", ["find-generic-password", "-a", sourceId, "-s", KEYCHAIN_SERVICE, "-w"]);
      const output = (result.stdout || "").trim();
      return output || null;
    } catch {
      return null;
    }
  }

  async delete(sourceId: string): Promise<void> {
    if (!(await this.ensureAvailable())) {
      return;
    }

    try {
      await execFileAsync("security", ["delete-generic-password", "-a", sourceId, "-s", KEYCHAIN_SERVICE]);
    } catch {
      // Ignore absent credentials.
    }
  }
}

class CompositeCredentialProvider implements CredentialProvider {
  constructor(
    private readonly primary: CredentialProvider,
    private readonly fallback: CredentialProvider,
  ) {}

  async store(sourceId: string, secret: string): Promise<void> {
    try {
      await this.primary.store(sourceId, secret);
      return;
    } catch {
      await this.fallback.store(sourceId, secret);
    }
  }

  async get(sourceId: string): Promise<string | null> {
    const primary = await this.primary.get(sourceId);
    if (primary) return primary;
    return this.fallback.get(sourceId);
  }

  async delete(sourceId: string): Promise<void> {
    await this.primary.delete(sourceId);
    await this.fallback.delete(sourceId);
  }
}

export function createCredentialProvider(): CredentialProvider {
  return new CompositeCredentialProvider(new KeychainCredentialProvider(), new EncryptedFileCredentialProvider());
}
