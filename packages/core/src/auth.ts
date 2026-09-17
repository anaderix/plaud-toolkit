import { PlaudConfig } from './config.js';
import { BASE_URLS, DEFAULT_USER_AGENT } from './types.js';
import type { PlaudTokenData, PlaudCredentials } from './types.js';

// Small safety margin so we don't start a request with a token about to
// expire mid-flight. There is no auto-refresh, so this must stay short —
// web-app tokens (login --token) are only valid ~24h, whereas OTP tokens
// last ~30 days; a large buffer would wrongly reject the former.
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000; // 60 seconds

// Unattended runs (cron) warn when the token is this close to expiring.
export const TOKEN_EXPIRY_WARNING_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

/**
 * A warning message if the token expires within TOKEN_EXPIRY_WARNING_MS,
 * otherwise undefined. Already-expired tokens are left to getToken() to report.
 */
export function tokenExpiryWarning(expiresAt: number, now = Date.now()): string | undefined {
  const left = expiresAt - now;
  if (left <= 0 || left > TOKEN_EXPIRY_WARNING_MS) return undefined;
  const hours = Math.floor(left / (60 * 60 * 1000));
  const when = hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h`;
  return `Warning: Plaud token expires in ${when} (${new Date(expiresAt).toLocaleString()}). Run \`plaud login\` to refresh.`;
}

export interface PlaudOtpRequest {
  email: string;
  region: 'us' | 'eu';
}

export interface PlaudOtpSession {
  /** Short-lived JWT returned by /auth/otp-send-code, passed back to /auth/otp-login. */
  otpToken: string;
  /**
   * Authoritative API base URL resolved after any -302 region redirect
   * (e.g. 'https://api-apse1.plaud.ai'). May differ from the host implied
   * by the caller's region input.
   */
  apiBase: string;
}

export interface PlaudOtpSubmit {
  email: string;
  code: string;
  otpToken: string;
  /** API base URL resolved by requestLoginCode — pass PlaudOtpSession.apiBase. */
  apiBase: string;
}

/** Best-effort human label for an API host, for display/storage only. */
function regionLabel(apiBase: string): string {
  if (apiBase.includes('euc1')) return 'eu';
  if (apiBase.includes('apse1')) return 'apac';
  if (apiBase === BASE_URLS['us']) return 'us';
  return apiBase;
}

/**
 * Parse a fetch Response as JSON, turning a non-JSON body (e.g. an HTML
 * error/landing page) into a clear error instead of the cryptic
 * "Unexpected token '<', "<!DOCTYPE "... is not valid JSON".
 */
async function parseJsonOrThrow(res: Response, context: string): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.trim().slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(
      `${context}: expected JSON but the server returned a non-JSON response ` +
      `(HTTP ${res.status} ${res.statusText}). This usually means the request reached ` +
      `the wrong host. Response began: ${snippet}`
    );
  }
}

/** Plaud answered and refused the token (as opposed to a network/host failure). */
export class TokenRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenRejectedError';
  }
}

export class PlaudAuth {
  private config: PlaudConfig;

  constructor(config: PlaudConfig) {
    this.config = config;
  }

  async getToken(): Promise<string> {
    const cached = this.config.getToken();
    if (!cached) {
      throw new Error('Not logged in. Run `plaud login` first.');
    }
    if (this.isExpiringSoon(cached)) {
      throw new Error('Token has expired or is expiring soon. Run `plaud login` to refresh.');
    }
    return cached.accessToken;
  }

  /**
   * Step 1 of OTP login: ask Plaud to email a verification code.
   * Returns a short-lived OTP session token plus the resolved region
   * (which may differ from input if Plaud redirects to another regional
   * server via status -302).
   */
  async requestLoginCode(input: PlaudOtpRequest): Promise<PlaudOtpSession> {
    // Start from the host implied by the caller's region, then follow whatever
    // host Plaud redirects us to. Plaud has more regions than us/eu (e.g.
    // api-apse1.plaud.ai), so we trust the server-provided domain rather than
    // mapping it back onto a fixed two-entry table.
    let apiBase = BASE_URLS[input.region] ?? BASE_URLS['us'];

    for (let redirects = 0; redirects <= 2; redirects++) {
      const res = await fetch(`${apiBase}/auth/otp-send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': DEFAULT_USER_AGENT },
        body: JSON.stringify({ username: input.email }),
      });

      const data = await parseJsonOrThrow(res, 'Failed to request login code') as {
        status: number;
        msg?: string;
        token?: string;
        data?: { domains?: { api?: string } };
      };

      if (data.status === -302 && data.data?.domains?.api) {
        apiBase = data.data.domains.api;
        continue;
      }

      if (data.status !== 0 || !data.token) {
        throw new Error(data.msg || `Failed to send verification code (status ${data.status})`);
      }

      return { otpToken: data.token, apiBase };
    }

    throw new Error('Plaud kept redirecting between regions; aborting.');
  }

  /**
   * Step 2 of OTP login: submit the emailed code with the session token,
   * persist email+region+access token on success.
   */
  async submitLoginCode(input: PlaudOtpSubmit): Promise<string> {
    const res = await fetch(`${input.apiBase}/auth/otp-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': DEFAULT_USER_AGENT },
      body: JSON.stringify({ code: input.code, token: input.otpToken }),
    });

    const data = await parseJsonOrThrow(res, 'Verification failed') as {
      status: number;
      msg?: string;
      access_token?: string;
      token_type?: string;
      data?: { access_token?: string };
    };

    const accessToken = data.access_token ?? data.data?.access_token;
    if (!accessToken) {
      throw new Error(data.msg || `Verification failed (status ${data.status})`);
    }

    const decoded = this.decodeJwtExpiry(accessToken);
    const tokenData: PlaudTokenData = {
      accessToken,
      tokenType: data.token_type || 'Bearer',
      issuedAt: decoded.iat * 1000,
      expiresAt: decoded.exp * 1000,
    };

    this.config.saveCredentials({
      email: input.email,
      region: regionLabel(input.apiBase),
      apiBase: input.apiBase,
    });
    this.config.saveToken(tokenData);
    return accessToken;
  }

  /**
   * Save a bearer access token obtained outside the OTP flow — e.g. copied
   * from the Plaud web app (app.plaud.ai). This is the way to reach accounts
   * created via Google/Apple sign-in, which Plaud treats as a separate
   * identity from email-OTP. The correct regional host is discovered by
   * following Plaud's -302 redirect, so the caller needn't know the region.
   */
  async saveAccessToken(accessToken: string): Promise<PlaudCredentials> {
    const payload = this.decodeJwtPayload(accessToken);
    if (!payload.exp) {
      throw new Error('That does not look like a Plaud access token (no expiry claim).');
    }

    const apiBase = await this.resolveApiBase(accessToken);
    const tokenData: PlaudTokenData = {
      accessToken,
      tokenType: 'Bearer',
      issuedAt: (payload.iat ?? 0) * 1000,
      expiresAt: payload.exp * 1000,
    };

    const credentials: PlaudCredentials = {
      email: typeof payload.email === 'string' ? payload.email : '',
      region: regionLabel(apiBase),
      apiBase,
    };
    this.config.saveCredentials(credentials);
    this.config.saveToken(tokenData);
    return credentials;
  }

  /**
   * Verify a token and find which regional host serves its account by
   * hitting /user/me and following any -302 region redirect.
   */
  /**
   * Ask Plaud whether the stored token is still accepted. Throws
   * TokenRejectedError if Plaud refuses it; other errors mean the check
   * itself couldn't be completed (network, wrong host, ...).
   */
  async verifyToken(): Promise<void> {
    await this.resolveApiBase(await this.getToken());
  }

  private async resolveApiBase(accessToken: string): Promise<string> {
    let apiBase = BASE_URLS['us'];
    for (let redirects = 0; redirects <= 2; redirects++) {
      const res = await fetch(`${apiBase}/user/me`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': DEFAULT_USER_AGENT,
          'app-platform': 'web',
          'app-language': 'en',
        },
      });
      const data = await parseJsonOrThrow(res, 'Failed to verify token') as {
        status: number;
        msg?: string;
        data?: { domains?: { api?: string } };
      };
      if (data.status === -302 && data.data?.domains?.api) {
        apiBase = data.data.domains.api;
        continue;
      }
      if (data.status !== 0) {
        throw new TokenRejectedError(data.msg || `Token rejected by Plaud (status ${data.status}). It may be expired.`);
      }
      return apiBase;
    }
    throw new Error('Plaud kept redirecting between regions; aborting.');
  }

  private isExpiringSoon(token: PlaudTokenData): boolean {
    return Date.now() + TOKEN_REFRESH_BUFFER_MS > token.expiresAt;
  }

  private decodeJwtExpiry(jwt: string): { iat: number; exp: number } {
    const payload = this.decodeJwtPayload(jwt);
    return { iat: payload.iat ?? 0, exp: payload.exp ?? 0 };
  }

  private decodeJwtPayload(jwt: string): Record<string, any> {
    const parts = jwt.trim().split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT');
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  }
}
