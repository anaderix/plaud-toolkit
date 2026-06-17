import { PlaudConfig } from './config.js';
import { BASE_URLS, DEFAULT_USER_AGENT } from './types.js';
import type { PlaudTokenData } from './types.js';

const TOKEN_REFRESH_BUFFER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

  private isExpiringSoon(token: PlaudTokenData): boolean {
    return Date.now() + TOKEN_REFRESH_BUFFER_MS > token.expiresAt;
  }

  private decodeJwtExpiry(jwt: string): { iat: number; exp: number } {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return { iat: payload.iat ?? 0, exp: payload.exp ?? 0 };
  }
}
