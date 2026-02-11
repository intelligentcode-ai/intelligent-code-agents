import { AuthSession, OAuthCallbackResult } from "../types";
import { AuthProviderPlugin, ProviderExchangeResult } from "./types";

class GeminiPlugin implements AuthProviderPlugin {
  provider = "gemini" as const;
  supportsCallbackOAuth = true;

  getConfigurationIssues(): string[] {
    const issues: string[] = [];
    if (!process.env.ICA_GEMINI_OAUTH_CLIENT_ID) {
      issues.push("Missing ICA_GEMINI_OAUTH_CLIENT_ID.");
    }
    if (!process.env.ICA_GEMINI_OAUTH_CLIENT_SECRET) {
      issues.push("Missing ICA_GEMINI_OAUTH_CLIENT_SECRET.");
    }
    if (!process.env.ICA_GEMINI_OAUTH_TOKEN_URL) {
      issues.push("Missing ICA_GEMINI_OAUTH_TOKEN_URL.");
    }
    return issues;
  }

  buildAuthorizeUrl(args: { session: AuthSession; callbackUrl: string }): string {
    const base = process.env.ICA_GEMINI_OAUTH_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
    const clientId = process.env.ICA_GEMINI_OAUTH_CLIENT_ID;
    if (!clientId) {
      throw new Error("Gemini OAuth is not configured: ICA_GEMINI_OAUTH_CLIENT_ID is required.");
    }
    const scope = encodeURIComponent(
      process.env.ICA_GEMINI_OAUTH_SCOPE || "openid email profile https://www.googleapis.com/auth/cloud-platform",
    );

    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: args.callbackUrl,
      response_type: "code",
      scope,
      state: args.session.state_token,
      code_challenge: args.session.code_challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });

    return `${base}?${query.toString()}`;
  }

  async exchangeCode(args: { code: string; session: AuthSession; callbackUrl: string }): Promise<ProviderExchangeResult> {
    const tokenEndpoint = process.env.ICA_GEMINI_OAUTH_TOKEN_URL;
    const clientId = process.env.ICA_GEMINI_OAUTH_CLIENT_ID;
    const clientSecret = process.env.ICA_GEMINI_OAUTH_CLIENT_SECRET;

    if (!tokenEndpoint || !clientId || !clientSecret) {
      throw new Error(
        "Gemini OAuth is not fully configured. Set ICA_GEMINI_OAUTH_CLIENT_ID, ICA_GEMINI_OAUTH_CLIENT_SECRET, and ICA_GEMINI_OAUTH_TOKEN_URL.",
      );
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: args.code,
      code_verifier: args.session.verifier,
      grant_type: "authorization_code",
      redirect_uri: args.callbackUrl,
    });

    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error(`Gemini token exchange failed (${res.status}).`);
    }

    const payload = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const expiresAt = payload.expires_in
      ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
      : undefined;

    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt,
    };
  }

  callbackResponseMessage(result: OAuthCallbackResult): string {
    return result.ok
      ? "Gemini OAuth completed. You can return to the ICA dashboard."
      : `Gemini OAuth failed: ${result.message}`;
  }
}

class StubPlugin implements AuthProviderPlugin {
  provider: "codex" | "claude";
  supportsCallbackOAuth = false;

  constructor(provider: "codex" | "claude") {
    this.provider = provider;
  }

  buildAuthorizeUrl(_args: { session: AuthSession; callbackUrl: string }): string {
    throw new Error(`${this.provider} does not require callback OAuth in this harness implementation.`);
  }

  async exchangeCode(_args: { code: string; session: AuthSession; callbackUrl: string }): Promise<ProviderExchangeResult> {
    throw new Error(`${this.provider} callback exchange is not implemented.`);
  }

  callbackResponseMessage(result: OAuthCallbackResult): string {
    return result.ok
      ? `${this.provider} auth completed.`
      : `${this.provider} auth failed: ${result.message}`;
  }
}

export function createAuthPlugins(): AuthProviderPlugin[] {
  return [new GeminiPlugin(), new StubPlugin("codex"), new StubPlugin("claude")];
}
