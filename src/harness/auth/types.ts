import { AuthProvider, AuthSession, OAuthCallbackResult, RuntimeTarget } from "../types";

export interface ProviderExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

export interface AuthProviderPlugin {
  provider: AuthProvider;
  supportsCallbackOAuth: boolean;
  getConfigurationIssues?(): string[];
  buildAuthorizeUrl(args: {
    session: AuthSession;
    callbackUrl: string;
  }): string;
  exchangeCode(args: {
    code: string;
    session: AuthSession;
    callbackUrl: string;
  }): Promise<ProviderExchangeResult>;
  callbackResponseMessage(result: OAuthCallbackResult): string;
}

export interface StartSessionInput {
  provider: AuthProvider;
  runtimeTarget: RuntimeTarget;
}
