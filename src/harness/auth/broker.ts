import crypto from "node:crypto";
import { HarnessStore } from "../db/store";
import {
  AuthProvider,
  AuthSession,
  AuthSessionStartResult,
  OAuthCallbackResult,
  RuntimeTarget,
} from "../types";
import { decrypt, encrypt } from "./crypto";
import { createAuthPlugins } from "./plugins";
import { AuthProviderPlugin } from "./types";

function randomToken(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export class OAuthBroker {
  private readonly store: HarnessStore;
  private readonly callbackBaseUrl: string;
  private readonly secret: string;
  private readonly plugins: Map<AuthProvider, AuthProviderPlugin>;
  private readonly grants = new Map<string, { provider: AuthProvider; token: string; expiresAt: number }>();

  constructor(args: { store: HarnessStore; callbackBaseUrl: string; encryptionSecret: string }) {
    this.store = args.store;
    this.callbackBaseUrl = args.callbackBaseUrl;
    this.secret = args.encryptionSecret;
    this.plugins = new Map(createAuthPlugins().map((plugin) => [plugin.provider, plugin]));
  }

  private plugin(provider: AuthProvider): AuthProviderPlugin {
    const plugin = this.plugins.get(provider);
    if (!plugin) {
      throw new Error(`No OAuth plugin registered for provider ${provider}.`);
    }
    return plugin;
  }

  async startSession(provider: AuthProvider, runtimeTarget: RuntimeTarget): Promise<AuthSessionStartResult> {
    const plugin = this.plugin(provider);
    if (!plugin.supportsCallbackOAuth) {
      throw new Error(`${provider} does not support callback OAuth broker flow.`);
    }
    const configIssues = plugin.getConfigurationIssues?.() || [];
    if (configIssues.length > 0) {
      throw new Error(`OAuth provider ${provider} is not configured: ${configIssues.join(" ")}`);
    }

    const state = randomToken(18);
    const verifier = randomToken(32);
    const challenge = sha256Base64Url(verifier);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const session = this.store.createAuthSession({
      provider,
      runtimeTarget,
      stateToken: state,
      verifier,
      codeChallenge: challenge,
      expiresAt,
    });

    const authorizeUrl = plugin.buildAuthorizeUrl({
      session,
      callbackUrl: this.callbackUrl(provider),
    });

    return {
      sessionId: session.id,
      provider,
      authorizeUrl,
      state,
      expiresAt,
    };
  }

  callbackUrl(provider: AuthProvider): string {
    return `${this.callbackBaseUrl}/api/v1/harness/auth/callback/${provider}`;
  }

  async handleCallback(provider: AuthProvider, query: { code?: string; state?: string; error?: string }): Promise<OAuthCallbackResult> {
    const plugin = this.plugin(provider);
    if (query.error) {
      return { ok: false, provider, message: query.error };
    }
    if (!query.code || !query.state) {
      return { ok: false, provider, message: "Missing OAuth code/state." };
    }

    const session = this.store.getAuthSessionByState(query.state);
    if (!session) {
      return { ok: false, provider, message: "OAuth session not found." };
    }

    if (session.provider !== provider) {
      return { ok: false, provider, message: "Provider mismatch." };
    }

    if (Date.now() > Date.parse(session.expires_at)) {
      this.store.updateAuthSessionStatus(session.id, "failed");
      return { ok: false, provider, message: "OAuth session expired." };
    }

    try {
      const exchanged = await plugin.exchangeCode({
        code: query.code,
        session,
        callbackUrl: this.callbackUrl(provider),
      });

      this.store.upsertAuthToken({
        provider,
        tokenEncrypted: encrypt(this.secret, exchanged.accessToken),
        refreshEncrypted: encrypt(this.secret, exchanged.refreshToken || ""),
        expiresAt: exchanged.expiresAt || null,
      });
      this.store.updateAuthSessionStatus(session.id, "completed");
      this.store.addEvent("oauth_completed", "auth_session", session.id, { provider });
      return { ok: true, provider, message: "OAuth session completed." };
    } catch (error) {
      this.store.updateAuthSessionStatus(session.id, "failed");
      return {
        ok: false,
        provider,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  callbackHtml(provider: AuthProvider, result: OAuthCallbackResult): string {
    const plugin = this.plugin(provider);
    const msg = plugin.callbackResponseMessage(result);
    const color = result.ok ? "#14532d" : "#991b1b";
    return `<!doctype html><html><body style="font-family:sans-serif;padding:24px;color:${color}"><h2>${msg}</h2></body></html>`;
  }

  mintRuntimeGrant(runId: number, provider: AuthProvider): { grantToken: string; expiresAt: string } {
    const row = this.store.getAuthToken(provider);
    if (!row) {
      throw new Error(`No OAuth token stored for ${provider}.`);
    }

    const token = decrypt(this.secret, row.token_encrypted);
    const grantToken = randomToken(24);
    const expiresAtMs = Date.now() + 60_000;
    this.grants.set(grantToken, { provider, token, expiresAt: expiresAtMs });
    this.store.addEvent("runtime_grant_issued", "run", runId, { provider, expiresAtMs });

    return {
      grantToken,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  consumeRuntimeGrant(grantToken: string): { provider: AuthProvider; accessToken: string } {
    const item = this.grants.get(grantToken);
    if (!item) {
      throw new Error("Runtime grant not found.");
    }
    if (Date.now() > item.expiresAt) {
      this.grants.delete(grantToken);
      throw new Error("Runtime grant expired.");
    }
    this.grants.delete(grantToken);
    return {
      provider: item.provider,
      accessToken: item.token,
    };
  }

  getSessionByState(state: string): AuthSession | null {
    return this.store.getAuthSessionByState(state);
  }

  hasStoredToken(provider: AuthProvider): boolean {
    return this.store.getAuthToken(provider) !== null;
  }

  supportsCallback(provider: AuthProvider): boolean {
    return this.plugin(provider).supportsCallbackOAuth;
  }

  callbackConfiguration(provider: AuthProvider): { configured: boolean; issues: string[] } {
    const issues = this.plugin(provider).getConfigurationIssues?.() || [];
    return {
      configured: issues.length === 0,
      issues,
    };
  }

  storeCredential(provider: AuthProvider, secret: string): void {
    this.store.upsertAuthToken({
      provider,
      tokenEncrypted: encrypt(this.secret, secret),
      refreshEncrypted: encrypt(this.secret, ""),
      expiresAt: null,
    });
  }

  clearCredential(provider: AuthProvider): void {
    this.store.deleteAuthToken(provider);
  }

  getAccessToken(provider: AuthProvider): string | null {
    const row = this.store.getAuthToken(provider);
    if (!row) {
      return null;
    }
    return decrypt(this.secret, row.token_encrypted);
  }
}
